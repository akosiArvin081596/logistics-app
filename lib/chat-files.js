"use strict";
// Chat attachment files (uploads/chat/): who may open one, and the copy they
// are given.
//
// WHO: the people who can read the conversation the file was sent in, by the
// same rule as the routes that serve those conversations:
//   Super Admin, Dispatcher  every thread (GET /api/messages/:driverName)
//   Driver                   messages from or to his driver name
//                            (GET /api/driver/:driverName)
//   Investor                 messages from or to his username
//                            (GET /api/investor/messages)
// Anyone else is answered 404, never 403: a 403 would confirm the name exists.
//
// THE ROW DECIDES, NOT THE NAME. A file is an attachment only while a messages
// row names it in attachment_url, and its conversation is the FIRST such row's
// (lowest id): the message that sent it. A later message naming the same URL
// does not widen who may open it. A file no row names is refused to everyone,
// staff included: nothing links to it.
//
// THE COPY. JPEG, PNG and WebP photos are sent without their metadata
// (lib/image-metadata.js): no GPS position, camera or text, orientation kept.
// Files stored before uploads were stripped still hold theirs, and are stripped
// on every read; a photo that cannot be walked is not served at all (404),
// never sent as it is. Everything else (PDFs, GIFs, documents) carries no EXIF
// block and is handed to the static mount, which serves it as stored with
// nosniff and forces a download for anything not rendered inline.
//
// Nothing here reads a request's raw path: uploadsPathGuard in server.js
// normalizes it once and hands over the bare file name and the URL the rows
// store. The guard is async and never rejects (Express 4 drops a middleware's
// promise and this process has no unhandledRejection handler).

const fs = require("fs");
const { stripImageMetadata, imageKind } = require("./image-metadata");
const { resolveReceiptPath, createReadSlots } = require("./receipt-files");

const STAFF_ROLES = Object.freeze(["Super Admin", "Dispatcher"]);
// POST /api/chat/attachment takes at most 13.5 M characters of base64, about
// 10.1 MB of file. Anything bigger on disk was never written by the app.
const CHAT_SERVE_MAX_BYTES = 10.5 * 1024 * 1024;
const IMAGE_CONTENT_TYPES = Object.freeze({ jpeg: "image/jpeg", png: "image/png", webp: "image/webp" });
// A thread renders every photo at once; each is read whole to be stripped, so
// only a few are in memory at a time server-wide and the rest wait (bounded,
// per user too), then answer 503.
const CHAT_SERVE_LIMITS = Object.freeze({
	maxConcurrentReads: 4,
	maxQueuedReads: 500,
	maxQueuedPerUser: 100,
	queueWaitMs: 15_000,
	sendTimeoutMs: 30_000,
});
const NO_STORE = "private, no-store";

// The name a caller's own messages are addressed to: a Driver's driver name,
// an Investor's username. Trimmed and lower-cased, as the thread routes compare.
function ownChatName(user) {
	if (!user) return "";
	const name = user.role === "Driver" ? user.driverName : user.role === "Investor" ? user.username : "";
	return typeof name === "string" ? name.trim().toLowerCase() : "";
}

// May `user` open the attachment these rows name? rows: [{ id, from, to }],
// any order.
function chatAttachmentAccess(user, rows) {
	if (!user || !Array.isArray(rows) || !rows.length) return false;
	if (STAFF_ROLES.includes(user.role)) return true;
	const me = ownChatName(user);
	if (!me) return false;
	const first = rows.reduce((a, b) => (Number(b.id) < Number(a.id) ? b : a));
	const party = (v) => (typeof v === "string" ? v.toLowerCase() : "");
	return party(first.from) === me || party(first.to) === me;
}

// WHICH FILE A MESSAGE MAY CARRY. POST /api/chat/attachment records who stored
// each file (chat_uploads); POST /api/messages takes an attachment only when it
// is a chat file the same account stored there. Anything else (another
// person's file, a link to another site, a script URL) is refused with 400.
const CHAT_UPLOADS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS chat_uploads (
	file_url TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
)`;
// The name POST /api/chat/attachment gives a file: chat_<ms>_<random>.<ext>.
const CHAT_FILE_URL_RE = /^\/uploads\/chat\/chat_\d{1,16}_[a-z0-9]{1,5}\.[A-Za-z0-9]{1,5}$/;

function recordChatUpload(db, url, userId) {
	db.prepare("INSERT OR IGNORE INTO chat_uploads (file_url, user_id) VALUES (?, ?)").run(String(url), Number(userId) || 0);
}

// '' when a message from `user` may carry `url` (none, or a chat file this
// account uploaded), else the refusal code.
function chatAttachmentRefusal(db, user, url) {
	if (url === undefined || url === null || url === "") return "";
	const uid = Number(user && user.id);
	if (typeof url !== "string" || !CHAT_FILE_URL_RE.test(url) || !(uid > 0)) return "ATTACHMENT_NOT_ALLOWED";
	const row = db.prepare("SELECT user_id FROM chat_uploads WHERE file_url = ?").get(url);
	return row && Number(row.user_id) === uid ? "" : "ATTACHMENT_NOT_ALLOWED";
}

// The bytes to store for a new upload: a photo without its metadata, anything
// else as it is; null for a photo the strip cannot walk (refuse it, 415).
function chatUploadBytes(buf) {
	if (!Buffer.isBuffer(buf) || !buf.length) return null;
	if (!imageKind(buf)) return buf;
	const out = stripImageMetadata(buf);
	return out.ok ? out.buf : null;
}

async function fileHead(abs) {
	const st = await fs.promises.stat(abs);
	if (!st.isFile() || st.size > CHAT_SERVE_MAX_BYTES) return null;
	const fh = await fs.promises.open(abs, "r");
	try {
		const head = Buffer.alloc(16);
		const { bytesRead } = await fh.read(head, 0, head.length, 0);
		return head.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

// The /uploads guard for chat/, in GUARDED_UPLOAD_DIRS' shape
// (req, res, next, url, file). `limits` overrides CHAT_SERVE_LIMITS.
function createChatAttachmentGuard({ db, chatDir, logError, ...limits } = {}) {
	const log = typeof logError === "function" ? logError : () => {};
	const L = { ...CHAT_SERVE_LIMITS, ...limits };
	const slots = createReadSlots(L.maxConcurrentReads, L.maxQueuedReads, L.maxQueuedPerUser);
	return async function guardChatAttachment(req, res, next, url, file) {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") return res.status(404).end();
			const user = req.session && req.session.user;
			const abs = resolveReceiptPath(chatDir, file);
			if (!abs) return res.status(404).end();
			// NOCASE: every spelling of the URL counts, so the earliest message that
			// names the file decides whichever spelling it used.
			const rows = db.prepare('SELECT id, "from", "to" FROM messages WHERE attachment_url = ? COLLATE NOCASE').all(url);
			if (!chatAttachmentAccess(user, rows)) return res.status(404).end();

			let head;
			try { head = await fileHead(abs); } catch { head = null; }
			if (!head) return res.status(404).end();
			// Not a JPEG, PNG or WebP: no EXIF block to strip; the static mount
			// serves it as stored.
			if (!imageKind(head)) {
				// The static mount leaves a Cache-Control already set as it is.
				res.setHeader("Cache-Control", NO_STORE);
				return next();
			}

			if (!(await slots.acquire(L.queueWaitMs, `u:${user && user.id}`))) {
				res.setHeader("Retry-After", "2");
				res.setHeader("Cache-Control", "no-store");
				return res.status(503).json({ error: "The server is busy. Try again in a moment.", code: "CHAT_FILE_SERVER_BUSY", retryable: true });
			}
			let released = false;
			let sendTimer = null;
			const release = () => {
				if (released) return;
				released = true;
				if (sendTimer) clearTimeout(sendTimer);
				slots.release();
			};
			try {
				if (res.destroyed || res.writableEnded) return release();
				let buf;
				try {
					buf = await fs.promises.readFile(abs);
				} catch {
					buf = null;
				}
				const out = buf && buf.length <= CHAT_SERVE_MAX_BYTES ? stripImageMetadata(buf) : null;
				if (!out || !out.ok) {
					release();
					if (buf) log(`[uploads] chat photo not served (unreadable image): message ${rows[0].id}`);
					return res.status(404).end();
				}
				res.once("finish", release);
				res.once("close", release);
				sendTimer = setTimeout(() => { if (!res.writableFinished) res.destroy(); }, L.sendTimeoutMs);
				res.statusCode = 200;
				res.setHeader("Content-Type", IMAGE_CONTENT_TYPES[out.type]);
				res.setHeader("Content-Length", String(out.buf.length));
				res.setHeader("X-Content-Type-Options", "nosniff");
				res.setHeader("Cache-Control", NO_STORE);
				return req.method === "HEAD" ? res.end() : res.end(out.buf);
			} catch (err) {
				release();
				throw err;
			}
		} catch (err) {
			log(`[uploads] chat file guard failed: ${err && err.message}`);
			if (!res.headersSent) res.status(404).end();
		}
	};
}

module.exports = {
	CHAT_SERVE_MAX_BYTES,
	CHAT_SERVE_LIMITS,
	CHAT_UPLOADS_SCHEMA_SQL,
	CHAT_FILE_URL_RE,
	recordChatUpload,
	chatAttachmentRefusal,
	chatAttachmentAccess,
	chatUploadBytes,
	createChatAttachmentGuard,
};
