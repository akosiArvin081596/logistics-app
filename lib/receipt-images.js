"use strict";
// Receipt images for the weekly invoice's receipt pages (Personal receipts, v1).
//
// A stored receipt is never embedded as it was uploaded: it is decoded and
// written again as a JPEG, at most RECEIPT_IMAGE_MAX_EDGE px on its long edge and
// RECEIPT_IMAGE_MAX_BYTES, with no EXIF, GPS, XMP, ICC profile or text chunk
// (lib/receipt-image-child.js). The decode runs in a child process, one at a
// time, killed at a deadline, so a hostile or huge image can never stall or end
// the server; its header is read first (checkImage()) and an image over
// RECEIPT_IMAGE_MAX_PIXELS never reaches a child.
//
// The output is cached under cacheDir, which must not sit under an uploads
// folder (the /uploads static mount would serve it). A file's name carries the
// cache version, the expense id and a hash of the stored receipt reference, so
// a changed receipt or a new version never reads an old file.
//
// prepare() always resolves, never rejects:
//   { status: "image", dataUri, cached }      a JPEG data URI ready for a page
//   { status: "pdf" }                         a PDF receipt: listed, never rendered
//   { status: "unavailable", reason, ready? } missing, unreadable, refused, busy,
//                                             or still preparing past `waitMs`
//                                             (then `ready` settles with the result)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const imageLimits = require("./image-size");
const { safeReceiptImage, RECEIPT_IMAGE_MAX_BYTES } = require("./invoice-receipts");

const RECEIPT_IMAGE_CACHE_VERSION = "v1";
const RECEIPT_IMAGE_MAX_EDGE = 1600;
const RECEIPT_IMAGE_MAX_PIXELS = 25_000_000;          // the receipt OCR's decode bound
const RECEIPT_IMAGE_SOURCE_MAX_BYTES = 10 * 1024 * 1024; // the receipt OCR's read bound
const RECEIPT_IMAGE_SOURCE_DATA_URI_MAX_LENGTH = Math.ceil(RECEIPT_IMAGE_SOURCE_MAX_BYTES / 3) * 4 + 64;
const RECEIPT_IMAGE_TIMEOUT_MS = 20_000;
const RECEIPT_IMAGE_QUEUE_CAP = 20;
const RECEIPT_IMAGE_CHILD = path.join(__dirname, "receipt-image-child.js");
const RECEIPTS_URL_PREFIX = "/uploads/expense-receipts/";
const DECODABLE = Object.freeze({ types: Object.freeze([imageLimits.JPEG, imageLimits.PNG]), maxPixels: RECEIPT_IMAGE_MAX_PIXELS });

const asBuffer = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : null);
const unavailable = (reason) => ({ status: "unavailable", reason });

function receiptImageCacheName(expenseId, photoData, version = RECEIPT_IMAGE_CACHE_VERSION) {
	const hash = crypto.createHash("sha256").update(String(photoData || "")).digest("hex").slice(0, 16);
	return `${version}-${Number(expenseId)}-${hash}.jpg`;
}

// What a stored receipt is, for a listing, without reading it: "pdf", "image" (a
// JPEG or PNG the re-encode can take, on disk or inline) or "none" (no receipt,
// a missing file, a WebP or anything else). The receipt route still re-encodes
// and checks the bytes; a file this calls "image" that cannot be read answers 404.
function receiptImageKind(photoData, receiptsDir) {
	const p = String(photoData || "");
	if (!p) return "none";
	if (/^data:application\/pdf[;,]/i.test(p)) return "pdf";
	if (/^data:image\/(?:jpeg|jpg|png);base64,/i.test(p)) return "image";
	if (!p.startsWith(RECEIPTS_URL_PREFIX) || !receiptsDir) return "none";
	const dir = path.resolve(String(receiptsDir));
	const abs = path.join(dir, path.basename(p));
	if (!abs.startsWith(dir + path.sep) || !fs.existsSync(abs)) return "none";
	if (/\.pdf$/i.test(abs)) return "pdf";
	return /\.(?:jpe?g|png)$/i.test(abs) ? "image" : "none";
}

function underUploads(dir) {
	return path.resolve(dir).split(path.sep).some((part) => part.toLowerCase() === "uploads");
}

function createReceiptImageService(options = {}) {
	const receiptsDir = path.resolve(String(options.receiptsDir || ""));
	const cacheDir = path.resolve(String(options.cacheDir || ""));
	if (!options.receiptsDir || !options.cacheDir) throw new Error("receipt images: receiptsDir and cacheDir are required");
	if (underUploads(cacheDir)) throw new Error("receipt images: the cache must not sit under an uploads folder");
	const childPath = options.childPath || RECEIPT_IMAGE_CHILD;
	const timeoutMs = options.timeoutMs > 0 ? options.timeoutMs : RECEIPT_IMAGE_TIMEOUT_MS;
	const queueCap = Number.isInteger(options.queueCap) && options.queueCap >= 0 ? options.queueCap : RECEIPT_IMAGE_QUEUE_CAP;
	const version = options.version || RECEIPT_IMAGE_CACHE_VERSION;
	const log = typeof options.log === "function" ? options.log : () => {};
	const outputLimits = Object.freeze({ types: Object.freeze([imageLimits.JPEG]), maxPixels: RECEIPT_IMAGE_MAX_EDGE * RECEIPT_IMAGE_MAX_EDGE, maxBytes: RECEIPT_IMAGE_MAX_BYTES });

	const waiting = [];
	const inflight = new Map();
	const counters = { forks: 0, running: 0, maxRunning: 0 };

	// The stored receipt's bytes, or why there are none. photo_data is a path
	// under /uploads/expense-receipts/ or, on old rows, an inline data URI.
	async function readSource(photoData) {
		const p = String(photoData || "");
		if (!p) return unavailable("no receipt");
		if (p.startsWith("data:")) {
			if (/^data:application\/pdf[;,]/i.test(p)) return { status: "pdf" };
			const m = /^data:image\/(?:jpeg|jpg|png);base64,/i.exec(p);
			if (!m) return unavailable("type");
			if (p.length > RECEIPT_IMAGE_SOURCE_DATA_URI_MAX_LENGTH) return unavailable("too large");
			return { buf: Buffer.from(p.slice(m[0].length), "base64") };
		}
		if (!p.startsWith(RECEIPTS_URL_PREFIX)) return unavailable("not a stored receipt");
		const abs = path.join(receiptsDir, path.basename(p));
		if (!abs.startsWith(receiptsDir + path.sep)) return unavailable("not a stored receipt");
		let st;
		try { st = await fs.promises.stat(abs); } catch { return unavailable("missing"); }
		if (!st.isFile()) return unavailable("missing");
		if (st.size > RECEIPT_IMAGE_SOURCE_MAX_BYTES) return unavailable("too large");
		let buf;
		try { buf = await fs.promises.readFile(abs); } catch { return unavailable("missing"); }
		if (imageLimits.servedType(buf, { pdf: true }) === "application/pdf") return { status: "pdf" };
		return { buf };
	}

	async function readCache(file) {
		let buf;
		try { buf = await fs.promises.readFile(file); } catch { return null; }
		if (!imageLimits.checkImage(buf, outputLimits).ok) {
			await fs.promises.rm(file, { force: true }).catch(() => {});
			return null;
		}
		const dataUri = safeReceiptImage(`data:image/jpeg;base64,${buf.toString("base64")}`);
		return dataUri ? { status: "image", dataUri, cached: true } : null;
	}

	async function writeCache(file, jpeg) {
		const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
		try {
			await fs.promises.mkdir(cacheDir, { recursive: true });
			await fs.promises.writeFile(tmp, jpeg);
			await fs.promises.rename(tmp, file);
		} catch (err) {
			await fs.promises.rm(tmp, { force: true }).catch(() => {});
			log(`receipt image cache write failed: ${String((err && err.message) || err).slice(0, 200)}`);
		}
	}

	// One re-encode in its own process. Resolves { jpeg } or { error }; settles
	// once, and the child never outlives it.
	function runChild(image) {
		const { fork } = require("child_process");
		return new Promise((resolve) => {
			let child = null;
			let timer = null;
			let settled = false;
			let stderr = "";
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
				counters.forks += 1;
				child = fork(childPath, [], {
					cwd: path.join(__dirname, ".."),
					env: {},                  // the re-encode needs nothing from the server's environment
					execArgv: [],             // and none of its runtime flags
					serialization: "advanced",
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				});
			} catch (err) {
				finish({ error: String((err && err.message) || err).slice(0, 200) });
				return;
			}
			// First: a child that could not start reports it here, and an 'error'
			// nobody listens for would end the server.
			child.on("error", (err) => finish({ error: String((err && err.message) || err).slice(0, 200) }));
			timer = setTimeout(() => finish({ error: `timed out after ${timeoutMs} ms` }), timeoutMs);
			if (child.stderr) {
				child.stderr.on("error", () => { /* diagnostics only */ });
				child.stderr.setEncoding("utf8").on("data", (chunk) => { if (stderr.length < 8_000) stderr += chunk; });
			}
			child.on("message", (msg) => {
				const jpeg = msg && asBuffer(msg.jpeg);
				if (jpeg) return finish({ jpeg });
				finish({ error: `failed: ${String((msg && msg.error) || "no result").slice(0, 200)}` });
			});
			// 'close' follows the last IPC message, so "no answer" is final here.
			child.on("close", (code, signal) => {
				const cause = stderr.split("\n").map((l) => l.trim()).find((l) => /^(?:[\w$.]{0,60}(?:Error|Exception)\b|FATAL ERROR\b)/.test(l)) || "";
				finish({ error: `process exited (${signal || `code ${code}`})${cause ? `: ${cause.slice(0, 200)}` : ""}` });
			});
			if (typeof child.send !== "function") return;
			try {
				child.send({ image, maxEdge: RECEIPT_IMAGE_MAX_EDGE, quality: 80, retryQuality: 60, maxBytes: RECEIPT_IMAGE_MAX_BYTES }, (err) => {
					if (err) finish({ error: String(err.message || err).slice(0, 200) });
				});
			} catch (err) {
				finish({ error: String((err && err.message) || err).slice(0, 200) });
			}
		});
	}

	function pump() {
		if (counters.running > 0 || waiting.length === 0) return;
		const job = waiting.shift();
		counters.running += 1;
		counters.maxRunning = Math.max(counters.maxRunning, counters.running);
		runChild(job.image).then((result) => {
			counters.running -= 1;
			job.done(result);
			pump();
		});
	}

	function reencode(image) {
		if (waiting.length >= queueCap && counters.running > 0) return Promise.resolve({ error: "busy" });
		return new Promise((done) => {
			waiting.push({ image, done });
			pump();
		});
	}

	async function produce(expenseId, photoData, file) {
		try {
			const hit = await readCache(file);
			if (hit) return hit;
			const source = await readSource(photoData);
			if (!source.buf) return source;
			const verdict = imageLimits.checkImage(source.buf, DECODABLE);
			if (!verdict.ok) return unavailable(verdict.reason === "pixels" ? "too large" : "unreadable");
			const result = await reencode(source.buf);
			if (result.error) {
				if (result.error !== "busy") log(`receipt image for expense ${expenseId} not prepared: ${result.error}`);
				return unavailable(result.error === "busy" || /^timed out/.test(result.error) ? result.error : "unreadable");
			}
			if (!imageLimits.checkImage(result.jpeg, outputLimits).ok) return unavailable("unreadable");
			const dataUri = safeReceiptImage(`data:image/jpeg;base64,${result.jpeg.toString("base64")}`);
			if (!dataUri) return unavailable("unreadable");
			await writeCache(file, result.jpeg);
			return { status: "image", dataUri, cached: false };
		} catch (err) {
			log(`receipt image for expense ${expenseId} failed: ${String((err && err.message) || err).slice(0, 200)}`);
			return unavailable("unreadable");
		}
	}

	function prepare({ expenseId, photoData } = {}, { waitMs } = {}) {
		const id = Number(expenseId);
		if (!Number.isInteger(id) || id <= 0) return Promise.resolve(unavailable("no receipt"));
		const file = path.join(cacheDir, receiptImageCacheName(id, photoData, version));
		let job = inflight.get(file);
		if (!job) {
			job = produce(id, photoData, file).finally(() => inflight.delete(file));
			inflight.set(file, job);
		}
		if (!(waitMs >= 0)) return job;
		let timer = null;
		const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "unavailable", reason: "preparing", ready: job }), waitMs); });
		return Promise.race([job.then((r) => { clearTimeout(timer); return r; }), late]);
	}

	return {
		prepare,
		stats: () => ({ forks: counters.forks, running: counters.running, maxRunning: counters.maxRunning, waiting: waiting.length }),
	};
}

module.exports = {
	RECEIPT_IMAGE_CACHE_VERSION,
	RECEIPT_IMAGE_MAX_EDGE,
	RECEIPT_IMAGE_MAX_BYTES,
	RECEIPT_IMAGE_MAX_PIXELS,
	RECEIPT_IMAGE_TIMEOUT_MS,
	RECEIPT_IMAGE_QUEUE_CAP,
	receiptImageCacheName,
	receiptImageKind,
	createReceiptImageService,
	safeReceiptImage,
};
