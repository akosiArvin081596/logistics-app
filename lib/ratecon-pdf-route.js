"use strict";

// ===========================================================================
// GET /api/loads/:loadId/ratecon.pdf: a load's newest rate con, shown to a
// Super Admin inside the load-detail modal (client RateConPdfSection.vue).
//
// WHO. requireRole("Super Admin") opens the route, before any lookup: signed
// out is 401, every other role 403 (a Driver asking for their own load
// included). Rate cons carry broker rates and contacts, which no other role
// sees anywhere in the app. Nothing under /api/public/* or the /track page
// references this route.
//
// WHICH FILE. Chosen by load lookup only; the request names a load, never a
// file or a path. The candidates are the two places the app already keeps rate
// cons:
//   - the load's RATECON documents rows: a local archive copy under
//     uploads/rate-cons/ (POST /api/loads/from-ratecon writes it) and/or a
//     Drive file id (the invoice draft's content match writes those);
//   - the rate-con Drive folder (RATECON_DRIVE_FOLDER_ID), where n8n files
//     every emailed rate con under its subject line. The whole folder is listed
//     page by page and cached for LISTING_TTL_MS; a file belongs to the load
//     when its name carries the load id with nothing alphanumeric on either
//     side (filenameCarriesLoadIdBounded()). A re-issued rate con therefore
//     appears once the cached listing expires.
// The newest candidate wins (Drive createdTime, documents uploaded_at). A
// candidate whose file no longer exists is passed over for the next one.
//
// FAILURES ARE ANSWERED, NOT SWALLOWED. When the folder is configured but Drive
// cannot be listed (5xx, 429, network) the answer is 503 even if a local copy
// exists: an outage must never quietly make an older copy look like the
// current one. The local replica, whose Drive is off by design, counts as "not
// configured": its archive copies are served.
//
// SERVED AS STORED, NEVER PARSED. The only check on the bytes is that they
// start with "%PDF-"; nothing here extracts text or renders anything. Files
// over MAX_RATECON_BYTES are refused by their stored size, before a download.
// The browser renders the bytes with pdf.js; the response also carries a CSP
// sandbox so the URL opened directly runs nothing.
// ===========================================================================

const fs = require("fs");
const path = require("path");
const { normLoadId, filenameCarriesLoadIdBounded } = require("./ratecon-drive-index");

const ROUTE_PATH = "/api/loads/:loadId/ratecon.pdf";
const MAX_RATECON_BYTES = 15 * 1024 * 1024;
const LISTING_TTL_MS = 5 * 60 * 1000;
// 1,000 files a page: a runaway nextPageToken stops at 50,000 files.
const MAX_LISTING_PAGES = 50;
// The id as written, an optional leading "#", then a letter or digit first, so
// "." and ".." can never be one. Only used to look rows and names up: no part
// of it ever becomes a path.
const LOAD_ID_RE = /^#?[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
// The one archive file name shape POST /api/loads/from-ratecon writes.
const ARCHIVE_URL_PREFIX = "/uploads/rate-cons/";
const ARCHIVE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}\.pdf$/i;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

const MESSAGES = Object.freeze({
	badLoadId: "That load ID isn't valid.",
	notFound: "No rate con is on file for this load.",
	driveDown: "Google Drive can't be reached right now, so the rate con can't be loaded. Try again in a few minutes.",
	notConfigured: "No rate con copy is stored on this server, and the rate-con Drive folder isn't set up here.",
	tooLarge: "The rate con on file is larger than 15 MB, so it can't be shown here.",
	notPdf: "The rate con on file isn't a PDF, so it can't be shown.",
	failed: "The rate con couldn't be loaded. Try again.",
});

function refuse(res, status, code, error) {
	return res.status(status).set("Cache-Control", "no-store").json({ code, error });
}

// googleapis errors carry the HTTP status as `code` (a number) or on
// `response.status`; a network failure carries a string code.
function driveFailureKind(err) {
	if (err && err.code === "REPLICA_OUTBOUND_OFF") return "off";
	const status = Number((err && err.response && err.response.status) || (err && err.code));
	if (status === 404) return "gone";
	return "down";
}

// SQLite's CURRENT_TIMESTAMP is UTC without a zone mark.
function sqliteUtcMs(s) {
	const v = String(s || "").trim();
	if (!v) return 0;
	const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : 0;
}

function mount(app, deps) {
	const { requireRole, db, getDrive, docTypes } = deps;
	const logger = deps.logger || console;
	const rateconDir = path.resolve(deps.rateconDir);
	const folderRaw = String(deps.folderId || "").trim();
	const folderId = DRIVE_ID_RE.test(folderRaw) ? folderRaw : "";
	if (folderRaw && !folderId) logger.error("[ratecon-pdf] RATECON_DRIVE_FOLDER_ID is not a Drive id; the rate con viewer reads the local archive only.");
	const types = (docTypes || []).map((t) => String(t).toUpperCase());

	const selectDocs = db.prepare(
		`SELECT id, drive_file_id, drive_url, uploaded_at FROM documents
		 WHERE LOWER(TRIM(load_id)) IN (?, ?)
		   AND UPPER(type) IN (${types.map(() => "?").join(", ")})
		   AND deleted_at IS NULL`,
	);

	// ── The folder listing, cached, one listing in flight at a time ──────────
	let listing = null; // { at, files }
	let listingInFlight = null;
	async function folderFiles() {
		if (listing && Date.now() - listing.at < LISTING_TTL_MS) return listing.files;
		if (listingInFlight) return listingInFlight;
		listingInFlight = (async () => {
			const drive = await getDrive();
			const files = [];
			let pageToken;
			let pages = 0;
			do {
				if (++pages > MAX_LISTING_PAGES) throw new Error(`the rate-con folder listing ran past ${MAX_LISTING_PAGES} pages`);
				const resp = await drive.files.list({
					q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
					fields: "nextPageToken, files(id, name, createdTime, size)",
					pageSize: 1000,
					pageToken,
					supportsAllDrives: true,
					includeItemsFromAllDrives: true,
				});
				const data = (resp && resp.data) || {};
				for (const f of data.files || []) {
					if (!f || !DRIVE_ID_RE.test(String(f.id || ""))) continue;
					files.push({ id: String(f.id), name: String(f.name || ""), at: Date.parse(f.createdTime) || 0, size: Number(f.size) });
				}
				pageToken = data.nextPageToken || undefined;
			} while (pageToken);
			listing = { at: Date.now(), files };
			return files;
		})();
		try {
			return await listingInFlight;
		} finally {
			listingInFlight = null;
		}
	}

	// A local path comes only from a documents row, and only in the exact shape
	// the archive writes. Anything else is skipped and logged, never resolved.
	function archivePathOf(row) {
		const url = String(row.drive_url || "");
		if (!url) return null;
		const name = url.startsWith(ARCHIVE_URL_PREFIX) ? url.slice(ARCHIVE_URL_PREFIX.length) : "";
		if (!ARCHIVE_NAME_RE.test(name) || name.includes("..")) {
			logger.warn(`[ratecon-pdf] skipped documents row ${row.id}: its stored path is not an archive file name`);
			return null;
		}
		const full = path.join(rateconDir, name);
		if (path.dirname(full) !== rateconDir) {
			logger.warn(`[ratecon-pdf] skipped documents row ${row.id}: its stored path leaves the archive folder`);
			return null;
		}
		return full;
	}

	function sendPdf(res, buf, loadId) {
		if (buf.length < PDF_MAGIC.length || !buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
			logger.warn(`[ratecon-pdf] load ${loadId}: the stored rate con does not start with %PDF-; refused`);
			return refuse(res, 422, "RATECON_NOT_PDF", MESSAGES.notPdf);
		}
		const safeName = loadId.replace(/[^A-Za-z0-9._-]/g, "_");
		res.status(200).set({
			"Content-Type": "application/pdf",
			"Content-Length": String(buf.length),
			"Content-Disposition": `inline; filename="${safeName}-ratecon.pdf"`,
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "no-referrer",
			"X-Robots-Tag": "noindex",
		});
		return res.end(buf);
	}

	app.get(ROUTE_PATH, requireRole("Super Admin"), async (req, res) => {
		const raw = String(req.params.loadId || "").trim();
		if (!LOAD_ID_RE.test(raw)) return refuse(res, 400, "RATECON_BAD_LOAD_ID", MESSAGES.badLoadId);
		const loadId = normLoadId(raw);
		try {
			// ── Candidates ────────────────────────────────────────────────────
			const lc = loadId.toLowerCase();
			const candidates = [];
			const rowDriveIds = new Set();
			for (const row of selectDocs.all(lc, `#${lc}`, ...types)) {
				const driveFileId = DRIVE_ID_RE.test(String(row.drive_file_id || "")) ? String(row.drive_file_id) : "";
				const localPath = archivePathOf(row);
				if (!localPath && !driveFileId) continue;
				if (driveFileId) rowDriveIds.add(driveFileId);
				candidates.push({ localPath, driveFileId, size: NaN, at: sqliteUtcMs(row.uploaded_at), from: `documents row ${row.id}` });
			}
			let driveState = folderId ? "ok" : "not_configured";
			if (folderId) {
				try {
					for (const f of await folderFiles()) {
						if (rowDriveIds.has(f.id) || !filenameCarriesLoadIdBounded(f.name, loadId)) continue;
						candidates.push({ localPath: null, driveFileId: f.id, size: f.size, at: f.at, from: "the rate-con Drive folder" });
					}
				} catch (e) {
					if (driveFailureKind(e) === "off") {
						driveState = "not_configured";
					} else {
						logger.error(`[ratecon-pdf] load ${loadId}: the rate-con Drive folder could not be listed: ${e && e.message}`);
						return refuse(res, 503, "RATECON_SOURCE_UNAVAILABLE", MESSAGES.driveDown);
					}
				}
			}
			// Newest first; on a tie the local copy, which costs no download.
			candidates.sort((a, b) => (b.at - a.at) || ((b.localPath ? 1 : 0) - (a.localPath ? 1 : 0)));

			// ── The newest file that still exists ─────────────────────────────
			for (const c of candidates) {
				if (c.localPath) {
					let st = null;
					try {
						st = await fs.promises.stat(c.localPath);
					} catch (e) {
						if (e && e.code !== "ENOENT") throw e;
						logger.warn(`[ratecon-pdf] load ${loadId}: the archive file of ${c.from} is missing`);
					}
					if (st && st.isFile()) {
						if (st.size > MAX_RATECON_BYTES) return refuse(res, 413, "RATECON_TOO_LARGE", MESSAGES.tooLarge);
						return sendPdf(res, await fs.promises.readFile(c.localPath), loadId);
					}
					if (!c.driveFileId) continue;
				}
				try {
					const drive = await getDrive();
					let size = c.size;
					if (!Number.isFinite(size)) {
						const meta = await drive.files.get({ fileId: c.driveFileId, fields: "size", supportsAllDrives: true });
						size = Number(meta && meta.data && meta.data.size);
						// A Google-native file has no stored size, and is not a PDF.
						if (!Number.isFinite(size)) return refuse(res, 422, "RATECON_NOT_PDF", MESSAGES.notPdf);
					}
					if (size > MAX_RATECON_BYTES) return refuse(res, 413, "RATECON_TOO_LARGE", MESSAGES.tooLarge);
					const resp = await drive.files.get(
						{ fileId: c.driveFileId, alt: "media", supportsAllDrives: true },
						{ responseType: "arraybuffer" },
					);
					const buf = Buffer.from(resp.data);
					if (buf.length > MAX_RATECON_BYTES) return refuse(res, 413, "RATECON_TOO_LARGE", MESSAGES.tooLarge);
					return sendPdf(res, buf, loadId);
				} catch (e) {
					const kind = driveFailureKind(e);
					if (kind === "gone") {
						listing = null;
						logger.warn(`[ratecon-pdf] load ${loadId}: a Drive file from ${c.from} no longer exists`);
						continue;
					}
					if (kind === "off") {
						driveState = "not_configured";
						continue;
					}
					logger.error(`[ratecon-pdf] load ${loadId}: Drive could not send the rate con: ${e && e.message}`);
					return refuse(res, 503, "RATECON_SOURCE_UNAVAILABLE", MESSAGES.driveDown);
				}
			}
			if (driveState === "not_configured") return refuse(res, 503, "RATECON_SOURCE_NOT_CONFIGURED", MESSAGES.notConfigured);
			return refuse(res, 404, "RATECON_NOT_FOUND", MESSAGES.notFound);
		} catch (e) {
			logger.error(`[ratecon-pdf] load ${loadId}: ${e && e.message}`);
			return refuse(res, 500, "RATECON_LOAD_FAILED", MESSAGES.failed);
		}
	});
}

module.exports = { mount, ROUTE_PATH, MAX_RATECON_BYTES, LISTING_TTL_MS, MESSAGES };
