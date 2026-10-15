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
// Above both upload caps (20 MB image, 15 MB PDF), so every stored receipt fits.
const RECEIPT_SERVE_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = Object.freeze({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });

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

async function readReceipt(abs) {
	const st = await fs.promises.stat(abs);
	if (!st.isFile() || st.size > RECEIPT_SERVE_MAX_BYTES) return null;
	return fs.promises.readFile(abs);
}

function sendReceipt(res, out) {
	res.setHeader("Content-Type", out.contentType);
	res.setHeader("X-Content-Type-Options", "nosniff");
	// A role-gated file: no shared cache may hold it. The browser revalidates
	// with the ETag res.send() sets, so an unchanged receipt answers 304.
	res.setHeader("Cache-Control", "private, no-cache");
	res.send(out.buf);
}

// The /uploads guard for expense-receipts/, in GUARDED_UPLOAD_DIRS' shape
// (req, res, next, url, file). It serves the file itself rather than passing it
// to express.static, because the static mount would send the stored bytes.
function createExpenseReceiptGuard({ db, receiptsDir, normalizeDriverName, investorMaySee, logError } = {}) {
	const log = typeof logError === "function" ? logError : () => {};
	return async function guardExpenseReceipt(req, res, next, url, file) {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).end();
			const abs = resolveReceiptPath(receiptsDir, file);
			if (!abs) return res.status(404).end();
			const rows = db.prepare("SELECT id, driver FROM expenses WHERE photo_data = ?").all(url);
			const allowed = receiptAccess(req.session && req.session.user, rows, { normalizeDriverName, investorMaySee });
			if (allowed === null) {
				res.setHeader("Retry-After", "5");
				return res.status(503).json({ error: "Could not check access to this receipt. Try again.", code: "RECEIPT_ACCESS_UNVERIFIED", retryable: true });
			}
			if (!allowed) return res.status(404).end();
			let buf;
			try { buf = await readReceipt(abs); } catch { buf = null; }
			const out = buf ? servableReceipt(buf) : null;
			if (!out) {
				if (buf) log(`[uploads] receipt not served (unreadable image): expense ${rows[0].id}`);
				return res.status(404).end();
			}
			return sendReceipt(res, out);
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
	servableReceipt,
	strippedImage,
	receiptAccess,
	resolveReceiptPath,
	createExpenseReceiptGuard,
	receiptFileStream,
};
