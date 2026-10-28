#!/usr/bin/env node
/**
 * scripts/test-chat-attachment-access.js — who may open a chat attachment, and
 * what copy they get.
 *
 * The rule (owner request, 2026-10-21, with the photo viewer in Messages): a
 * photo in a message is served only to people who can see that conversation,
 * and without location data (the rule receipts follow since 2026-10-15: EXIF
 * stripped from new uploads and from every served copy).
 *
 *   §1 chatAttachmentAccess() (lib/chat-files.js): Super Admin reads every
 *      thread; a Dispatcher every thread but an investor conversation's (the
 *      row marked by server.js INVESTOR_CHAT_SQL; a row without the mark is
 *      refused); a Driver the messages from or to his driver name; an
 *      Investor those from or to his username; the first message naming a file
 *      decides; nobody else, and no file no message names
 *   §2 chatUploadBytes(): a new photo is stored without metadata, orientation
 *      kept; a PDF as it is; a photo the strip cannot walk is refused
 *   §3 the guard on a real Express app over a temp uploads/chat/: a
 *      participant gets the photo stripped, nosniff, never cached by a shared
 *      cache; a non-participant, another role, a file no message names and a
 *      write are 404; a PDF goes on to the static mount; an unwalkable photo is
 *      not served
 *   §4 server.js: every /uploads mount, uploadsPathGuard and
 *      GUARDED_UPLOAD_DIRS, LIFTED and run: /uploads/chat/ answers by the rule
 *      above for every path spelling; POST /api/chat/attachment (lifted with
 *      what it reaches) stores a photo without its GPS block; the driver's
 *      thread (GET /api/driver/:driverName) carries attachment_url and
 *      attachment_type
 *
 * FIXTURES: an in-memory SQLite, a header-driven session, stubs for the other
 * directory guards. Made-up names and images only.
 * Run: node scripts/test-chat-attachment-access.js
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const Database = require("better-sqlite3");
const fx = require("./lib/exif-fixtures");
const { closure } = require("./lib/server-lift");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

let chatFiles = null;
try { chatFiles = require("../lib/chat-files"); } catch (err) { ok(`lib/chat-files.js loads (${err.message})`, false); }

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const DRIVER_A = "Tamsin Vale";
const DRIVER_B = "Orrin Cade";
const INVESTOR = "inv_t";
const F = {
	A_JPG: "chat_1788000000001_aaaaa.jpg",     // Dispatch -> Driver A, GPS EXIF
	A_PNG: "chat_1788000000002_bbbbb.png",     // Driver A -> Dispatch, PNG with metadata
	A_PDF: "chat_1788000000003_ccccc.pdf",     // Dispatch -> Driver A, a PDF
	B_JPG: "chat_1788000000004_ddddd.jpg",     // Dispatch -> Driver B
	INV_JPG: "chat_1788000000005_eeeee.jpg",   // investor -> admin
	ORPHAN: "chat_1788000000006_fffff.jpg",    // uploaded, never sent
	A_BROKEN: "chat_1788000000007_ggggg.jpg",  // Dispatch -> Driver A, cut inside its metadata
	CASED: "chat_1788000000008_hhhhh.jpg",     // first named (other spelling) to Driver B, then by Driver A
};
const U = {
	sa: { id: 1, role: "Super Admin", username: "admin_t" },
	disp: { id: 2, role: "Dispatcher", username: "dispatch_t" },
	drvA: { id: 10, role: "Driver", username: "drv_a", driverName: DRIVER_A },
	drvAcase: { id: 10, role: "Driver", username: "drv_a", driverName: " tamsin vale " },
	drvB: { id: 11, role: "Driver", username: "drv_b", driverName: DRIVER_B },
	drvBlank: { id: 12, role: "Driver", username: "drv_blank", driverName: "" },
	inv: { id: 50, role: "Investor", username: INVESTOR },
	invOther: { id: 51, role: "Investor", username: "inv_u" },
	odd: { id: 60, role: "Auditor", username: "odd_t" },
};
const C = (name) => `/uploads/chat/${name}`;

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, "from" TEXT, "to" TEXT, message TEXT DEFAULT '',
		load_id TEXT DEFAULT '', read INTEGER DEFAULT 0, attachment_url TEXT DEFAULT '', attachment_type TEXT DEFAULT '', asset_ref TEXT DEFAULT '')`);
	const add = (from, to, file, type = "image") => db.prepare(`INSERT INTO messages (timestamp, "from", "to", attachment_url, attachment_type) VALUES ('2026-10-20T13:00:00.000Z', ?, ?, ?, ?)`)
		.run(from, to, file ? C(file) : "", file ? type : "").lastInsertRowid;
	add("Dispatch", DRIVER_A, F.A_JPG);          // 1
	add(DRIVER_A, "Dispatch", F.A_PNG);          // 2
	add("Dispatch", DRIVER_A, F.A_PDF, "pdf");   // 3
	add("Dispatch", DRIVER_B, F.B_JPG);          // 4
	add(INVESTOR, "admin", F.INV_JPG);           // 5
	add(DRIVER_B, "Dispatch", F.A_JPG);          // 6: a later message naming Driver A's file
	add("Dispatch", DRIVER_A, F.A_BROKEN);       // 7
	db.prepare(`INSERT INTO messages (timestamp, "from", "to", attachment_url, attachment_type) VALUES ('2026-10-20T13:00:00.000Z', 'Dispatch', ?, ?, 'image')`)
		.run(DRIVER_B, `/uploads/CHAT/${F.CASED}`);  // 8: the same file, another spelling, Driver B's thread
	add(DRIVER_A, "Dispatch", F.CASED);          // 9: later, Driver A names it as stored
	if (chatFiles && chatFiles.CHAT_UPLOADS_SCHEMA_SQL) db.exec(chatFiles.CHAT_UPLOADS_SCHEMA_SQL);
	// The accounts: who is an Investor marks a row as an investor conversation's.
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, driver_name TEXT DEFAULT '')");
	const user = db.prepare("INSERT OR IGNORE INTO users (id, username, role, driver_name) VALUES (?, ?, ?, ?)");
	for (const u of Object.values(U)) user.run(u.id, u.username, u.role, u.driverName || "");
	return db;
}
// Each row as the guard reads it: marked investor_chat by server.js's rule.
const rowsFor = (db, file) => db.prepare(`SELECT id, "from", "to", ${INVESTOR_CHAT_SQL_TEXT || "NULL"} AS investor_chat FROM messages WHERE attachment_url = ?`).all(C(file));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "chat-attachment-access-"));
const UP = path.join(TMP, "uploads");
const CHAT_DIR = path.join(UP, "chat");
let IMG;

function writeTree() {
	fs.mkdirSync(CHAT_DIR, { recursive: true });
	fs.writeFileSync(path.join(CHAT_DIR, F.A_JPG), IMG.gpsJpg);
	fs.writeFileSync(path.join(CHAT_DIR, F.A_PNG), IMG.png);
	fs.writeFileSync(path.join(CHAT_DIR, F.A_PDF), IMG.pdf);
	fs.writeFileSync(path.join(CHAT_DIR, F.B_JPG), IMG.gpsJpg);
	fs.writeFileSync(path.join(CHAT_DIR, F.INV_JPG), IMG.gpsJpg);
	fs.writeFileSync(path.join(CHAT_DIR, F.ORPHAN), IMG.gpsJpg);
	fs.writeFileSync(path.join(CHAT_DIR, F.A_BROKEN), IMG.broken);
	fs.writeFileSync(path.join(CHAT_DIR, F.CASED), IMG.gpsJpg);
}

const agent = new http.Agent({ keepAlive: false });
const servers = [];
function sessionApp() {
	const app = express();
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	return app;
}
const requireAuth = (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: "Not authenticated" }));
const requireRole = (...roles) => (req, res, next) => {
	const u = req.session.user;
	if (!u) return res.status(401).json({ error: "Not authenticated" });
	if (!roles.includes(u.role)) return res.status(403).json({ error: "Forbidden" });
	next();
};
async function listen(app) {
	app.get("*", (req, res) => res.status(200).send("<html>SPA-CATCH-ALL</html>"));
	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	const port = server.address().port;
	return (urlPath, user, { method = "GET", body = null } = {}) => new Promise((resolve, reject) => {
		const payload = body ? Buffer.from(JSON.stringify(body)) : null;
		const req = http.request({
			host: "127.0.0.1", port, method, path: urlPath, agent,
			headers: {
				...(user ? { "x-test-user": JSON.stringify(user) } : {}),
				...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
			},
		}, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end(payload || undefined);
	});
}

const isImage = (r) => r.status === 200 && /^image\//.test(String(r.headers["content-type"] || "")) && r.body.length > 0;
const clean = (r) => !fx.hasGpsTag(r.body) && fx.surviving(r.body).length === 0;
const refused = (r) => r.status === 404 && r.body.length === 0;

// ---------------------------------------------------------------------------
// Lifting server.js (same scanner as test-receipt-image-access.js)
// ---------------------------------------------------------------------------
const SRC = require("./lib/server-source").serverSource();
function skipString(i) {
	const q = SRC[i];
	for (i++; i < SRC.length && SRC[i] !== q; i++) if (SRC[i] === "\\") i++;
	return i;
}
function closeOf(open) {
	const want = { "(": ")", "[": "]", "{": "}" };
	const stack = [];
	for (let i = open; i < SRC.length; i++) {
		const c = SRC[i], n = SRC[i + 1];
		if (c === "/" && n === "/") { i = SRC.indexOf("\n", i); continue; }
		if (c === "/" && n === "*") { i = SRC.indexOf("*/", i) + 1; continue; }
		if (c === '"' || c === "'" || c === "`") { i = skipString(i); continue; }
		if (want[c]) stack.push(want[c]);
		else if (c === ")" || c === "]" || c === "}") {
			if (stack.pop() !== c) die(`unbalanced ${c} at offset ${i}`);
			if (!stack.length) return i + 1;
		}
	}
	die("unterminated bracket");
}
function statementFrom(at) {
	for (let i = at; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === "(" || c === "[" || c === "{") { i = closeOf(i) - 1; continue; }
		if (c === '"' || c === "'" || c === "`") { i = skipString(i); continue; }
		if (c === ";") return SRC.slice(at, i + 1);
	}
	die("unterminated statement");
}
function liftFn(name, { optional = false } = {}) {
	for (const prefix of ["\nasync function ", "\nfunction "]) {
		const at = SRC.indexOf(`${prefix}${name}(`);
		if (at < 0) continue;
		const bodyOpen = SRC.indexOf("{", closeOf(SRC.indexOf("(", at + prefix.length)));
		return SRC.slice(at + 1, closeOf(bodyOpen));
	}
	if (optional) return "";
	die(`could not locate function ${name} in server.js`);
}
function liftConst(name, { optional = false } = {}) {
	const at = SRC.indexOf(`\nconst ${name} =`);
	if (at < 0) { if (optional) return ""; die(`could not locate const ${name} in server.js`); }
	return statementFrom(at + 1);
}
function liftStatements(needle) {
	const out = [];
	for (let at = SRC.indexOf(needle); at >= 0; at = SRC.indexOf(needle, at + 1)) out.push(statementFrom(at + 1));
	return out;
}

const L = {
	consts: ["INLINE_SAFE_UPLOAD_EXTS", "UPLOAD_MISS_WINDOW_MS", "UPLOAD_MISS_MAX", "UPLOAD_MISS_BURST_MAX", "UPLOAD_MISS_KEYS_MAX", "uploadMissCounts", "INVESTOR_CHAT_SQL"].map((n) => liftConst(n)),
	// The chat guard's wiring, when server.js has it.
	chatGuardConst: liftConst("chatAttachmentGuard", { optional: true }),
	chatGuardFn: liftFn("guardChatAttachment", { optional: true }),
	guardedDirs: liftConst("GUARDED_UPLOAD_DIRS"),
	fns: ["normalizedUploadPath", "uploadMissLimiter", "uploadsPathGuard"].map((n) => liftFn(n)),
	mounts: liftStatements('\napp.use("/uploads'),
};
// The investor-conversation rule the guard is built with (INVESTOR CONVERSATIONS
// ARE SUPER ADMIN ONLY), as server.js declares it.
const INVESTOR_CHAT_SQL_TEXT = new Function(`${L.consts[L.consts.length - 1]}\nreturn INVESTOR_CHAT_SQL;`)();
ok(`lifted every /uploads mount from server.js (${L.mounts.length})`, L.mounts.length === 4);
ok("server.js wires a chat guard (chatAttachmentGuard + guardChatAttachment)", !!L.chatGuardConst && !!L.chatGuardFn);
ok("GUARDED_UPLOAD_DIRS routes /chat/ to it", /\{\s*dir:\s*"\/chat\/",\s*guard:\s*guardChatAttachment\s*\}/.test(L.guardedDirs));

async function buildServer(db) {
	const app = sessionApp();
	const stub = (name) => (req, res) => { res.setHeader("X-Test-Guard", name); res.status(404).end(); };
	const logs = [];
	const fakeConsole = { log() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
	const body = ['"use strict";', ...L.consts, ...L.fns, L.chatGuardConst, L.chatGuardFn, L.guardedDirs, ...L.mounts].join("\n");
	new Function(
		"app", "express", "path", "fs", "DATA_DIR", "db", "requireAuth", "requireRole", "chatFiles", "console",
		"guardDriverSignedDoc", "guardInvestorSignedDoc", "guardInvoicePdf", "guardExpenseReceipt", "guardDrugTestFile", "guardRootLoadDocument",
		body,
	)(app, express, path, fs, TMP, db, requireAuth, requireRole, chatFiles, fakeConsole,
		stub("guardDriverSignedDoc"), stub("guardInvestorSignedDoc"), stub("guardInvoicePdf"), stub("guardExpenseReceipt"),
		stub("guardDrugTestFile"), stub("guardRootLoadDocument"));
	return { get: await listen(app), logs };
}

// POST /api/chat/attachment with every declaration it reaches.
const UPLOAD_HEAD = 'app.post("/api/chat/attachment", requireAuth, chatAttachmentLimiter, async (req, res) => {';
// ...and POST /api/messages, on the same database. The socket and notification
// side effects are stubs; the route's own checks run as shipped.
const MESSAGES_HEAD = 'app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {';
async function buildUpload(dataDir, db) {
	const lifted = closure(SRC, {
		roots: [],
		routes: [UPLOAD_HEAD, MESSAGES_HEAD],
		provided: ["app", "express", "path", "fs", "DATA_DIR", "db", "requireAuth", "chatAttachmentLimiter", "driverWriteLimiter", "chatFiles", "console", "require",
			"insertNotification", "io", "chatRooms", "shownLoadId", "emitDispatchByRole"],
		denied: ["server", "httpServer"],
	}).text;
	const app = sessionApp();
	app.use(express.json({ limit: "20mb" }));
	const passThrough = (req, res, next) => next();
	const io = { to: () => ({ emit() {}, except: () => ({ emit() {} }) }) };
	new Function("app", "express", "path", "fs", "DATA_DIR", "db", "requireAuth", "chatAttachmentLimiter", "driverWriteLimiter", "chatFiles", "console", "require",
		"insertNotification", "io", "chatRooms", "shownLoadId", "emitDispatchByRole", `"use strict";\n${lifted}`)(
		app, express, path, fs, dataDir, db, requireAuth, passThrough, passThrough, chatFiles, { log() {}, warn() {}, error() {} }, require,
		{ run: () => ({ lastInsertRowid: 1 }) }, io, () => [], (who, raw) => raw, () => {});
	return listen(app);
}

(async () => {
	const base = await fx.cleanImages();
	IMG = {
		gpsJpg: fx.jpegWithMetadata(base.jpeg, { orientation: 6 }),
		png: fx.pngWithMetadata(base.png, { orientation: 6 }),
		pdf: Buffer.from("%PDF-1.4\n% made-up attachment\n%%EOF\n", "latin1"),
		broken: fx.jpegWithMetadata(base.jpeg).subarray(0, 40),
	};
	ok("fixtures: the photo carries a GPS block and every marker", fx.hasGpsTag(IMG.gpsJpg) && fx.surviving(IMG.gpsJpg).length > 0);
	writeTree();
	const db = makeDb();

	// §1 the rule
	if (chatFiles) {
		const A = chatFiles.chatAttachmentAccess;
		const a = rowsFor(db, F.A_JPG);
		ok("§1 Super Admin opens any thread's file", A(U.sa, a) === true && A(U.sa, rowsFor(db, F.INV_JPG)) === true);
		ok("§1 a Dispatcher opens a driver thread's file", A(U.disp, a) === true && A(U.disp, rowsFor(db, F.B_JPG)) === true);
		ok("§1 a Dispatcher is refused an investor conversation's file", A(U.disp, rowsFor(db, F.INV_JPG)) === false);
		ok("§1 a Dispatcher is refused a row the guard did not mark", A(U.disp, a.map(({ investor_chat: _i, ...r }) => r)) === false);
		ok("§1 the driver the message was sent to opens it", A(U.drvA, a) === true);
		ok("§1 ...under a case / edge-space variant of his name", A(U.drvAcase, a) === true);
		ok("§1 the driver who sent one opens it", A(U.drvA, rowsFor(db, F.A_PNG)) === true);
		ok("§1 another driver is refused, though a later message of his names the file (the first message decides)", A(U.drvB, a) === false);
		ok("§1 a driver with no driver name is refused", A(U.drvBlank, a) === false);
		ok("§1 the investor in the thread opens it; another investor is refused", A(U.inv, rowsFor(db, F.INV_JPG)) === true && A(U.invOther, rowsFor(db, F.INV_JPG)) === false);
		ok("§1 an investor cannot open a driver's thread file, nor a driver an investor's", A(U.inv, a) === false && A(U.drvA, rowsFor(db, F.INV_JPG)) === false);
		ok("§1 any other role, or no user, is refused", A(U.odd, a) === false && A(null, a) === false);
		ok("§1 a file no message names is refused to everyone, staff included", A(U.sa, []) === false && A(U.drvA, rowsFor(db, F.ORPHAN)) === false);
	}

	// §2 the stored copy
	if (chatFiles) {
		const stored = chatFiles.chatUploadBytes(IMG.gpsJpg);
		ok("§2 a new photo is stored without GPS, EXIF text, XMP, IPTC, comment or trailing bytes", !!stored && !fx.hasGpsTag(stored) && fx.surviving(stored).length === 0);
		ok("§2 ...with its orientation kept", !!stored && fx.orientationOf(stored) === 6);
		const png = chatFiles.chatUploadBytes(IMG.png);
		ok("§2 a PNG too", !!png && fx.surviving(png).length === 0);
		ok("§2 a PDF is stored as it is", chatFiles.chatUploadBytes(IMG.pdf) === IMG.pdf);
		ok("§2 a photo the strip cannot walk is refused", chatFiles.chatUploadBytes(IMG.broken) === null);
		ok("§2 nothing to store is refused", chatFiles.chatUploadBytes(Buffer.alloc(0)) === null && chatFiles.chatUploadBytes(null) === null);
	}

	// §3 the guard, mounted the way GUARDED_UPLOAD_DIRS calls it
	if (chatFiles) {
		const logs = [];
		const guard = chatFiles.createChatAttachmentGuard({ db, chatDir: CHAT_DIR, investorChatSql: INVESTOR_CHAT_SQL_TEXT, logError: (m) => logs.push(m) });
		const app = sessionApp();
		// The test route sits behind a rate limiter like every route in server.js;
		// its ceiling is far above any burst below, so it never answers here.
		const rateLimit = require("express-rate-limit");
		const testRouteLimiter = rateLimit({ windowMs: 60_000, limit: 100_000, standardHeaders: false, legacyHeaders: false });
		app.use("/uploads/chat", testRouteLimiter, requireAuth, (req, res, next) => guard(req, res, next, `/uploads/chat${req.path}`, req.path.slice(1)));
		app.use("/uploads", requireAuth, express.static(UP));
		app.use("/uploads", requireAuth, (req, res) => res.status(404).end());
		const get = await listen(app);
		const sa = await get(C(F.A_JPG), U.sa);
		ok("§3 Super Admin opens a thread photo", isImage(sa));
		ok("§3 ...and the copy has no GPS, EXIF text, XMP, IPTC, comment or trailing bytes", isImage(sa) && clean(sa));
		ok("§3 ...orientation kept", isImage(sa) && fx.orientationOf(sa.body) === 6);
		ok("§3 ...never cached by a shared cache, sent nosniff", /private/.test(String(sa.headers["cache-control"] || "")) && sa.headers["x-content-type-options"] === "nosniff");
		const own = await get(C(F.A_JPG), U.drvA);
		ok("§3 the driver in the thread opens it, stripped", isImage(own) && clean(own));
		const sent = await get(C(F.A_PNG), U.drvA);
		ok("§3 the driver's own photo (a PNG) opens, stripped", isImage(sent) && clean(sent) && sent.headers["content-type"] === "image/png");
		ok("§3 a Dispatcher is refused an investor thread's photo (404, empty)", refused(await get(C(F.INV_JPG), U.disp)));
		const disp = await get(C(F.B_JPG), U.disp);
		ok("§3 a Dispatcher opens a driver thread's photo, stripped", isImage(disp) && clean(disp));
		ok("§3 another driver is refused (404, empty)", refused(await get(C(F.A_JPG), U.drvB)));
		ok("§3 an investor outside the thread is refused", refused(await get(C(F.A_JPG), U.inv)));
		ok("§3 the investor in the thread opens it", isImage(await get(C(F.INV_JPG), U.inv)));
		ok("§3 any other role is refused", refused(await get(C(F.A_JPG), U.odd)));
		ok("§3 signed out: 401", (await get(C(F.A_JPG), null)).status === 401);
		ok("§3 a file no message names is refused, staff included", refused(await get(C(F.ORPHAN), U.sa)));
		ok("§3 a name that is not on disk is 404", refused(await get(C("chat_1788000000099_zzzzz.jpg"), U.sa)));
		const pdf = await get(C(F.A_PDF), U.drvA);
		ok("§3 a PDF in the thread goes on to the static mount, as stored", pdf.status === 200 && pdf.body.equals(IMG.pdf));
		ok("§3 a PDF outside the thread is refused", refused(await get(C(F.A_PDF), U.drvB)));
		ok("§3 a photo the strip cannot walk is not served (never as it is)", refused(await get(C(F.A_BROKEN), U.sa)) && logs.some((l) => /not served/.test(l)));
		ok("§3 HEAD answers like GET, with no body", (await get(C(F.A_JPG), U.drvA, { method: "HEAD" })).status === 200);
		ok("§3 a write is 404", refused(await get(C(F.A_JPG), U.sa, { method: "POST" })));
		ok("§3 the earliest message naming a file decides, whatever its spelling: Driver A is refused", refused(await get(C(F.CASED), U.drvA)));
		ok("§3 ...and the driver of that earliest message opens it", isImage(await get(C(F.CASED), U.drvB)));
		ok("§3 a PDF goes out never cached by a shared cache (private, no-store)", (await get(C(F.A_PDF), U.drvA)).headers["cache-control"] === "private, no-store");

		// A guard built without the rule marks no row: a Dispatcher opens nothing.
		const bare = chatFiles.createChatAttachmentGuard({ db, chatDir: CHAT_DIR });
		const app2 = sessionApp();
		app2.use("/uploads/chat", testRouteLimiter, requireAuth, (req, res, next) => bare(req, res, next, `/uploads/chat${req.path}`, req.path.slice(1)));
		app2.use("/uploads", requireAuth, (req, res) => res.status(404).end());
		const get2 = await listen(app2);
		ok("§3 a guard built without the rule refuses a Dispatcher a driver thread's photo", refused(await get2(C(F.B_JPG), U.disp)));
		ok("§3 ...and still serves a Super Admin", isImage(await get2(C(F.B_JPG), U.sa)));
	}

	// §2b which file a message may carry
	if (chatFiles && typeof chatFiles.chatAttachmentRefusal === "function") {
		const R = chatFiles.chatAttachmentRefusal;
		const mine = "/uploads/chat/chat_1788000000100_mmmmm.jpg";
		const theirs = "/uploads/chat/chat_1788000000101_ttttt.jpg";
		const rdb = new Database(":memory:");
		rdb.exec(chatFiles.CHAT_UPLOADS_SCHEMA_SQL);
		chatFiles.recordChatUpload(rdb, mine, U.drvA.id);
		chatFiles.recordChatUpload(rdb, theirs, U.drvB.id);
		ok("§2b a message with no attachment is fine", R(rdb, U.drvA, "") === "" && R(rdb, U.drvA, undefined) === "");
		ok("§2b a chat file the same account uploaded is fine", R(rdb, U.drvA, mine) === "");
		ok("§2b another account's upload is refused, staff included", R(rdb, U.drvA, theirs) !== "" && R(rdb, U.sa, theirs) !== "");
		ok("§2b a script URL, another site, data:, a path elsewhere, or a dot-dot path is refused",
			["javascript:alert(1)", "JavaScript:alert(1)", "https://elsewhere.example/a.pdf", "//elsewhere.example/a.pdf", "data:text/html,x",
				"/uploads/invoices/INV-1.pdf", "/uploads/chat/../invoices/INV-1.pdf", `${mine}?x=1`, ` ${mine}`]
				.every((u) => R(rdb, U.drvA, u) !== ""));
		ok("§2b a file no upload recorded is refused", R(rdb, U.sa, "/uploads/chat/chat_1788000000102_nnnnn.jpg") !== "");
		ok("§2b a non-string is refused", R(rdb, U.drvA, { url: mine }) !== "" && R(rdb, U.drvA, 42) !== "");
	} else {
		ok("§2b lib/chat-files.js exports chatAttachmentRefusal, recordChatUpload and CHAT_UPLOADS_SCHEMA_SQL", false);
	}

	// §4 server.js
	{
		const S = await buildServer(db);
		const sa = await S.get(C(F.A_JPG), U.sa);
		ok("§4 /uploads/chat/: Super Admin gets the photo without its GPS block", isImage(sa) && clean(sa));
		const own = await S.get(C(F.A_JPG), U.drvA);
		ok("§4 /uploads/chat/: the driver in the thread gets it without its GPS block", isImage(own) && clean(own));
		ok("§4 /uploads/chat/: another driver is refused", refused(await S.get(C(F.A_JPG), U.drvB)));
		ok("§4 /uploads/chat/: an investor outside the thread is refused", refused(await S.get(C(F.A_JPG), U.inv)));
		ok("§4 /uploads/chat/: a Dispatcher is refused an investor conversation's photo", refused(await S.get(C(F.INV_JPG), U.disp)));
		ok("§4 /uploads/chat/: a Dispatcher gets a driver thread's photo", isImage(await S.get(C(F.B_JPG), U.disp)));
		for (const spelling of [`/uploads/Chat/${F.A_JPG}`, `/uploads/CHAT/${F.A_JPG}`, `/uploads//chat/${F.A_JPG}`, `/uploads/./chat/${F.A_JPG}`, `/uploads/%63hat/${F.A_JPG}`, `/uploads/x/../chat/${F.A_JPG}`]) {
			const r = await S.get(spelling, U.drvB);
			ok(`§4 ${spelling}: another driver is refused`, r.status === 404 && !isImage(r));
		}
		ok("§4 a file no message names is refused", refused(await S.get(C(F.ORPHAN), U.sa)));

		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-upload-"));
		const mdb = makeDb();
		const post = await buildUpload(dataDir, mdb);
		const res = await post("/api/chat/attachment", U.drvA, {
			method: "POST",
			body: { fileName: "IMG_0001.jpg", mimeType: "image/jpeg", fileData: `data:image/jpeg;base64,${IMG.gpsJpg.toString("base64")}` },
		});
		let url = "";
		try { url = JSON.parse(res.body.toString("utf8")).fileUrl || ""; } catch { url = ""; }
		const storedPath = url ? path.join(dataDir, url.replace(/^\//, "")) : "";
		const stored = storedPath && fs.existsSync(storedPath) ? fs.readFileSync(storedPath) : null;
		ok("§4 POST /api/chat/attachment stores the photo", res.status === 200 && !!stored);
		ok("§4 ...without its GPS block or any other metadata", !!stored && !fx.hasGpsTag(stored) && fx.surviving(stored).length === 0);
		const pdfRes = await post("/api/chat/attachment", U.drvA, {
			method: "POST",
			body: { fileName: "note.pdf", mimeType: "application/pdf", fileData: `data:application/pdf;base64,${IMG.pdf.toString("base64")}` },
		});
		ok("§4 ...and a PDF as it is", pdfRes.status === 200);
		let recorded = null;
		try { recorded = url ? mdb.prepare("SELECT user_id FROM chat_uploads WHERE file_url = ?").get(url) : null; } catch { recorded = null; }
		ok("§4 POST /api/chat/attachment records who uploaded the file", !!recorded && recorded.user_id === U.drvA.id);

		// POST /api/messages takes only an attachment the same account uploaded.
		const send = (user, attachmentUrl, attachmentType = "pdf") => post("/api/messages", user, {
			method: "POST", body: { to: "Dispatch", message: "see attached", loadId: "", attachmentUrl, attachmentType },
		});
		const attached = () => mdb.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
		const before = attached();
		for (const bad of ["javascript:alert(document.cookie)", "https://elsewhere.example/invoice.pdf", "//elsewhere.example/x.pdf", "/uploads/invoices/INV-1.pdf"]) {
			const r = await send(U.drvA, bad);
			ok(`§4 POST /api/messages refuses ${bad.slice(0, 30)} as an attachment (400)`, r.status === 400);
		}
		ok("§4 another account's upload is refused (400)", (await send(U.drvB, url, "image")).status === 400);
		ok("§4 ...and none of the refused messages was stored", attached() === before);
		const okSend = await send(U.drvA, url, "image");
		ok("§4 the uploader's own file is sent (200)", okSend.status === 200);
		ok("§4 a message with no attachment is still sent", (await send(U.drvA, "", "")).status === 200);
		fs.rmSync(dataDir, { recursive: true, force: true });

		// The driver's thread: the only route a Driver reads his messages from.
		const at = SRC.indexOf("// Messages from SQLite (fast indexed query)");
		const select = at < 0 ? "" : SRC.slice(at, SRC.indexOf(".all(", at));
		ok("§4 GET /api/driver/:driverName: its messages carry attachment_url and attachment_type", /attachment_url/.test(select) && /attachment_type/.test(select));
	}

	for (const s of servers) s.close();
	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(failed ? `\n${failed} failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
