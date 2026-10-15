#!/usr/bin/env node
/**
 * GET /api/loads/:loadId/ratecon.pdf: the load's newest rate con, for Super
 * Admins only, served as stored.
 *
 * WHAT IS REAL. lib/ratecon-pdf-route.js is mounted on a real Express app
 * listening on 127.0.0.1 port 0, behind the real requireRole (lifted out of
 * server.js), over an in-memory SQLite whose documents table is made from
 * server.js's own DDL, and a temp folder standing in for uploads/rate-cons.
 * Google Drive is a stub (a paged folder listing and files.get) that counts its
 * calls. The session is a header the test sets. Every load ID, file name and
 * byte is made up.
 *
 * §1 Super Admin: 200 with the exact stored bytes and the headers (PDF type,
 *    inline, nosniff, CSP sandbox without allow-scripts, private no-store,
 *    Content-Length); the newest file wins across the local archive and Drive.
 * §2 every other role is refused before any lookup: Dispatcher, Driver (the
 *    load's own driver included) and Investor 403; signed out 401. No Drive
 *    call and no file read for any of them, and no PDF bytes.
 * §3 the public tracker gets nothing: no PDF under /api/public/track, a
 *    tracker visitor (no session) is refused, the tracker handler names no rate
 *    con, and the module registers nothing public.
 * §4 nothing on file: 404 RATECON_NOT_FOUND with a plain message.
 * §5 Drive down: 503 with or without a local copy (never an older local copy
 *    while Drive cannot be asked); not configured: the local copy is served,
 *    and with none, 503.
 * §6 a stored file that is not a PDF is refused (422 RATECON_NOT_PDF); a file
 *    listed over 15 MB is refused (413) without a download.
 * §7 matching: a longer ID containing this one does not match; IDs with and
 *    without "#" are the same load; case-insensitive; the listing is read page
 *    by page and cached.
 * §8 the request never supplies a path: malformed IDs are 400 and a poisoned
 *    documents row is skipped, never read.
 * §9 route order: mounted from server.js by one line above app.get("*"), and
 *    the route opens with requireRole("Super Admin").
 *
 * Hermetic: :memory: SQLite, one mkdtemp folder (removed at the end), port 0.
 *
 * Run: node scripts/test-ratecon-pdf-route.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let Database, express;
try {
	Database = require("better-sqlite3");
	express = require("express");
} catch (e) {
	console.error(`FAILED: a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
	process.exit(1);
}

let pass = 0;
const failures = [];
function t(cond, name) {
	if (cond) { pass++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}`);
}

// ── shipped code ────────────────────────────────────────────────────────────
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const a = SRC.indexOf(needle) + 1;
	if (a <= 0) throw new Error(`could not find function ${name}() in server.js`);
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
const QUIET = { log() {}, warn() {}, error() {} };
const realRequireRole = new Function("console", `${liftFunction("requireRole")}\nreturn requireRole;`)(QUIET);
// Tags each guard it makes, so §9 can see which roles a route opened with.
function requireRole(...roles) {
	const mw = realRequireRole(...roles);
	mw.__roles = roles;
	return mw;
}
function tableDdl(name) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) throw new Error(`could not locate CREATE TABLE ${name}`);
	return `CREATE TABLE ${name} (${m[1]}\n)`;
}
const RATECON_DOC_TYPES = Object.freeze(["RATECON", "RATE CON", "RATE_CON"]);

let routeModule = null;
try {
	routeModule = require(path.join(ROOT, "lib", "ratecon-pdf-route.js"));
} catch (e) {
	t(false, `lib/ratecon-pdf-route.js loads (${e.code || e.message})`);
}
let rcIndex = null;
try { rcIndex = require(path.join(ROOT, "lib", "ratecon-drive-index.js")); } catch { rcIndex = null; }

// ── made-up data ────────────────────────────────────────────────────────────
const pdf = (tag) => Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, "latin1");
const BYTES = {
	driveNew: pdf("drive newest"),
	driveOld: pdf("drive older"),
	local: pdf("local archive"),
	hash: pdf("stored under a hash id"),
	page2: pdf("found on page two"),
	alpha: pdf("punctuated id"),
	notPdf: Buffer.from("<html><body>not a pdf</body></html>", "utf8"),
};
const MB = 1024 * 1024;
const FOLDER = "folderUnderTest_01";
// The folder listing, split over two pages.
const LISTING = [
	[
		{ id: "drv-new-7700123-aaaa", name: "Subject: Load #7700123 Rate Confirmation.pdf", createdTime: "2026-09-20T15:00:00.000Z", size: String(BYTES.driveNew.length) },
		{ id: "drv-old-7700123-bbbb", name: "7700123-ratecon.pdf", createdTime: "2026-09-01T15:00:00.000Z", size: String(BYTES.driveOld.length) },
		{ id: "drv-long-77001234-cc", name: "Re: Load 77001234 rate con.pdf", createdTime: "2026-09-25T15:00:00.000Z", size: "100" },
		{ id: "drv-pref-7700123-dd", name: "LD7700123 confirmation.pdf", createdTime: "2026-09-26T15:00:00.000Z", size: "100" },
		{ id: "drv-suffix-7700123-2", name: "Load 7700123-2 rate con.pdf", createdTime: "2026-09-27T15:00:00.000Z", size: "100" },
		{ id: "drv-big-7700300-eeee", name: "Order 7700300.pdf", createdTime: "2026-09-10T15:00:00.000Z", size: String(16 * MB) },
		{ id: "drv-html-7700400-fff", name: "Order 7700400.pdf", createdTime: "2026-09-10T15:00:00.000Z", size: String(BYTES.notPdf.length) },
		{ id: "drv-alpha-ldmp4-gggg", name: "Rate con ld-mp4w4lp1.pdf", createdTime: "2026-09-12T15:00:00.000Z", size: String(BYTES.alpha.length) },
		{ id: "drv-alpha-long-hhhh", name: "Rate con LD-MP4W4LP12.pdf", createdTime: "2026-09-30T15:00:00.000Z", size: "100" },
		{ id: "drv-older-7700500-ii", name: "Load 7700500.pdf", createdTime: "2026-08-01T15:00:00.000Z", size: String(BYTES.driveOld.length) },
	],
	[
		{ id: "drv-page2-7700600-jj", name: "Booked Load # 7700600.pdf", createdTime: "2026-09-05T15:00:00.000Z", size: String(BYTES.page2.length) },
	],
];
const DRIVE_BYTES = {
	"drv-new-7700123-aaaa": BYTES.driveNew,
	"drv-old-7700123-bbbb": BYTES.driveOld,
	"drv-html-7700400-fff": BYTES.notPdf,
	"drv-alpha-ldmp4-gggg": BYTES.alpha,
	"drv-older-7700500-ii": BYTES.driveOld,
	"drv-page2-7700600-jj": BYTES.page2,
	"drv-docrow-7700700-kk": BYTES.hash,
};

const USERS = {
	"Super Admin": { id: 1, username: "super_admin", role: "Super Admin" },
	Dispatcher: { id: 2, username: "dispatch1", role: "Dispatcher" },
	// The load's own driver: the role, not ownership, is what refuses them.
	Driver: { id: 3, username: "LogisX-1001", role: "Driver", driverName: "Driver A" },
	Investor: { id: 4, username: "investor1", role: "Investor" },
};

// File reads are counted where the module makes them.
const reads = [];
const origReadFile = fs.promises.readFile;
const origStat = fs.promises.stat;
const origReadFileSync = fs.readFileSync;
fs.promises.readFile = function (p, ...rest) { reads.push(String(p)); return origReadFile.call(this, p, ...rest); };
fs.promises.stat = function (p, ...rest) { reads.push(String(p)); return origStat.call(this, p, ...rest); };
fs.readFileSync = function (p, ...rest) { if (typeof p === "string" && p.includes("ratecon-pdf-route-")) reads.push(p); return origReadFileSync.call(this, p, ...rest); };

async function startWorld({ folderId = FOLDER, driveMode = "ok", replicaOff = false } = {}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratecon-pdf-route-"));
	const uploadsDir = path.join(tmp, "uploads");
	const rateconDir = path.join(uploadsDir, "rate-cons");
	fs.mkdirSync(rateconDir, { recursive: true });
	fs.mkdirSync(path.join(uploadsDir, "sub"), { recursive: true });
	// Files outside the stored-file shapes, that poisoned rows point at.
	fs.writeFileSync(path.join(tmp, "secret.pdf"), pdf("must never be served"));
	fs.writeFileSync(path.join(uploadsDir, "sub", "nested.pdf"), pdf("must never be served either"));
	const db = new Database(":memory:");
	db.exec(tableDdl("documents"));
	db.exec("ALTER TABLE documents ADD COLUMN deleted_at DATETIME DEFAULT NULL");
	const log = { lists: 0, listPages: [], gets: [], media: [], logs: [] };
	const drive = {
		files: {
			list: async (params) => {
				log.lists++;
				log.listPages.push(params.pageToken || "");
				if (driveMode === "down") throw Object.assign(new Error("Service Unavailable"), { code: 503 });
				if (driveMode === "network") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
				const idx = params.pageToken ? Number(params.pageToken) : 0;
				const page = LISTING[idx] || [];
				return { data: { files: page.map((f) => ({ ...f })), nextPageToken: idx + 1 < LISTING.length ? String(idx + 1) : undefined } };
			},
			get: async (params) => {
				log.gets.push(params);
				if (driveMode === "down") throw Object.assign(new Error("Service Unavailable"), { code: 503 });
				const bytes = DRIVE_BYTES[params.fileId];
				if (!bytes) throw Object.assign(new Error("File not found"), { code: 404 });
				if (params.alt === "media") {
					log.media.push(params.fileId);
					return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
				}
				return { data: { size: String(bytes.length) } };
			},
		},
	};
	const app = express();
	app.use((req, res, next) => {
		const u = req.get("x-test-user");
		req.session = u ? { user: JSON.parse(u) } : {};
		next();
	});
	const deps = {
		requireRole,
		db,
		getDrive: async () => {
			if (replicaOff) throw Object.assign(new Error("Google Drive is off in the local replica"), { code: "REPLICA_OUTBOUND_OFF" });
			return drive;
		},
		folderId,
		uploadsDir,
		docTypes: RATECON_DOC_TYPES,
		logger: { log: (...a) => log.logs.push(a.join(" ")), warn: (...a) => log.logs.push(a.join(" ")), error: (...a) => log.logs.push(a.join(" ")) },
	};
	if (routeModule && typeof routeModule.mount === "function") routeModule.mount(app, deps);
	// Stand-ins for what sits around the route in server.js: the public tracker
	// (JSON, no rate con) and the SPA catch-all.
	app.get("/api/public/track/:loadId", (req, res) => res.json({ loadId: req.params.loadId, stage: "in_transit" }));
	app.get("*", (req, res) => res.status(200).type("html").send("<!doctype html><title>SPA</title>"));
	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const call = (url, { user = USERS["Super Admin"] } = {}) => new Promise((resolve, reject) => {
		const h = { "x-requested-with": "XMLHttpRequest" };
		if (user) h["x-test-user"] = JSON.stringify(user);
		const req = http.request({ host: "127.0.0.1", port, method: "GET", path: url, headers: h }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const body = Buffer.concat(chunks);
				let json = null;
				try { json = JSON.parse(body.toString("utf8")); } catch { json = null; }
				resolve({ status: res.statusCode, headers: res.headers, body, json });
			});
		});
		req.on("error", reject);
		req.end();
	});
	const addDoc = (loadId, driveUrl, driveFileId = "", uploadedAt = "2026-09-10 12:00:00", fileName = "x.pdf", type = "RATECON") =>
		db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_file_id, drive_url, uploaded_at) VALUES (?, '', ?, ?, ?, ?, ?)")
			.run(loadId, type, fileName, driveFileId, driveUrl, uploadedAt);
	const close = async () => {
		await new Promise((r) => server.close(r));
		db.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	};
	return { app, db, log, call, addDoc, uploadsDir, rateconDir, tmp, close };
}

const isPdfBody = (r) => r.body.length >= 5 && r.body.subarray(0, 5).toString("latin1") === "%PDF-";
const url = (id) => `/api/loads/${encodeURIComponent(id)}/ratecon.pdf`;

async function main() {
	// ── §1 Super Admin ───────────────────────────────────────────────────────
	{
		const w = await startWorld();
		// An older local archive copy: the newer Drive file wins.
		fs.writeFileSync(path.join(w.rateconDir, "7700123.pdf"), BYTES.local);
		w.addDoc("7700123", "/uploads/rate-cons/7700123.pdf", "", "2026-09-15 12:00:00");
		const r = await w.call(url("7700123"));
		t(r.status === 200, `§1 Super Admin gets 200 (got ${r.status})`);
		t(r.body.equals(BYTES.driveNew), "§1 ...with exactly the newest file's bytes (Drive, newer than the archive copy)");
		t(/^application\/pdf\b/.test(r.headers["content-type"] || ""), `§1 Content-Type application/pdf (${r.headers["content-type"]})`);
		t(/^inline\b/.test(r.headers["content-disposition"] || ""), `§1 Content-Disposition inline (${r.headers["content-disposition"]})`);
		t(r.headers["x-content-type-options"] === "nosniff", "§1 X-Content-Type-Options nosniff");
		const csp = r.headers["content-security-policy"] || "";
		t(/(^|;\s*)sandbox(\s*;|$)/.test(csp) && !/allow-scripts/.test(csp), `§1 Content-Security-Policy sandbox, without allow-scripts (${csp})`);
		const cc = r.headers["cache-control"] || "";
		t(/\bprivate\b/.test(cc) && /\bno-store\b/.test(cc), `§1 Cache-Control private, no-store (${cc})`);
		t(Number(r.headers["content-length"]) === BYTES.driveNew.length, "§1 Content-Length is the file's size");
		t(w.log.media.length === 1 && w.log.media[0] === "drv-new-7700123-aaaa", `§1 exactly one download, of the newest matching file (${w.log.media.join(",")})`);
		await w.close();
	}
	{
		const w = await startWorld();
		// The archive copy is newer than every Drive file for this load.
		fs.writeFileSync(path.join(w.rateconDir, "7700500.pdf"), BYTES.local);
		w.addDoc("7700500", "/uploads/rate-cons/7700500.pdf", "", "2026-09-15 12:00:00");
		const r = await w.call(url("7700500"));
		t(r.status === 200 && r.body.equals(BYTES.local), `§1 a newer local archive copy wins over an older Drive file (${r.status})`);
		t(w.log.media.length === 0, "§1 ...and nothing is downloaded from Drive");
		await w.close();
	}

	// ── §2 every other role ──────────────────────────────────────────────────
	{
		const w = await startWorld();
		fs.writeFileSync(path.join(w.rateconDir, "7700123.pdf"), BYTES.local);
		w.addDoc("7700123", "/uploads/rate-cons/7700123.pdf");
		for (const role of ["Dispatcher", "Driver", "Investor"]) {
			reads.length = 0;
			const before = w.log.lists + w.log.gets.length;
			const r = await w.call(url("7700123"), { user: USERS[role] });
			t(r.status === 403, `§2 ${role} gets 403 (got ${r.status})`);
			t(!isPdfBody(r) && !/pdf/i.test(r.headers["content-type"] || ""), `§2 ${role}: no PDF bytes`);
			t(w.log.lists + w.log.gets.length === before, `§2 ${role}: no Drive call`);
			t(!reads.some((p) => p.startsWith(w.tmp)), `§2 ${role}: no file read`);
		}
		reads.length = 0;
		const before = w.log.lists + w.log.gets.length;
		const anon = await w.call(url("7700123"), { user: null });
		t(anon.status === 401, `§2 signed out gets 401 (got ${anon.status})`);
		t(!isPdfBody(anon) && w.log.lists + w.log.gets.length === before && !reads.some((p) => p.startsWith(w.tmp)), "§2 signed out: no bytes, no Drive call, no file read");
		const pwUser = { ...USERS["Super Admin"], mustChangePassword: true };
		const pw = await w.call(url("7700123"), { user: pwUser });
		t(pw.status === 403 && !isPdfBody(pw), `§2 a Super Admin who must change their password is refused like everywhere else (${pw.status})`);
		await w.close();
	}

	// ── §3 the public tracker ────────────────────────────────────────────────
	{
		const w = await startWorld();
		const a = await w.call("/api/public/track/7700123/ratecon.pdf", { user: null });
		t(!isPdfBody(a) && !/pdf/i.test(a.headers["content-type"] || ""), `§3 /api/public/track/:id/ratecon.pdf is not a PDF (${a.status} ${a.headers["content-type"]})`);
		const b = await w.call(url("7700123"), { user: null });
		t(b.status === 401 && !isPdfBody(b), "§3 a tracker visitor (load ID, no session) is refused with no bytes");
		const tr = await w.call("/api/public/track/7700123", { user: null });
		t(tr.json && !Object.keys(tr.json).some((k) => /rate.?con|pdf/i.test(k)), "§3 the tracker payload stand-in carries no rate con key");
		t(w.log.lists === 0 && w.log.gets.length === 0, "§3 none of that reached Drive");
		// No registration outside /api/loads/:loadId/ratecon.pdf.
		const paths = (w.app._router && w.app._router.stack || []).filter((l) => l.route).map((l) => l.route.path);
		const mine = paths.filter((p) => /ratecon\.pdf/.test(String(p)));
		t(mine.length === 1 && mine[0] === "/api/loads/:loadId/ratecon.pdf", `§3 the module registers exactly GET /api/loads/:loadId/ratecon.pdf (${mine.join(",")})`);
		t(!paths.some((p) => /^\/(api\/public|track)/.test(String(p)) && /ratecon|pdf/i.test(String(p))), "§3 ...and nothing under /api/public or /track");
		await w.close();
		const at = SRC.indexOf('\napp.get("/api/public/track/:loadId"');
		const end = SRC.indexOf("\napp.", at + 10);
		const handler = at > 0 && end > at ? SRC.slice(at, end) : "";
		t(handler.length > 0, "§3 the public tracker handler is found in server.js");
		t(!/rate[\s_-]?con|ratecon\.pdf|documents/i.test(handler), "§3 the public tracker handler names no rate con, PDF route or documents row");
		const tracker = fs.readFileSync(path.join(ROOT, "client", "src", "views", "TrackLoadView.vue"), "utf8");
		t(!/rate[\s_-]?con/i.test(tracker), "§3 TrackLoadView.vue names no rate con");
	}

	// ── §4 nothing on file ───────────────────────────────────────────────────
	{
		const w = await startWorld();
		const r = await w.call(url("7709999"));
		t(r.status === 404 && r.json && r.json.code === "RATECON_NOT_FOUND", `§4 no file anywhere: 404 RATECON_NOT_FOUND (${r.status} ${r.json && r.json.code})`);
		t(r.json && typeof r.json.error === "string" && /no rate con/i.test(r.json.error) && !/\bat \S+:\d+/.test(r.json.error), `§4 ...with a plain message (${r.json && r.json.error})`);
		// A row whose archive file is gone and that has no Drive copy: same 404.
		w.addDoc("7709998", "/uploads/rate-cons/7709998.pdf");
		const g = await w.call(url("7709998"));
		t(g.status === 404 && g.json && g.json.code === "RATECON_NOT_FOUND", `§4 a row whose file is missing, with no Drive copy: 404, not 500 (${g.status})`);
		await w.close();
	}

	// ── §5 Drive down / not configured ───────────────────────────────────────
	for (const mode of ["down", "network"]) {
		const w = await startWorld({ driveMode: mode });
		const r = await w.call(url("7709999"));
		t(r.status === 503 && r.json && typeof r.json.error === "string" && r.json.error.length > 0, `§5 Drive ${mode}, nothing local: 503 with a plain message (${r.status})`);
		fs.writeFileSync(path.join(w.rateconDir, "7700123.pdf"), BYTES.local);
		w.addDoc("7700123", "/uploads/rate-cons/7700123.pdf");
		const l = await w.call(url("7700123"));
		t(l.status === 503 && !isPdfBody(l), `§5 Drive ${mode} with an older local copy: 503, the local copy is not served in its place (${l.status})`);
		t(w.log.logs.some((s) => /drive/i.test(s)), `§5 Drive ${mode}: the failure is logged, not swallowed`);
		await w.close();
	}
	{
		const w = await startWorld({ folderId: "" });
		fs.writeFileSync(path.join(w.rateconDir, "7700123.pdf"), BYTES.local);
		w.addDoc("7700123", "/uploads/rate-cons/7700123.pdf");
		const r = await w.call(url("7700123"));
		t(r.status === 200 && r.body.equals(BYTES.local), `§5 no Drive folder configured: the local copy is served (${r.status})`);
		t(w.log.lists === 0, "§5 ...without listing anything");
		const n = await w.call(url("7709999"));
		t(n.status === 404 && n.json && n.json.code === "RATECON_NOT_FOUND", `§5 no Drive folder configured and nothing local: 404 RATECON_NOT_FOUND (${n.status} ${n.json && n.json.code})`);
		await w.close();
	}
	{
		const w = await startWorld({ replicaOff: true });
		fs.writeFileSync(path.join(w.rateconDir, "7700123.pdf"), BYTES.local);
		w.addDoc("7700123", "/uploads/rate-cons/7700123.pdf");
		const r = await w.call(url("7700123"));
		t(r.status === 200 && r.body.equals(BYTES.local), `§5 a local replica (Drive off by design) serves its archive copy (${r.status})`);
		const n = await w.call(url("7709999"));
		t(n.status === 404 && n.json && n.json.code === "RATECON_NOT_FOUND", `§5 a local replica with nothing local: 404 RATECON_NOT_FOUND, not 503 (${n.status} ${n.json && n.json.code})`);
		await w.close();
	}

	// ── §6 not a PDF / too large ─────────────────────────────────────────────
	{
		const w = await startWorld();
		const h = await w.call(url("7700400"));
		t(h.status === 422 && h.json && h.json.code === "RATECON_NOT_PDF" && !isPdfBody(h), `§6 a stored file that is not a PDF: 422 RATECON_NOT_PDF, nothing served (${h.status})`);
		fs.writeFileSync(path.join(w.rateconDir, "7700800.pdf"), BYTES.notPdf);
		w.addDoc("7700800", "/uploads/rate-cons/7700800.pdf");
		const lh = await w.call(url("7700800"));
		t(lh.status === 422 && lh.json && lh.json.code === "RATECON_NOT_PDF", `§6 ...a local one too (${lh.status})`);
		const big = await w.call(url("7700300"));
		t(big.status === 413 && big.json && big.json.code === "RATECON_TOO_LARGE", `§6 a file listed over 15 MB: 413 RATECON_TOO_LARGE (${big.status})`);
		t(!w.log.media.includes("drv-big-7700300-eeee"), "§6 ...refused before any download");
		await w.close();
	}

	// ── §7 matching ──────────────────────────────────────────────────────────
	if (rcIndex && typeof rcIndex.filenameCarriesLoadIdBounded === "function") {
		const m = rcIndex.filenameCarriesLoadIdBounded;
		t(m("Subject: Load #7700123 Rate Confirmation.pdf", "7700123"), "§7 matcher: set off by '#' and spaces");
		t(m("7700123-ratecon.pdf", "#7700123"), "§7 matcher: a leading '#' on the ID is ignored; '-' is a boundary");
		t(!m("Re: Load 77001234 rate con.pdf", "7700123"), "§7 matcher: a longer number containing the ID does not match");
		t(!m("Load 17700123.pdf", "7700123"), "§7 matcher: a digit before the ID does not match");
		t(!m("LD7700123 confirmation.pdf", "7700123"), "§7 matcher: a letter before the ID does not match");
		t(m("Rate con ld-mp4w4lp1.pdf", "LD-MP4W4LP1"), "§7 matcher: a punctuated ID matches in another letter case");
		t(!m("Rate con LD-MP4W4LP12.pdf", "LD-MP4W4LP1"), "§7 matcher: ...and not inside a longer ID");
		t(!m("", "7700123") && !m("7700123.pdf", "") && !m("7700123.pdf", "#"), "§7 matcher: empty name or ID never matches");
		t(m("x 7700123 y 77001234", "7700123"), "§7 matcher: a later bounded occurrence still matches after an unbounded one");
		t(!m("Load 7700123-2 rate con.pdf", "7700123") && !m("7700123_2.pdf", "7700123") && !m("7700123.1.pdf", "7700123"), "§7 matcher: '-', '_' or '.' then a digit continues the ID (7700123-2 is another load)");
		t(!m("Load 2-7700123.pdf", "7700123"), "§7 matcher: ...on the leading side too");
		t(m("7700123.pdf", "7700123") && m("Order 7700123-$700 ADV.pdf", "7700123") && m("7700123_ratecon.pdf", "7700123"), "§7 matcher: a separator followed by a non-digit still ends the ID");
	} else {
		t(false, "§7 lib/ratecon-drive-index.js exports filenameCarriesLoadIdBounded()");
	}
	{
		const w = await startWorld();
		const a = await w.call(url("7700123"));
		const b = await w.call(url("#7700123"));
		t(a.status === 200 && b.status === 200 && a.body.equals(b.body), `§7 "7700123" and "#7700123" serve the same file (${a.status}/${b.status})`);
		t(!w.log.media.includes("drv-long-77001234-cc") && !w.log.media.includes("drv-pref-7700123-dd") && !w.log.media.includes("drv-suffix-7700123-2"), "§7 a longer, letter-prefixed or '-2' name is never downloaded for this load (even when newer)");
		t(w.log.lists === LISTING.length, `§7 the folder is listed page by page once, then cached (${w.log.lists} list calls for ${LISTING.length} pages over two requests)`);
		const p2 = await w.call(url("7700600"));
		t(p2.status === 200 && p2.body.equals(BYTES.page2), `§7 a file on the listing's second page is found (${p2.status})`);
		const al = await w.call(url("LD-MP4W4LP1"));
		t(al.status === 200 && al.body.equals(BYTES.alpha), `§7 a punctuated ID finds its file case-insensitively, not the longer ID's (${al.status})`);
		// Stored under "#": a request without it still finds the row.
		w.addDoc("#7700700", "", "drv-docrow-7700700-kk");
		const hr = await w.call(url("7700700"));
		t(hr.status === 200 && hr.body.equals(BYTES.hash), `§7 a documents row stored as "#7700700" is found by "7700700" (${hr.status})`);
		t(w.log.gets.some((g) => g.fileId === "drv-docrow-7700700-kk" && g.alt !== "media"), "§7 ...its Drive size is checked before the download");
		await w.close();
	}

	// ── §8 no path from the request ──────────────────────────────────────────
	{
		const w = await startWorld();
		for (const bad of ["..", "../../app.db", "a/../../b", "#1/../x", "x".repeat(41), "lö123", ".hidden"]) {
			reads.length = 0;
			const r = await w.call(`/api/loads/${encodeURIComponent(bad)}/ratecon.pdf`);
			t((r.status === 400 || r.status === 404) && !isPdfBody(r), `§8 load ID ${JSON.stringify(bad.length > 20 ? bad.slice(0, 8) + "…" : bad)} is refused (${r.status})`);
			t(!reads.some((p) => p.startsWith(w.tmp)), `§8 ...with no file read (${JSON.stringify(bad.slice(0, 12))})`);
		}
		w.addDoc("7700900", "/uploads/rate-cons/../../secret.pdf", "", "2026-09-30 12:00:00", "../secret.pdf");
		w.addDoc("7700900", "/uploads/../secret.pdf", "", "2026-09-30 12:00:00");
		w.addDoc("7700900", "/uploads/sub/nested.pdf", "", "2026-09-30 12:00:00");
		w.addDoc("7700900", "/elsewhere/7700900.pdf", "", "2026-09-30 12:00:00");
		reads.length = 0;
		const p = await w.call(url("7700900"));
		t(p.status === 404 && !isPdfBody(p), `§8 poisoned documents rows ("..", a subfolder, another root) are skipped, not served (${p.status})`);
		t(!reads.some((r) => r.endsWith("secret.pdf") || r.endsWith("nested.pdf")), "§8 ...and the files they name are never opened");
		t(w.log.logs.filter((s) => /skip/i.test(s)).length >= 4, "§8 ...and each skip is logged");
		await w.close();
	}
	{
		// A rate con a Super Admin uploaded through POST /api/documents/upload:
		// stored directly under uploads/, type RATECON.
		const w = await startWorld({ folderId: "" });
		fs.writeFileSync(path.join(w.uploadsDir, "7700950_RATECON_1760000000000.pdf"), BYTES.local);
		w.addDoc("7700950", "/uploads/7700950_RATECON_1760000000000.pdf", "", "2026-09-30 12:00:00", "7700950_RATECON_1760000000000.pdf");
		const u = await w.call(url("7700950"));
		t(u.status === 200 && u.body.equals(BYTES.local), `§8 an uploaded rate con under uploads/ is served (${u.status})`);
		await w.close();
	}
	{
		// The documents type is what keeps every other upload out: a POD and a
		// BOL stored directly under uploads/ for the same load are passed over,
		// even when newer than the rate con.
		const w = await startWorld({ folderId: "" });
		const POD = pdf("a proof of delivery");
		const BOL = pdf("a bill of lading");
		fs.writeFileSync(path.join(w.uploadsDir, "7700960_POD_1760000000001.pdf"), POD);
		fs.writeFileSync(path.join(w.uploadsDir, "7700960_BOL_1760000000002.pdf"), BOL);
		w.addDoc("7700960", "/uploads/7700960_POD_1760000000001.pdf", "", "2026-10-01 12:00:00", "7700960_POD_1760000000001.pdf", "POD");
		w.addDoc("7700960", "/uploads/7700960_BOL_1760000000002.pdf", "", "2026-10-02 12:00:00", "7700960_BOL_1760000000002.pdf", "BOL");
		reads.length = 0;
		const only = await w.call(url("7700960"));
		t(only.status === 404 && only.json && only.json.code === "RATECON_NOT_FOUND" && !isPdfBody(only), `§8 a POD and a BOL under uploads/ are not rate cons: 404 RATECON_NOT_FOUND (${only.status} ${only.json && only.json.code})`);
		t(!reads.some((p) => /_(POD|BOL)_/.test(p)), "§8 ...and neither file is opened");
		fs.writeFileSync(path.join(w.uploadsDir, "7700960_RATECON_1760000000000.pdf"), BYTES.local);
		w.addDoc("7700960", "/uploads/7700960_RATECON_1760000000000.pdf", "", "2026-09-30 12:00:00", "7700960_RATECON_1760000000000.pdf");
		const rc = await w.call(url("7700960"));
		t(rc.status === 200 && rc.body.equals(BYTES.local), `§8 with a RATECON row beside them, the rate con is served, never the newer POD or BOL (${rc.status})`);
		await w.close();
	}

	// ── §9 route order and gate ──────────────────────────────────────────────
	{
		const mounts = SRC.split("\n").filter((l) => /require\("\.\/lib\/ratecon-pdf-route"\)\.mount\(app,/.test(l));
		t(mounts.length === 1, `§9 server.js mounts lib/ratecon-pdf-route.js with one line (${mounts.length})`);
		const at = SRC.indexOf('require("./lib/ratecon-pdf-route").mount(app,');
		const catchAll = SRC.indexOf('\napp.get("*"');
		t(at > 0 && catchAll > 0 && at < catchAll, "§9 ...above the SPA catch-all app.get(\"*\")");
		const kpi = SRC.indexOf("// KPI BOT —");
		t(at > 0 && kpi > 0 && at < kpi, "§9 ...and outside the KPI block the KPI runners lift");
		t(!/app\.(get|use)\(["']\/api\/loads\/:loadId\/ratecon/.test(SRC), "§9 server.js registers no second copy of the route itself");
		const w = await startWorld();
		const layer = (w.app._router && w.app._router.stack || []).find((l) => l.route && l.route.path === "/api/loads/:loadId/ratecon.pdf");
		const first = layer && layer.route.stack[0] && layer.route.stack[0].handle;
		t(!!layer && layer.route.methods.get === true, "§9 the route is a GET");
		t(!!first && Array.isArray(first.__roles) && first.__roles.length === 1 && first.__roles[0] === "Super Admin", "§9 ...whose first handler is requireRole(\"Super Admin\")");
		const second = layer && layer.route.stack[1] && layer.route.stack[1].handle;
		t(!!layer && layer.route.stack.length === 3 && !!second && !second.__roles, `§9 ...then the rate limiter, then the handler (${layer ? layer.route.stack.length : 0} handlers)`);
		await w.close();
	}

	// ── §10 the rate limiter: after the role gate ────────────────────────────
	{
		const w = await startWorld();
		const limit = routeModule && routeModule.RATE_LIMIT;
		t(limit === 60, `§10 60 requests per window (${limit})`);
		let refused = 0;
		for (let i = 0; i < 70; i++) if ((await w.call(url("7709999"), { user: USERS.Dispatcher })).status === 403) refused++;
		for (let i = 0; i < 5; i++) if ((await w.call(url("7709999"), { user: null })).status === 401) refused++;
		t(refused === 75, `§10 refused callers stay refused (${refused}/75)`);
		let served = 0;
		for (let i = 0; i < (limit || 60); i++) if ((await w.call(url("7709999"))).status === 404) served++;
		t(served === (limit || 60), `§10 ...and spent none of the budget: a Super Admin still gets ${limit} answers (${served})`);
		const over = await w.call(url("7709999"));
		t(over.status === 429 && over.json && over.json.code === "RATECON_RATE_LIMITED", `§10 the next request is 429 RATECON_RATE_LIMITED (${over.status})`);
		await w.close();
	}
}

main()
	.catch((e) => { failures.push(`runner threw: ${e && e.stack || e}`); console.log(`  FAIL  runner threw: ${e && e.stack || e}`); })
	.finally(() => {
		fs.promises.readFile = origReadFile;
		fs.promises.stat = origStat;
		fs.readFileSync = origReadFileSync;
		console.log(`\nratecon-pdf-route: ${pass} passed, ${failures.length} failed`);
		process.exit(failures.length ? 1 : 0);
	});
