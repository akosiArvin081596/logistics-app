"use strict";
// POD and BOL photos shaped at upload, before they are stored (decision 59): each photo of a POD or
// BOL image upload is brought under the page budget, then placed on a US Letter page. Only
// POST /api/documents/upload calls it, and only with POD_UPLOAD_NORMALIZE_ENABLED on; off, that route
// stores what imageToPdf() writes, as before.
//
//   The budget: a photo at or under PAGE_BUDGET_BYTES goes as it came. A bigger one that the whitelist
//     takes (the one way 1 applies, lib/triumph-batch-recompress.js) is decoded once in a child of its
//     own (lib/pod-upload-image-child.js) and written again at the same pixel size, at each of STEPS in
//     turn; the first copy at or under the budget is kept, only when it is smaller and passes the
//     parent's check. Anything else (outside the whitelist, still over at the last step, past a time
//     limit, the queue full, a child error, a copy that fails the check) goes as it came and is
//     flagged on its page record.
//   The page box: each JPEG, its stream unchanged, on a Letter page (landscape for a wide one) at
//     BASE_DPI, or scaled down to fit inside the margins, never enlarged (letterPlacement()).
//
// Nothing is added to any page and nothing else is read: PDFs, receipts, other documents and stored
// files never reach this module.

const path = require("path");
const PDFDocument = require("pdfkit");
const imageLimits = require("./image-size");
const { stripImageMetadata } = require("./image-metadata");
const way1 = require("./triumph-batch-recompress");
const slotsLib = require("./image-child-slots");

// P2, decided on Part A's counts (scripts/pod-upload-shape-look.js): the page budget and the steps.
const PAGE_BUDGET_BYTES = 200 * 1024;
const STEPS = Object.freeze([70, 60, 50]);
// The whole upload's steps, and one photo's child: well inside nginx's 60 s window.
const UPLOAD_BUDGET_MS = 20_000;
const IMAGE_TIMEOUT_MS = 5_000;
// P6: a Letter page, half-inch margins, 150 dpi or more.
const LETTER_PT = Object.freeze([612, 792]);
const MARGIN_PT = 36;
const BASE_DPI = 150;
const IMAGE_CHILD = path.join(__dirname, "pod-upload-image-child.js");
// What the upload card says each page is: ScanKit's page, the photo attached as-is when the scan
// failed, the photo chosen over the scan, or a picture the card never sent to the scan.
const PAGE_SOURCES = Object.freeze(["scanned", "fallback", "original", "not_routed"]);
// Why a page over the budget went as it came.
const LEFT_REASONS = Object.freeze(["whitelist", "floor", "time", "busy", "child", "check"]);

// POD_UPLOAD_NORMALIZE_ENABLED, on only when exactly "true": the budget and the page box at upload.
// Its one reader.
function normalizeEnabled(env = {}) {
	return String((env && env.POD_UPLOAD_NORMALIZE_ENABLED) ?? "").trim() === "true";
}

// POD_UPLOAD_SCAN_ALL_ENABLED, on only when exactly "true": the upload card sends POD and BOL pictures
// added by Upload File, "+" and drag-and-drop through the scan, as it sends the camera's. The server
// only hands it to the card (GET /api/auth/session `features`). Its one reader.
function scanAllEnabled(env = {}) {
	return String((env && env.POD_UPLOAD_SCAN_ALL_ENABLED) ?? "").trim() === "true";
}

// POD and BOL, in any case: a Super Admin's type is stored as sent.
function shapedType(docType) {
	const t = typeof docType === "string" ? docType.trim().toUpperCase() : "";
	return t === "POD" || t === "BOL" ? t : null;
}

// The card's page sources, one per photo in order; anything else (none sent, an old client, a list
// of another length or with another word) is unknown.
function pageSourcesOf(raw, pages) {
	const ok = Array.isArray(raw) && raw.length === pages && raw.every((s) => PAGE_SOURCES.includes(s));
	return ok ? { known: true, list: raw.slice() } : { known: false, list: [] };
}

const left = (reason) => ({ take: false, reason });

// May this JPEG be re-compressed? The rules way 1 applies to a photo's stream, read from the bytes as
// uploaded: one baseline frame (SOF0) of 8 bits, with 1 component (grey) or 3 (no R, G, B component
// IDs, and no Adobe segment with transform 0, or one too short to read, anywhere before the end
// marker); 0.5 to 25 megapixels; lib/image-metadata.js can walk it to its end; EXIF orientation 1
// or none. Answers { take: true, width, height, stripped } or { take: false, reason }.
function jpegVerdict(buf) {
	if (!Buffer.isBuffer(buf)) return left("frame");
	const head = way1.jpegWalk(buf);
	const frame = head && head.frames.length === 1 ? head.frames[0] : null;
	if (!frame || frame.marker !== 0xc0 || frame.precision !== 8) return left("frame");
	const n = frame.ids.length;
	if (n !== 1 && n !== 3) return left("components");
	if (n === 3 && frame.ids[0] === 0x52 && frame.ids[1] === 0x47 && frame.ids[2] === 0x42) return left("rgb_ids");
	const pixels = frame.width * frame.height;
	if (pixels < way1.MIN_PIXELS || pixels > way1.MAX_PIXELS) return left("pixels");
	const strip = stripImageMetadata(buf);
	if (!strip.ok || strip.type !== "jpeg") return left("unwalkable");
	if (strip.orientation !== 1) return left("orientation");
	if (n === 3) {
		const whole = way1.jpegWalk(strip.buf, { toEnd: true });
		if (!whole || whole.adobe.some((t) => t === 0 || t === null)) return left("adobe");
	}
	return { take: true, width: frame.width, height: frame.height, stripped: strip.buf };
}

// Where a photo of width x height pixels (as stored; EXIF orientation 5 to 8 turns it) sits on its
// page: s = min(72 / BASE_DPI, boxW / w, boxH / h) points per pixel, w x h its size as drawn and the
// box the page inside the margins, so it is drawn at BASE_DPI or, scaled down to fit, at more. A
// wider-than-tall photo gets a landscape page. Centred. Pass `scale`, never `fit`.
function letterPlacement(width, height, orientation = 1) {
	const turned = orientation >= 5 && orientation <= 8;
	const w = turned ? height : width;
	const h = turned ? width : height;
	const landscape = w > h;
	const [pageW, pageH] = landscape ? [LETTER_PT[1], LETTER_PT[0]] : [LETTER_PT[0], LETTER_PT[1]];
	const scale = Math.min(72 / BASE_DPI, (pageW - 2 * MARGIN_PT) / w, (pageH - 2 * MARGIN_PT) / h);
	const drawnW = w * scale;
	const drawnH = h * scale;
	return {
		size: [pageW, pageH],
		layout: landscape ? "landscape" : "portrait",
		scale,
		dpi: 72 / scale,
		drawnW,
		drawnH,
		x: (pageW - drawnW) / 2,
		y: (pageH - drawnH) / 2,
	};
}

// The JPEGs as one PDF, one Letter page each, every stream embedded as it is. JPEG only, within the
// document photo limits, checked before pdfkit sees any of them (as imageToPdf() checks). `info`
// (pdfkit's) only for a fixed creation date in the runners.
function letterPdf(imageBuffers, { info = null } = {}) {
	const buffers = Array.isArray(imageBuffers) ? imageBuffers : [imageBuffers];
	return new Promise((resolve, reject) => {
		for (const buf of buffers) {
			const verdict = imageLimits.checkImage(buf, imageLimits.LIMITS.DOCUMENT_PHOTO);
			if (!verdict.ok) return reject(imageLimits.refusalError(verdict, "photo"));
		}
		const doc = new PDFDocument({ autoFirstPage: false, ...(info ? { info } : {}) });
		const chunks = [];
		doc.on("data", (chunk) => chunks.push(chunk));
		doc.on("end", () => resolve(Buffer.concat(chunks)));
		doc.on("error", reject);
		for (const buf of buffers) {
			const img = doc.openImage(buf);
			const at = letterPlacement(img.width, img.height, img.orientation);
			doc.addPage({ size: at.size });
			doc.image(img, at.x, at.y, { scale: at.scale });
		}
		doc.end();
	});
}

const asBuffer = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);

// One child, one photo. Resolves { jpeg, quality }, { over: true } or { error }, settles once, and
// the child never outlives it (way 1's runChild(), with steps and a budget).
function runChild(childPath, timeoutMs, message) {
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
		timer = setTimeout(() => finish({ error: `timed out after ${timeoutMs} ms`, timedOut: true }), timeoutMs);
		child.on("message", (msg) => {
			const jpeg = msg && asBuffer(msg.jpeg);
			if (jpeg) return finish({ jpeg, quality: Number(msg.quality) });
			if (msg && msg.over === true) return finish({ over: true });
			finish({ error: `failed: ${String((msg && msg.error) || "no result").slice(0, 200)}` });
		});
		child.on("close", (code, signal) => finish({ error: `process exited (${signal || `code ${code}`})` }));
		try {
			child.send(message, (err) => { if (err) finish({ error: String(err.message || err).slice(0, 200) }); });
		} catch (err) {
			finish({ error: String((err && err.message) || err).slice(0, 200) });
		}
	});
}

// encode(image, { steps, budget, until, timeoutMs, live }) -> { jpeg, quality } | { over } | { error }
// | { busy } | { timeUp }, never a rejection. Each child holds an upload slot (lib/image-child-slots.js)
// for as long as it runs; a job that gets none in time, or whose upload has answered, never starts.
function createEncoder({ slots, childPath = IMAGE_CHILD, now = Date.now } = {}) {
	if (!slots || typeof slots.take !== "function") throw new Error("pod upload shape: slots are required");
	return async (image, { steps, budget, until, timeoutMs, live } = {}) => {
		const release = await slots.take({ until, live });
		if (release === slotsLib.BUSY) return { busy: true };
		if (typeof release !== "function") return { timeUp: true };
		try {
			const wait = Math.min(timeoutMs, until - now());
			if (!(wait > 0)) return { timeUp: true };
			const answer = await runChild(childPath, wait, { image, steps: [...steps], budget });
			return answer.timedOut ? { timeUp: true } : answer;
		} finally {
			release();
		}
	};
}

// The row's counts for one shaped upload, and the reasons pages went as they came.
function countsOf(buffers, pages, rawSources) {
	const sources = pageSourcesOf(rawSources, buffers.length);
	const reasons = {};
	for (const p of pages) if (p.outcome === "large") reasons[p.reason] = (reasons[p.reason] || 0) + 1;
	return {
		pages: buffers.length,
		sources: sources.known ? sources.list.join(",") : "unknown",
		scanned: sources.known ? sources.list.filter((s) => s === "scanned").length : null,
		notScanned: sources.known ? sources.list.filter((s) => s !== "scanned").length : null,
		recompressed: pages.filter((p) => p.outcome === "recompressed").length,
		bytesBefore: buffers.reduce((n, b) => n + b.length, 0),
		bytesAfter: pages.reduce((n, p) => n + p.bytes.length, 0),
		leftLarge: pages.filter((p) => p.outcome === "large").length,
		reasons,
	};
}

// One audit row's words for a shaped upload: counts and fixed words only.
function auditText(docType, counts) {
	const c = counts || {};
	const n = (v, word) => `${v} ${word}${v === 1 ? "" : "s"}`;
	const why = Object.keys(c.reasons || {}).sort().map((r) => `${r} ${c.reasons[r]}`).join(", ");
	const kept = c.leftLarge ? `; ${c.leftLarge} left as ${c.leftLarge === 1 ? "it" : "they"} came over the budget (${why})` : "";
	const scan = c.notScanned === null || c.notScanned === undefined ? "page sources unknown" : `${c.notScanned} not scanned`;
	return `${shapedType(docType) || "DOC"}: ${n(c.pages, "page")}; ${c.recompressed} re-compressed, ${c.bytesBefore} → ${c.bytesAfter} bytes${kept}; ${scan}`;
}

// shape(buffers, { sources }) -> { pdf, pages, counts }: the steps, then the page box, inside one
// upload's time budget; shapePages() is the steps alone (Part A measures with it).
function createShaper({ encode, now = Date.now, budgetMs = UPLOAD_BUDGET_MS, imageTimeoutMs = IMAGE_TIMEOUT_MS, pageBudget = PAGE_BUDGET_BYTES, steps = STEPS, info = null } = {}) {
	if (typeof encode !== "function") throw new Error("pod upload shape: encode is required");

	async function shapePages(buffers) {
		const list = Array.isArray(buffers) ? buffers : [buffers];
		const deadline = now() + budgetMs;
		const ticket = { done: false };
		const live = () => !ticket.done && now() < deadline;
		const large = (buf, reason, detail) => ({ bytes: buf, outcome: "large", reason, ...(detail ? { detail } : {}) });

		// One photo at a time: a page waits for the one before it.
		async function onePage(buf) {
			if (buf.length <= pageBudget) return { bytes: buf, outcome: "within" };
			const remaining = deadline - now();
			if (remaining <= 0) return large(buf, "time");
			const v = jpegVerdict(buf);
			if (!v.take) return large(buf, "whitelist", v.reason);
			let r = null;
			try {
				r = await encode(v.stripped, { steps, budget: pageBudget, until: deadline, timeoutMs: Math.min(imageTimeoutMs, remaining), live });
			} catch {
				r = null;
			}
			if (!r || r.error) return large(buf, "child");
			if (r.busy) return large(buf, "busy");
			if (r.timeUp) return large(buf, "time");
			if (r.over) return large(buf, "floor");
			const jpeg = asBuffer(r.jpeg);
			if (!jpeg || jpeg.length > pageBudget || jpeg.length >= buf.length || !way1.newJpegOk(jpeg, v.width, v.height)) return large(buf, "check");
			return { bytes: jpeg, outcome: "recompressed", quality: Number(r.quality) };
		}

		const pages = [];
		try {
			for (const buf of list) pages.push(await onePage(buf));
		} finally {
			ticket.done = true;
		}
		return { list, pages };
	}

	async function shape(buffers, { sources } = {}) {
		const { list, pages } = await shapePages(buffers);
		const pdf = await letterPdf(pages.map((p) => p.bytes), { info });
		return {
			pdf,
			pages: pages.map(({ bytes, ...rest }) => ({ ...rest, bytes: bytes.length })),
			counts: countsOf(list, pages, sources),
		};
	}

	return Object.freeze({ shape, shapePages });
}

module.exports = {
	PAGE_BUDGET_BYTES,
	STEPS,
	UPLOAD_BUDGET_MS,
	IMAGE_TIMEOUT_MS,
	LETTER_PT,
	MARGIN_PT,
	BASE_DPI,
	IMAGE_CHILD,
	PAGE_SOURCES,
	LEFT_REASONS,
	normalizeEnabled,
	scanAllEnabled,
	shapedType,
	pageSourcesOf,
	jpegVerdict,
	letterPlacement,
	letterPdf,
	runChild,
	createEncoder,
	countsOf,
	auditText,
	createShaper,
};
