// Way 1 for a Triumph batch over its size limit: the JPEG photos on its BOL and POD pages are
// re-compressed at the same pixel size, at quality 70, then 60, then 50 (the floor), each step from
// the photos' own original bytes, and the first step whose merged batch fits is used. Only a
// whitelisted photo is touched (imageVerdict()), a new stream is kept only when it is smaller, and
// nothing else changes: the invoice, the rate con, lumper, scale and pallet documents, every other
// image, every text and drawing, and the documents as stored. The steps are one constant (STEPS),
// so a step whose side-by-side pairs fail is dropped in one place.
//
// lib/triumph-batch.js buildBatch() calls create().fit() only with its option exactly true
// (lib/triumph-rules.js batchRecompressEnabled()), and only once its merge would stop at
// BATCH_TOO_LARGE. Each decode and encode runs in a child of its own (lib/triumph-image-child.js),
// one image at a time, killed at its deadline, and the parent checks each new JPEG before using it.
// It opens no database, file or connection: PDF bytes in, PDF bytes and counts out.

"use strict";

const path = require("path");
const crypto = require("crypto");
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, PDFStream, PDFRawStream } = require("pdf-lib");
const rules = require("./triumph-rules");
const { stripImageMetadata } = require("./image-metadata");

const STEPS = Object.freeze([70, 60, 50]);
const MAX_IMAGES = 40;
const MIN_PIXELS = 500_000;
// The receipt decode's own bound (lib/receipt-images.js RECEIPT_IMAGE_MAX_PIXELS).
const MAX_PIXELS = 25_000_000;
const IMAGE_TIMEOUT_MS = 20_000;
// Well inside the attempt's 15-minute lease (lib/triumph-job.js LEASE_MS).
const BATCH_BUDGET_MS = 5 * 60 * 1000;
const IMAGE_CHILD = path.join(__dirname, "triumph-image-child.js");
const TOUCHED_KINDS = new Set(["bol", "pod"]);
// The batch's own save (lib/triumph-batch.js SAVE_OPTIONS), so a part reads back as it merges.
const SAVE_OPTIONS = Object.freeze({ useObjectStreams: false, updateFieldAppearances: false });

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const NAME = (s) => PDFName.of(s);
const numberOf = (v) => (v instanceof PDFNumber ? v.asNumber() : NaN);
const LEFT = Object.freeze({ take: false });

// A JPEG's marker segments in one walk from its start: by default to its first scan, which holds
// every frame header a decoder reads first; with `toEnd`, on to its end marker, the entropy-coded
// data skipped as lib/image-metadata.js skips it, since a viewer reads an Adobe segment wherever it
// sits. { frames, adobe } (each Adobe segment's transform, or null when it is too short to hold
// one), or null when the walk breaks.
function jpegWalk(buf, { toEnd = false } = {}) {
	if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	const frames = [];
	const adobe = [];
	let sawScan = false;
	let i = 2;
	while (i < buf.length) {
		if (buf[i] !== 0xff) return null;
		while (i < buf.length && buf[i] === 0xff) i++;
		if (i >= buf.length) return null;
		const marker = buf[i];
		i++;
		if (marker === 0xd9) return toEnd ? { frames, adobe } : null;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (marker === 0x00 || marker === 0xd8) return null;
		if (i + 2 > buf.length) return null;
		const len = buf.readUInt16BE(i);
		if (len < 2 || i + len > buf.length) return null;
		const body = buf.subarray(i + 2, i + len);
		// SOF0-SOF15, but for DHT (C4), JPG (C8) and DAC (CC), which share the range.
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			const n = body.length >= 6 ? body[5] : -1;
			if (n < 1 || body.length < 6 + 3 * n) return null;
			frames.push({ marker, precision: body[0], height: body.readUInt16BE(1), width: body.readUInt16BE(3), ids: Array.from({ length: n }, (_, k) => body[6 + 3 * k]) });
		} else if (marker === 0xee && body.length >= 5 && body.toString("latin1", 0, 5) === "Adobe") {
			adobe.push(body.length >= 12 ? body[11] : null);
		}
		i += len;
		if (marker !== 0xda) continue;
		if (!toEnd) return { frames, adobe };
		sawScan = true;
		// The scan's data runs to the next marker that is not a stuffed zero, a restart or a fill byte.
		while (i < buf.length) {
			if (buf[i] !== 0xff) { i++; continue; }
			const next = buf[i + 1];
			if (next === undefined) { i = buf.length; break; }
			if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { i += 2; continue; }
			if (next === 0xff) { i++; continue; }
			break;
		}
	}
	// No end marker after a scan: data cut short, which lib/image-metadata.js keeps as it is too.
	return toEnd && sawScan ? { frames, adobe } : null;
}

// "rgb", "gray" or "icc3" for the colour spaces a photo may have, or null.
function colourSpace(v) {
	if (v === NAME("DeviceRGB")) return "rgb";
	if (v === NAME("DeviceGray")) return "gray";
	if (v instanceof PDFArray && v.size() === 2 && v.lookup(0) === NAME("ICCBased")) {
		const profile = v.lookup(1);
		if (profile instanceof PDFStream && numberOf(profile.dict.lookup(NAME("N"))) === 3) return "icc3";
	}
	return null;
}

// May this image be re-compressed? Only when every rule holds:
//   its dictionary: /Subtype /Image, /Filter /DCTDecode alone, /BitsPerComponent 8, /DeviceRGB,
//     /DeviceGray or ICCBased /N 3, and none of /Decode, /DecodeParms, /SMask, /Mask, /ImageMask;
//   its JPEG, read before decoding: one baseline frame (SOF0) of 8 bits whose size is the
//     dictionary's, with 3 components for a colour space of three and 1 for grey; on 3, no R, G, B
//     component IDs and no Adobe segment with transform 0 (or one too short to read) anywhere
//     before its end marker, the two signals a viewer reads as RGB and the decoder would read as
//     YCbCr;
//   lib/image-metadata.js can walk it to its end, and its EXIF orientation is 1 or absent;
//   0.5 to 25 megapixels.
// Answers { take: true, gray, width, height, raw, stripped }, `stripped` being the bytes the child
// decodes (no EXIF), or { take: false }.
function imageVerdict(stream) {
	if (!(stream instanceof PDFRawStream)) return LEFT;
	const dict = stream.dict;
	const get = (k) => dict.lookup(NAME(k));
	if (get("Subtype") !== NAME("Image")) return LEFT;
	const filter = get("Filter");
	const dct = filter === NAME("DCTDecode") || (filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === NAME("DCTDecode"));
	if (!dct || numberOf(get("BitsPerComponent")) !== 8) return LEFT;
	if (["Decode", "DecodeParms", "SMask", "Mask", "ImageMask"].some((k) => dict.has(NAME(k)))) return LEFT;
	const space = colourSpace(get("ColorSpace"));
	if (!space) return LEFT;
	const width = numberOf(get("Width"));
	const height = numberOf(get("Height"));
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return LEFT;
	if (width * height < MIN_PIXELS || width * height > MAX_PIXELS) return LEFT;
	const raw = Buffer.from(stream.getContents());
	const head = jpegWalk(raw);
	const frame = head && head.frames.length === 1 ? head.frames[0] : null;
	if (!frame || frame.marker !== 0xc0 || frame.precision !== 8 || frame.width !== width || frame.height !== height) return LEFT;
	if (frame.ids.length !== (space === "gray" ? 1 : 3)) return LEFT;
	if (frame.ids.length === 3 && frame.ids[0] === 0x52 && frame.ids[1] === 0x47 && frame.ids[2] === 0x42) return LEFT;
	const strip = stripImageMetadata(raw);
	if (!strip.ok || strip.type !== "jpeg" || strip.orientation !== 1) return LEFT;
	// The stripped bytes keep every Adobe segment, and the strip has walked them to the end marker.
	if (frame.ids.length === 3) {
		const whole = jpegWalk(strip.buf, { toEnd: true });
		if (!whole || whole.adobe.some((t) => t === 0 || t === null)) return LEFT;
	}
	return { take: true, gray: space === "gray", width, height, raw, stripped: strip.buf };
}

// The image XObjects each page draws from its resources (inherited ones included), each once, in
// page order. An image reached only through a form XObject or an annotation is not among them.
function pageImages(doc) {
	const out = [];
	const seen = new Set();
	for (const page of doc.getPages()) {
		const res = page.node.Resources();
		const xo = res instanceof PDFDict ? res.lookup(NAME("XObject")) : null;
		if (!(xo instanceof PDFDict)) continue;
		for (const [, v] of xo.entries()) {
			if (!(v instanceof PDFRef) || seen.has(v.toString())) continue;
			const s = doc.context.lookup(v);
			if (!(s instanceof PDFStream) || s.dict.lookup(NAME("Subtype")) !== NAME("Image")) continue;
			seen.add(v.toString());
			out.push({ ref: v, stream: s });
		}
	}
	return out;
}

// One part's page images and the photos among them that the whitelist takes.
async function survey(buffer) {
	let doc;
	try {
		doc = await PDFDocument.load(buffer, { updateMetadata: false });
	} catch {
		return { images: 0, photos: [] };
	}
	const found = pageImages(doc);
	const photos = [];
	for (const im of found) {
		const v = imageVerdict(im.stream);
		if (v.take) photos.push({ key: im.ref.toString(), ...v });
	}
	return { images: found.length, photos };
}

// The parent's check of a new JPEG before it is used: one baseline frame of 3 components (a grey
// photo's copy too, which goes under /DeviceRGB), the dictionary's width and height, and an
// end-of-image marker at its end.
function newJpegOk(jpeg, width, height) {
	const head = jpegWalk(jpeg);
	const frame = head && head.frames.length === 1 ? head.frames[0] : null;
	return Boolean(frame) && frame.marker === 0xc0 && frame.ids.length === 3 && frame.width === width && frame.height === height
		&& jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
}

// One part at one step: each photo re-compressed at `quality` from its original bytes, and replaced
// once, under its own reference, only when the child's copy passes the parent's check and is
// smaller. { changed: false } when nothing was; { timeUp: true } past the batch's budget.
async function recompressPart(buffer, plan, quality, encode, timeLeft) {
	let doc;
	try {
		doc = await PDFDocument.load(buffer, { updateMetadata: false });
	} catch {
		return { changed: false };
	}
	const byKey = new Map(pageImages(doc).map((im) => [im.ref.toString(), im]));
	let images = 0;
	for (const photo of plan.photos) {
		if (!timeLeft()) return { timeUp: true };
		const im = byKey.get(photo.key);
		if (!im) continue;
		let answer = null;
		try {
			answer = await encode(photo.stripped, quality);
		} catch {
			answer = null;
		}
		const jpeg = answer && Buffer.isBuffer(answer.jpeg) ? answer.jpeg : null;
		if (!jpeg || jpeg.length >= photo.raw.length || !newJpegOk(jpeg, photo.width, photo.height)) continue;
		const dict = im.stream.dict.clone(doc.context);
		if (photo.gray) dict.set(NAME("ColorSpace"), NAME("DeviceRGB"));
		doc.context.assign(im.ref, PDFRawStream.of(dict, jpeg));
		images++;
	}
	if (!images) return { changed: false };
	try {
		return { changed: true, buffer: Buffer.from(await doc.save(SAVE_OPTIONS)), images, left: plan.images - images };
	} catch {
		return { changed: false };
	}
}

// One child at a time across this process: each call waits for the one before it.
let tail = Promise.resolve();
function oneAtATime(job) {
	const run = tail.then(job, job);
	tail = run.then(() => {}, () => {});
	return run;
}

const asBuffer = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);

// One decode and encode in its own process. Resolves { jpeg } or { error }, settles once, and the
// child never outlives it (lib/receipt-images.js runChild(), with no resize step and no size cap).
function runChild(childPath, timeoutMs, image, quality) {
	const { fork } = require("child_process");
	return new Promise((resolve) => {
		let child = null;
		let timer = null;
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (child && typeof child.pid === "number" && child.exitCode === null && child.signalCode === null) {
				try { child.kill("SIGKILL"); } catch { /* already gone */ }
			}
			resolve(result);
		};
		try {
			child = fork(childPath, [], {
				cwd: path.join(__dirname, ".."),
				env: {},
				execArgv: [],
				serialization: "advanced",
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
		} catch (err) {
			finish({ error: String((err && err.message) || err).slice(0, 200) });
			return;
		}
		// First: a child that could not start reports it here, and an 'error' nobody listens for
		// would end the server.
		child.on("error", (err) => finish({ error: String((err && err.message) || err).slice(0, 200) }));
		timer = setTimeout(() => finish({ error: `timed out after ${timeoutMs} ms` }), timeoutMs);
		child.on("message", (msg) => {
			const jpeg = msg && asBuffer(msg.jpeg);
			finish(jpeg ? { jpeg } : { error: `failed: ${String((msg && msg.error) || "no result").slice(0, 200)}` });
		});
		child.on("close", (code, signal) => finish({ error: `process exited (${signal || `code ${code}`})` }));
		try {
			child.send({ image, quality }, (err) => { if (err) finish({ error: String(err.message || err).slice(0, 200) }); });
		} catch (err) {
			finish({ error: String((err && err.message) || err).slice(0, 200) });
		}
	});
}

// encode(image, quality) -> Promise<{ jpeg } | { error }>, never a rejection.
function createEncoder({ childPath = IMAGE_CHILD, timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
	return (image, quality) => oneAtATime(() => runChild(childPath, timeoutMs, image, quality));
}

// fit(parts, { csvBytes, maxBytes, tooBig, merge }): `parts` are the batch's parts in order, as
// buildBatch() merges them ({ kind, buffer }); `tooBig` their merge's size refusal; `merge` the
// batch's own mergeParts(). Answers:
//   { merged, records }  the first step that fits: its merge, and per part its record or null
//                        ({ quality, images, left, bytesBefore, bytesAfter, sourceSha256 });
//   { floor }            still over at the last step: the size refusal and the touched parts' records
//                        of the latest step that kept a copy, or the batch's own and none when no
//                        step kept one;
//   { skipped }          no step tried, or the steps stopped, so the batch stops as today:
//                        UNREACHABLE (over by at least the photos' bytes), TOO_MANY (more photos than
//                        MAX_IMAGES), OUT_OF_TIME (the batch's budget), MERGE_FAILED (a step's merge).
function create({ encode = null, steps = STEPS, maxImages = MAX_IMAGES, budgetMs = BATCH_BUDGET_MS, now = Date.now } = {}) {
	const toEncode = encode || createEncoder();
	async function fit(parts, { csvBytes, maxBytes, tooBig, merge }) {
		const deadline = now() + budgetMs;
		const timeLeft = () => now() <= deadline;
		const plans = [];
		for (const part of parts) plans.push(TOUCHED_KINDS.has(part.kind) ? await survey(part.buffer) : null);
		const photos = plans.reduce((n, p) => n + (p ? p.photos.length : 0), 0);
		const photoBytes = plans.reduce((n, p) => n + (p ? p.photos.reduce((s, x) => s + x.raw.length, 0) : 0), 0);
		// Even with every photo's stream gone the batch would be over: no step can fit.
		if (tooBig.pdfBytes + tooBig.csvBytes - tooBig.maxBytes >= photoBytes) return { skipped: "UNREACHABLE" };
		if (photos > maxImages) return { skipped: "TOO_MANY" };
		// The latest step that kept a copy: a step that keeps none (every copy bigger, or its child
		// failing) leaves it as it was.
		let last = null;
		for (const quality of steps) {
			const list = parts.map((p) => ({ kind: p.kind, buffer: p.buffer }));
			const records = parts.map(() => null);
			for (let i = 0; i < parts.length; i++) {
				if (!plans[i] || !plans[i].photos.length) continue;
				const r = await recompressPart(parts[i].buffer, plans[i], quality, toEncode, timeLeft);
				if (r.timeUp) return { skipped: "OUT_OF_TIME" };
				if (!r.changed) continue;
				list[i] = { kind: parts[i].kind, buffer: r.buffer };
				records[i] = { quality, images: r.images, left: r.left, bytesBefore: parts[i].buffer.length, bytesAfter: r.buffer.length, sourceSha256: sha256(parts[i].buffer) };
			}
			if (!records.some(Boolean)) continue;
			let merged;
			try {
				merged = await merge(list);
			} catch {
				merged = null;
			}
			if (!merged || !merged.ok) return { skipped: "MERGE_FAILED" };
			const refusal = rules.sizeRefusal(merged.pdf.length, csvBytes, maxBytes);
			if (!refusal) return { merged, records };
			last = { refusal, records };
		}
		if (!last) return { floor: { refusal: tooBig, recompressed: [] } };
		return { floor: { refusal: last.refusal, recompressed: last.records.map((r, i) => (r ? { kind: parts[i].kind, ...r } : null)).filter(Boolean) } };
	}
	return Object.freeze({ fit });
}

module.exports = {
	STEPS,
	MAX_IMAGES,
	MIN_PIXELS,
	MAX_PIXELS,
	IMAGE_TIMEOUT_MS,
	BATCH_BUDGET_MS,
	TOUCHED_KINDS,
	jpegWalk,
	imageVerdict,
	pageImages,
	survey,
	newJpegOk,
	createEncoder,
	create,
};
