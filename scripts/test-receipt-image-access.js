#!/usr/bin/env node
/**
 * scripts/test-receipt-image-access.js — who may open an expense receipt image,
 * and what copy they get.
 *
 * The owner's rule (2026-10-15): only the receipt's own driver, Super Admin and
 * the roles that review receipts (approve / reject: Super Admin, Dispatcher)
 * open a receipt image; location (EXIF) data is stripped from new uploads and
 * from every served copy.
 *
 * Covered, per role (Super Admin, Dispatcher, the receipt's driver, another
 * driver, an Investor with no claim on the receipt, an unknown role, signed out):
 *   §1 originals under /uploads/expense-receipts/, every path spelling
 *   §2 cached thumbnails under /uploads/expense-receipts/thumbs/ (the list's
 *      thumbnails come from the API; nothing links to the folder)
 *   §3 GET /api/expenses/:id/receipt-thumbnail (its role gate, and its fallback
 *      to the original, which must also go out stripped)
 *   §4 saveReceiptToDisk(): a new upload is stored without metadata; a stored
 *      path sent as photoData is refused (it would make a second row name
 *      another driver's file)
 *   §5 GET /api/expenses/receipts-download streams stripped copies
 * The Investor who owns the receipt's truck is NOT covered: that view is a
 * pending owner decision.
 *
 * WHAT IS REAL: every /uploads mount in file order, normalizedUploadPath,
 * uploadsPathGuard, GUARDED_UPLOAD_DIRS, uploadMissLimiter and its constants,
 * the receipt guard (when server.js has one), the thumbnail route,
 * saveReceiptToDisk and sniffImageFormat, all LIFTED from server.js, plus
 * lib/receipt-files.js, lib/image-metadata.js and lib/image-size.js; mounted on
 * a real Express app over a temp uploads/ tree and driven over HTTP on
 * 127.0.0.1. FIXTURES: an in-memory SQLite, a header-driven session, stubs for
 * the other directory guards and the uploads-root guard. Made-up names and
 * images only.
 * Run: node scripts/test-receipt-image-access.js
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
const fx = require("./lib/exif-fixtures");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// Lifting (same scanner as test-uploads-root-guard.js)
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
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
	consts: ["INLINE_SAFE_UPLOAD_EXTS", "UPLOAD_MISS_WINDOW_MS", "UPLOAD_MISS_MAX", "UPLOAD_MISS_BURST_MAX", "UPLOAD_MISS_KEYS_MAX",
		"uploadMissCounts", "RECEIPT_IMAGE_EXTS", "MAX_IMAGE_RECEIPT_BYTES", "RECEIPT_OCR_MAX_PIXELS"].map((n) => liftConst(n)),
	// The receipt guard's wiring, when server.js has it (absent on the base).
	receiptGuardConst: liftConst("expenseReceiptGuard", { optional: true }),
	receiptGuardFn: liftFn("guardExpenseReceipt", { optional: true }),
	guardedDirs: liftConst("GUARDED_UPLOAD_DIRS"),
	fns: ["normalizeDriverName", "sniffImageFormat", "normalizedUploadPath", "uploadMissLimiter", "uploadsPathGuard", "saveReceiptToDisk"].map((n) => liftFn(n)),
	mounts: liftStatements('\napp.use("/uploads'),
	thumbRoute: liftStatements('\napp.get("/api/expenses/:id/receipt-thumbnail"')[0],
	// Source text only (read, never run): from its head to the route's closing line.
	zipRoute: ((at) => (at < 0 ? "" : SRC.slice(at, SRC.indexOf("\n});\n", at))))(SRC.indexOf('\napp.get("/api/expenses/receipts-download"')),
};
ok(`lifted every /uploads mount from server.js (${L.mounts.length})`, L.mounts.length === 4);
ok("lifted the thumbnail and ZIP routes", !!L.thumbRoute && !!L.zipRoute);

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const DRIVER_A = "Tamsin Vale";
const DRIVER_B = "Orrin Cade";
const F = {
	A_JPG: "1788000000001-a1a1a1a1a1a1.jpg",     // Driver A's photo receipt, GPS EXIF
	B_JPG: "1788000000002-b2b2b2b2b2b2.jpg",     // Driver B's photo receipt
	A_PDF: "1788000000003-c3c3c3c3c3c3.pdf",     // a PDF receipt filed for Driver A
	ORPHAN: "1788000000004-d4d4d4d4d4d4.jpg",    // a file no row names
	A_UNREADABLE: "1788000000005-e5e5e5e5e5e5.jpg", // A's receipt: readable header, undecodable picture, GPS EXIF
	A_BROKEN: "1788000000006-f6f6f6f6f6f6.jpg",  // A's receipt cut inside its metadata
};
const U = {
	sa: { id: 1, role: "Super Admin", username: "admin_t" },
	disp: { id: 2, role: "Dispatcher", username: "dispatch_t" },
	drvA: { id: 10, role: "Driver", username: "drv_a", driverName: DRIVER_A },
	drvAspaced: { id: 10, role: "Driver", username: "drv_a", driverName: "  tamsin   VALE " },
	drvB: { id: 11, role: "Driver", username: "drv_b", driverName: DRIVER_B },
	drvBlank: { id: 12, role: "Driver", username: "drv_blank", driverName: "" },
	inv: { id: 50, role: "Investor", username: "inv_t" },
	odd: { id: 60, role: "Auditor", username: "odd_t" },
};

let IMG;   // filled in main()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-image-access-"));
const UP = path.join(TMP, "uploads");
const RECEIPTS_DIR = path.join(UP, "expense-receipts");

function writeTree() {
	fs.mkdirSync(path.join(RECEIPTS_DIR, "thumbs"), { recursive: true });
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_JPG), IMG.aJpg);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.B_JPG), IMG.bJpg);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_PDF), IMG.pdf);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.ORPHAN), IMG.bJpg);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_UNREADABLE), IMG.unreadable);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_BROKEN), IMG.broken);
	fs.writeFileSync(path.join(RECEIPTS_DIR, "thumbs", "1.jpg"), IMG.thumb);
	fs.writeFileSync(path.join(RECEIPTS_DIR, "thumbs", "2.jpg"), IMG.thumb);
	fs.mkdirSync(path.join(UP, "chat"), { recursive: true });
	fs.writeFileSync(path.join(UP, "chat", "chat_1_abcde.jpg"), IMG.bJpg);
}

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, type TEXT DEFAULT 'Fuel', amount REAL DEFAULT 10,
		date TEXT DEFAULT '2026-10-01', photo_data TEXT DEFAULT '', load_id TEXT DEFAULT '', description TEXT DEFAULT '',
		gallons REAL DEFAULT 0, odometer REAL DEFAULT 0, truck_unit TEXT DEFAULT 'T-1', status TEXT DEFAULT 'Pending')`);
	const add = (driver, file) => db.prepare("INSERT INTO expenses (driver, photo_data) VALUES (?, ?)").run(driver, file ? `/uploads/expense-receipts/${file}` : "").lastInsertRowid;
	add(DRIVER_A, F.A_JPG);         // 1
	add(DRIVER_B, F.B_JPG);         // 2
	add(DRIVER_A, F.A_PDF);         // 3
	add(DRIVER_B, F.A_JPG);         // 4: a later row naming A's file (the old photoData pass-through)
	add(DRIVER_A, F.A_UNREADABLE);  // 5
	add(DRIVER_A, F.A_BROKEN);      // 6
	return db;
}

const agent = new http.Agent({ keepAlive: false });
const servers = [];

async function build() {
	const app = express();
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	const requireAuth = (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: "Not authenticated" }));
	const requireRole = (...roles) => (req, res, next) => {
		const u = req.session.user;
		if (!u) return res.status(401).json({ error: "Not authenticated" });
		if (!roles.includes(u.role)) return res.status(403).json({ error: "Forbidden" });
		next();
	};
	const stub = (name) => (req, res) => { res.setHeader("X-Test-Guard", name); res.status(404).end(); };
	const logs = [];
	const fakeConsole = { log() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
	const db = makeDb();
	const body = [
		'"use strict";',
		...L.consts, ...L.fns, L.receiptGuardFn, L.receiptGuardConst, L.guardedDirs, ...L.mounts, L.thumbRoute,
		"return { saveReceiptToDisk };",
	].join("\n");
	const mod = new Function(
		"app", "express", "path", "fs", "crypto", "DATA_DIR", "RECEIPTS_DIR", "db", "requireAuth", "requireRole",
		"imageLimits", "receiptFiles", "imageMetadata", "guardDriverSignedDoc", "guardInvestorSignedDoc",
		"guardInvoicePdf", "guardDrugTestFile", "guardRootLoadDocument", "console", "require",
		body,
	)(app, express, path, fs, crypto, TMP, RECEIPTS_DIR, db, requireAuth, requireRole,
		require("../lib/image-size"), require("../lib/receipt-files"), require("../lib/image-metadata"),
		stub("guardDriverSignedDoc"), stub("guardInvestorSignedDoc"), stub("guardInvoicePdf"), stub("guardDrugTestFile"),
		stub("guardRootLoadDocument"), fakeConsole, require);
	app.get("*", (req, res) => res.status(200).send("<html>SPA-CATCH-ALL</html>"));
	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	const port = server.address().port;
	const get = (urlPath, user, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
		const req = http.request({
			host: "127.0.0.1", port, method, path: urlPath, agent,
			headers: { ...(user ? { "x-test-user": JSON.stringify(user) } : {}), ...headers },
		}, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
	return { ...mod, get, logs, db };
}

const R = (name) => `/uploads/expense-receipts/${name}`;
const isImage = (r) => r.status === 200 && /^image\//.test(String(r.headers["content-type"] || "")) && r.body.length > 0;
const clean = (r) => !fx.hasGpsTag(r.body) && fx.surviving(r.body).length === 0;
const refused = (r) => r.status === 404 && r.body.length === 0;

(async () => {
	const { Jimp } = require("jimp");
	const base = await fx.cleanImages();
	const bImg = new Jimp({ width: 10, height: 10, color: 0x22aa22ff });
	IMG = {
		aJpg: fx.jpegWithMetadata(base.jpeg, { orientation: 6 }),
		bJpg: fx.jpegWithMetadata(await bImg.getBuffer("image/jpeg"), { orientation: 1 }),
		pdf: Buffer.from("%PDF-1.4\n% made-up receipt\n%%EOF\n", "latin1"),
		unreadable: fx.undecodableJpegWithMetadata(base.jpeg),
		broken: fx.jpegWithMetadata(base.jpeg).subarray(0, 40),
		thumb: base.jpeg,
	};
	writeTree();
	const T = await build();

	// §1 Originals
	{
		const sa = await T.get(R(F.A_JPG), U.sa);
		ok("§1 Super Admin opens a driver's receipt", isImage(sa));
		ok("§1 ... and the copy has no GPS, EXIF text, XMP, IPTC, comment or trailing bytes", isImage(sa) && clean(sa));
		ok("§1 ... with the orientation kept", isImage(sa) && fx.orientationOf(sa.body) === 6);
		ok("§1 ... and is never cached by a shared cache", /private/.test(String(sa.headers["cache-control"] || "")));
		ok("§1 ... and is sent nosniff", sa.headers["x-content-type-options"] === "nosniff");
		const disp = await T.get(R(F.A_JPG), U.disp);
		ok("§1 Dispatcher (reviews receipts) opens it, stripped", isImage(disp) && clean(disp));
		const own = await T.get(R(F.A_JPG), U.drvA);
		ok("§1 the receipt's own driver opens it, stripped", isImage(own) && clean(own));
		const spaced = await T.get(R(F.A_JPG), U.drvAspaced);
		ok("§1 ... also under a spacing / case variant of the name", isImage(spaced));
		ok("§1 another driver is refused (404), even with a later row naming the same file", refused(await T.get(R(F.A_JPG), U.drvB)));
		ok("§1 a driver with no driver name is refused", refused(await T.get(R(F.A_JPG), U.drvBlank)));
		ok("§1 an Investor with no claim on it is refused", refused(await T.get(R(F.A_JPG), U.inv)));
		ok("§1 an unknown role is refused", refused(await T.get(R(F.A_JPG), U.odd)));
		ok("§1 signed out: 401", (await T.get(R(F.A_JPG), null)).status === 401);
		ok("§1 Driver B opens B's own receipt", isImage(await T.get(R(F.B_JPG), U.drvB)));
		ok("§1 Driver A is refused B's receipt", refused(await T.get(R(F.B_JPG), U.drvA)));

		for (const [label, p] of [
			["a doubled slash", `/uploads//expense-receipts/${F.B_JPG}`],
			["an encoded separator", `/uploads/expense-receipts%2F${F.B_JPG}`],
			["a dot segment", `/uploads/./expense-receipts/${F.B_JPG}`],
			["mixed-case folder", `/uploads/Expense-Receipts/${F.B_JPG}`],
			["an encoded folder name", `/uploads/%65xpense-receipts/${F.B_JPG}`],
		]) {
			ok(`§1 Driver A is refused B's receipt through ${label}`, (await T.get(p, U.drvA)).status === 404);
		}

		const pdfOwn = await T.get(R(F.A_PDF), U.drvA);
		ok("§1 a PDF receipt opens for its driver as application/pdf, unchanged", pdfOwn.status === 200 && /application\/pdf/.test(pdfOwn.headers["content-type"]) && pdfOwn.body.equals(IMG.pdf));
		ok("§1 ... and for a Dispatcher", (await T.get(R(F.A_PDF), U.disp)).status === 200);
		ok("§1 ... and is refused to another driver and an Investor", refused(await T.get(R(F.A_PDF), U.drvB)) && refused(await T.get(R(F.A_PDF), U.inv)));

		ok("§1 a file no row names is refused, Super Admin included", refused(await T.get(R(F.ORPHAN), U.sa)) && refused(await T.get(R(F.ORPHAN), U.disp)));
		ok("§1 an image cut inside its metadata is refused, never sent as stored", refused(await T.get(R(F.A_BROKEN), U.sa)));
		ok("§1 a name that is not there: 404", refused(await T.get(R("1788000000099-000000000000.jpg"), U.sa)));

		const head = await T.get(R(F.A_JPG), U.drvA, { method: "HEAD" });
		ok("§1 HEAD answers like GET, with no body", head.status === 200 && head.body.length === 0);
		const etag = own.headers.etag;
		const again = etag ? await T.get(R(F.A_JPG), U.drvA, { headers: { "if-none-match": etag } }) : { status: 0 };
		ok("§1 an unchanged receipt revalidates as 304 (the investor and expenses pages load many)", again.status === 304);
		ok("§1 a POST is not served", (await T.get(R(F.A_JPG), U.sa, { method: "POST" })).status === 404);
		ok("§1 another unguarded folder is unchanged (chat/ still opens for a Driver)", (await T.get("/uploads/chat/chat_1_abcde.jpg", U.drvA)).status === 200);
	}

	// §2 Cached thumbnails in the folder
	for (const [label, user] of [["Super Admin", U.sa], ["a Dispatcher", U.disp], ["the receipt's driver", U.drvA], ["another driver", U.drvB], ["an Investor", U.inv]]) {
		ok(`§2 a cached thumbnail under /uploads is not served to ${label}`, (await T.get(R("thumbs/1.jpg"), user)).status === 404);
	}
	ok("§2 ... nor through a doubled slash or mixed case", (await T.get("/uploads//expense-receipts//thumbs/2.jpg", U.drvB)).status === 404
		&& (await T.get("/uploads/EXPENSE-RECEIPTS/Thumbs/2.jpg", U.inv)).status === 404);

	// §3 The thumbnail API
	{
		const sa = await T.get("/api/expenses/1/receipt-thumbnail", U.sa);
		ok("§3 Super Admin gets a thumbnail", isImage(sa));
		ok("§3 Dispatcher gets a thumbnail", isImage(await T.get("/api/expenses/2/receipt-thumbnail", U.disp)));
		for (const [label, user, code] of [["the receipt's driver", U.drvA, 403], ["another driver", U.drvB, 403], ["an Investor", U.inv, 403], ["signed out", null, 401]]) {
			ok(`§3 ${label}: ${code}`, (await T.get("/api/expenses/1/receipt-thumbnail", user)).status === code);
		}
		const fallback = await T.get("/api/expenses/5/receipt-thumbnail", U.sa);
		ok("§3 an image the thumbnailer cannot decode falls back to the original", fallback.status === 200 && fallback.body.length > 0);
		ok("§3 ... and that original goes out without its GPS block or text", fallback.status === 200 && clean(fallback));
	}

	// §4 New uploads
	{
		const saved = T.saveReceiptToDisk(`data:image/jpeg;base64,${IMG.aJpg.toString("base64")}`);
		const stored = saved && saved.url ? fs.readFileSync(path.join(RECEIPTS_DIR, path.basename(saved.url))) : Buffer.alloc(0);
		ok("§4 a new photo receipt is stored", !!(saved && saved.url && stored.length));
		ok("§4 ... without GPS, EXIF text, XMP, IPTC, comment or trailing bytes", stored.length > 0 && !fx.hasGpsTag(stored) && fx.surviving(stored).length === 0);
		ok("§4 ... with its orientation", stored.length > 0 && fx.orientationOf(stored) === 6);
		const png = T.saveReceiptToDisk(`data:image/png;base64,${fx.pngWithMetadata(base.png).toString("base64")}`);
		const storedPng = png && png.url ? fs.readFileSync(path.join(RECEIPTS_DIR, path.basename(png.url))) : Buffer.alloc(0);
		ok("§4 a PNG receipt is stored without its eXIf / text chunks", storedPng.length > 0 && !fx.hasGpsTag(storedPng) && fx.surviving(storedPng).length === 0);
		const passThrough = T.saveReceiptToDisk(R(F.A_JPG));
		ok("§4 a stored receipt path sent as photoData is refused (400)", !!passThrough && !passThrough.url && passThrough.status === 400);
		ok("§4 no photo is still allowed", T.saveReceiptToDisk("").url === "" && T.saveReceiptToDisk(undefined).url === "");
		const cut = T.saveReceiptToDisk(`data:image/jpeg;base64,${IMG.broken.toString("base64")}`);
		ok("§4 an image whose metadata cannot be walked is not stored", !!cut && !cut.url && cut.status >= 400);
	}

	// §5 The receipts ZIP (Super Admin)
	ok("§5 the receipts ZIP streams each file through lib/receipt-files.js, not the stored bytes",
		/receiptFiles\.receiptFileStream\(/.test(L.zipRoute) && !/archive\.file\(/.test(L.zipRoute));

	for (const s of servers) s.close();
	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(failed ? `\n${failed} FAILED` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
