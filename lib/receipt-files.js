"use strict";
// Expense receipt files (uploads/expense-receipts/): who may open one, and the
// copy they are given.
//
// WHO (owner, 2026-10-15): the receipt's own driver, Super Admin, and the roles
// that review receipts. Reviewing is approving or rejecting one
// (PUT /api/expenses/:id/status, PUT /api/expenses/bulk-status), which is
// Super Admin and Dispatcher, so REVIEWER_ROLES is those two. Anyone else is
// answered 404, never 403: a 403 would confirm that the name exists.
//
// THE ROW DECIDES, NOT THE NAME. A file is a receipt only while an expenses row
// names it in photo_data, and its driver (and, for an Investor, its truck) is
// the one on the FIRST such row (lowest id): the insert that wrote the file
// (POST /api/expenses takes a receipt only as its bytes). A file no row names
// is refused to everyone, Super Admin included: nothing links to it.
//
// THE COPY. Images are sent without their metadata (lib/image-metadata.js): no
// GPS position, camera or text, orientation kept. Stored files written before
// uploads were stripped still hold theirs, and are stripped on every read; an
// image that cannot be walked is not served at all (404), never sent as it is.
// PDF receipts (Super Admin / Dispatcher uploads) are sent as they are.
//
// Nothing here reads a request's raw path: uploadsPathGuard in server.js
// normalizes it once and hands over the bare file name and the URL the rows
// store. The guard is async and never rejects (Express 4 drops a middleware's
// promise and this process has no unhandledRejection handler).

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { stripImageMetadata, imageKind } = require("./image-metadata");

const RECEIPT_URL_PREFIX = "/uploads/expense-receipts/";
const REVIEWER_ROLES = Object.freeze(["Super Admin", "Dispatcher"]);
// The largest receipt an upload may store (an image: 20 MB; a PDF: 15 MB).
// Anything bigger on disk was never written by the app and is not served.
const RECEIPT_SERVE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = Object.freeze({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
// The serving limits. An image is read whole and stripped, so only a few are
// in memory at once, server-wide; the rest wait in a bounded queue (an
// investor's receipt list asks for every photo at once over HTTP/2) and answer
// 503 once it is full or a wait runs too long. Each user also has a ceiling per
// window (429). PDFs stream from disk and take no read slot.
const RECEIPT_SERVE_LIMITS = Object.freeze({
	maxConcurrentReads: 4,
	maxQueuedReads: 500,
	queueWaitMs: 15_000,
	perUserWindowMs: 15 * 60 * 1000,
	perUserMax: 3000,
	perUserKeysMax: 5000,
});
const NO_STORE = "private, no-store";

function isPdf(buf) {
	return Buffer.isBuffer(buf) && buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-";
}

// The bytes a receipt may be sent as: { buf, contentType } or null (refuse).
function servableReceipt(buf) {
	if (!Buffer.isBuffer(buf) || !buf.length) return null;
	if (isPdf(buf)) return { buf, contentType: "application/pdf" };
	const kind = imageKind(buf);
	if (!kind) return null;
	const stripped = stripImageMetadata(buf);
	if (!stripped.ok) return null;
	return { buf: stripped.buf, contentType: IMAGE_CONTENT_TYPES[stripped.type] };
}

// An image's bytes without metadata, or null when they are not an image this
// can strip. For a caller that has the bytes in hand (the thumbnail route's
// fallback to the original).
function strippedImage(buf) {
	const out = stripImageMetadata(buf);
	return out.ok ? out.buf : null;
}

// May `user` open the receipt these rows name? rows: [{ id, driver }], any order.
// investorMaySee(user, firstRow) answers for an Investor: true, false, or null
// (could not tell); it defaults to false.
function receiptAccess(user, rows, { normalizeDriverName, investorMaySee } = {}) {
	if (!user || !Array.isArray(rows) || !rows.length) return false;
	if (REVIEWER_ROLES.includes(user.role)) return true;
	const first = rows.reduce((a, b) => (Number(b.id) < Number(a.id) ? b : a));
	if (user.role === "Driver") {
		if (typeof normalizeDriverName !== "function") return false;
		const mine = normalizeDriverName(user.driverName);
		return !!mine && normalizeDriverName(first.driver) === mine;
	}
	if (user.role === "Investor" && typeof investorMaySee === "function") {
		const verdict = investorMaySee(user, first);
		return verdict === true ? true : verdict === null ? null : false;
	}
	return false;
}

function resolveReceiptPath(receiptsDir, file) {
	const name = String(file || "");
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
	const dir = path.resolve(String(receiptsDir || ""));
	const abs = path.join(dir, name);
	return abs.startsWith(dir + path.sep) ? abs : null;
}

// A stored receipt's size and first bytes, or null when it is not a regular
// file within the serve cap.
async function receiptHead(abs) {
	const st = await fs.promises.stat(abs);
	if (!st.isFile() || st.size > RECEIPT_SERVE_MAX_BYTES) return null;
	const fh = await fs.promises.open(abs, "r");
	try {
		const head = Buffer.alloc(16);
		const { bytesRead } = await fh.read(head, 0, head.length, 0);
		return { size: st.size, head: head.subarray(0, bytesRead) };
	} finally {
		await fh.close();
	}
}

async function readReceipt(abs, readFile = fs.promises.readFile) {
	const st = await fs.promises.stat(abs);
	if (!st.isFile() || st.size > RECEIPT_SERVE_MAX_BYTES) return null;
	const buf = await readFile(abs);
	return buf.length <= RECEIPT_SERVE_MAX_BYTES ? buf : null;
}

// A few image reads at a time; the rest wait, up to a bound and a deadline.
function createReadSlots(max, maxQueued) {
	let running = 0;
	const queue = [];
	return {
		// Resolves true with a slot held, or false (queue full or waited too long).
		acquire(waitMs) {
			if (running < max) { running++; return Promise.resolve(true); }
			if (queue.length >= maxQueued) return Promise.resolve(false);
			return new Promise((resolve) => {
				const waiter = { resolve, timer: null };
				waiter.timer = setTimeout(() => {
					const at = queue.indexOf(waiter);
					if (at >= 0) queue.splice(at, 1);
					resolve(false);
				}, waitMs);
				queue.push(waiter);
			});
		},
		release() {
			const next = queue.shift();
			if (next) { clearTimeout(next.timer); next.resolve(true); return; }
			running = Math.max(0, running - 1);
		},
	};
}

// Receipt files per user per window. In memory, like the other limiters; the
// oldest key goes first past perUserKeysMax.
function createUserCounter({ perUserWindowMs, perUserMax, perUserKeysMax }) {
	const counts = new Map();
	return function take(userId) {
		const key = `u:${userId}`;
		const now = Date.now();
		let w = counts.get(key);
		if (!w || now >= w.resetAt) {
			w = { n: 0, resetAt: now + perUserWindowMs };
			counts.delete(key);
			counts.set(key, w);
			if (counts.size > perUserKeysMax) counts.delete(counts.keys().next().value);
		}
		if (w.n >= perUserMax) return Math.max(1, Math.ceil((w.resetAt - now) / 1000));
		w.n++;
		return 0;
	};
}

function busy(res, seconds, code, error) {
	res.setHeader("Retry-After", String(seconds));
	res.setHeader("Cache-Control", "no-store");
	return res.status(code === "RECEIPT_RATE_LIMITED" ? 429 : 503).json({ error, code, retryable: true });
}

// The /uploads guard for expense-receipts/, in GUARDED_UPLOAD_DIRS' shape
// (req, res, next, url, file). It serves the file itself rather than passing it
// to express.static, because the static mount would send the stored bytes.
// `limits` overrides RECEIPT_SERVE_LIMITS; `readFile` replaces the whole-file
// read of an image (the runners time it).
function createExpenseReceiptGuard({ db, receiptsDir, normalizeDriverName, investorMaySee, logError, readFile, ...limits } = {}) {
	const log = typeof logError === "function" ? logError : () => {};
	const L = { ...RECEIPT_SERVE_LIMITS, ...limits };
	const slots = createReadSlots(L.maxConcurrentReads, L.maxQueuedReads);
	const takeUserRead = createUserCounter(L);
	return async function guardExpenseReceipt(req, res, next, url, file) {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).end();
			const user = req.session && req.session.user;
			const wait = takeUserRead(user && user.id);
			if (wait) return busy(res, wait, "RECEIPT_RATE_LIMITED", "Too many receipt requests. Try again later.");
			const abs = resolveReceiptPath(receiptsDir, file);
			if (!abs) return res.status(404).end();
			const rows = db.prepare("SELECT id, driver FROM expenses WHERE photo_data = ?").all(url);
			const allowed = receiptAccess(user, rows, { normalizeDriverName, investorMaySee });
			if (allowed === null) {
				res.setHeader("Retry-After", "5");
				return res.status(503).json({ error: "Could not check access to this receipt. Try again.", code: "RECEIPT_ACCESS_UNVERIFIED", retryable: true });
			}
			if (!allowed) return res.status(404).end();

			let head;
			try { head = await receiptHead(abs); } catch { head = null; }
			if (!head) return res.status(404).end();
			if (isPdf(head.head)) {
				// Streamed from disk, never held whole; ranges allowed.
				return res.sendFile(abs, {
					cacheControl: false, lastModified: false, etag: false, dotfiles: "deny",
					headers: { "Content-Type": "application/pdf", "X-Content-Type-Options": "nosniff", "Cache-Control": NO_STORE },
				}, (err) => { if (err && !res.headersSent) res.status(404).end(); });
			}
			if (!imageKind(head.head)) return res.status(404).end();

			if (!(await slots.acquire(L.queueWaitMs))) {
				return busy(res, 2, "RECEIPT_SERVER_BUSY", "The server is busy sending receipts. Try again in a moment.");
			}
			let released = false;
			const release = () => { if (!released) { released = true; slots.release(); } };
			try {
				if (res.destroyed || res.writableEnded) return release();
				let buf;
				try { buf = await readReceipt(abs, readFile); } catch { buf = null; }
				const out = buf ? servableReceipt(buf) : null;
				if (!out) {
					release();
					if (buf) log(`[uploads] receipt not served (unreadable image): expense ${rows[0].id}`);
					return res.status(404).end();
				}
				// The slot is held until the bytes have left, so the memory it
				// stands for is bounded.
				res.once("finish", release);
				res.once("close", release);
				res.statusCode = 200;
				res.setHeader("Content-Type", out.contentType);
				res.setHeader("Content-Length", String(out.buf.length));
				res.setHeader("X-Content-Type-Options", "nosniff");
				res.setHeader("Cache-Control", NO_STORE);
				return res.end(out.buf);
			} catch (err) {
				release();
				throw err;
			}
		} catch (err) {
			log(`[uploads] receipt guard failed: ${err && err.message}`);
			if (!res.headersSent) res.status(404).end();
		}
	};
}

// A stream of one stored receipt as it may be sent, read only when the reader
// first asks (a ZIP of many receipts holds one file in memory at a time). A file
// that cannot be sent is an empty entry, and onRefused hears about it.
function receiptFileStream(abs, { onRefused } = {}) {
	let started = false;
	return new Readable({
		read() {
			if (started) return;
			started = true;
			readReceipt(abs)
				.then((buf) => {
					const out = buf ? servableReceipt(buf) : null;
					if (out) this.push(out.buf);
					else if (typeof onRefused === "function") onRefused(abs);
					this.push(null);
				})
				.catch(() => {
					if (typeof onRefused === "function") onRefused(abs);
					this.push(null);
				});
		},
	});
}

module.exports = {
	RECEIPT_URL_PREFIX,
	REVIEWER_ROLES,
	RECEIPT_SERVE_MAX_BYTES,
	RECEIPT_SERVE_LIMITS,
	servableReceipt,
	strippedImage,
	receiptAccess,
	resolveReceiptPath,
	createExpenseReceiptGuard,
	receiptFileStream,
};
