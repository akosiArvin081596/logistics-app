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
 * driver, Investors, an unknown role, signed out):
 *   §1 originals under /uploads/expense-receipts/, every path spelling
 *   §2 cached thumbnails under /uploads/expense-receipts/thumbs/ (the list's
 *      thumbnails come from the API; nothing links to the folder)
 *   §3 GET /api/expenses/:id/receipt-thumbnail (its role gate, and its fallback
 *      to the original, which must also go out stripped)
 *   §4 saveReceiptToDisk(): a new upload is stored without metadata; a stored
 *      path sent as photoData is refused (400)
 *   §5 GET /api/expenses/receipts-download streams stripped copies
 *   §6 the Investor rule (INVESTOR_RECEIPT_IMAGES, the owner's choice pending),
 *      run under BOTH options whichever one ships: "own-trucks" (A: photos of
 *      receipts on the investor's own trucks, none with a Personal part) and
 *      "none" (B: no receipt photos). The receipt file and the investor's
 *      receipt list (GET /api/investor/expenses) must agree under each.
 *
 * WHAT IS REAL: every /uploads mount in file order, normalizedUploadPath,
 * uploadsPathGuard, GUARDED_UPLOAD_DIRS, uploadMissLimiter and its constants,
 * the receipt guard and the Investor rule (when server.js has them), the
 * thumbnail route, GET /api/investor/expenses with every declaration it reaches
 * (scripts/lib/server-lift.js), saveReceiptToDisk and sniffImageFormat, all
 * LIFTED from server.js, plus
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
const { closure } = require("./lib/server-lift");
const personalExpense = require("../lib/personal-expense");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// Lifting (same scanner as test-uploads-root-guard.js)
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
// The Investor rule and the investor's receipt list, with every declaration they
// reach. Names lifted above or passed in below are provided, never lifted twice.
const PROVIDED = [
	"app", "express", "path", "fs", "crypto", "DATA_DIR", "RECEIPTS_DIR", "db", "requireAuth", "requireRole", "imageLimits",
	"receiptFiles", "imageMetadata", "console", "require", "INLINE_SAFE_UPLOAD_EXTS", "UPLOAD_MISS_WINDOW_MS", "UPLOAD_MISS_MAX",
	"UPLOAD_MISS_BURST_MAX", "UPLOAD_MISS_KEYS_MAX", "uploadMissCounts", "RECEIPT_IMAGE_EXTS", "MAX_IMAGE_RECEIPT_BYTES",
	"RECEIPT_OCR_MAX_PIXELS", "expenseReceiptGuard", "guardExpenseReceipt", "GUARDED_UPLOAD_DIRS", "normalizeDriverName",
	"sniffImageFormat", "normalizedUploadPath", "uploadMissLimiter", "uploadsPathGuard", "saveReceiptToDisk",
	"guardDriverSignedDoc", "guardInvestorSignedDoc", "guardInvoicePdf", "guardDrugTestFile", "guardRootLoadDocument",
];
const INVESTOR_LIST_HEAD = 'app.get("/api/investor/expenses", requireRole("Super Admin", "Investor"), async (req, res) => {';
const INVESTOR_RULE_RE = /\nconst INVESTOR_RECEIPT_IMAGES = "([a-z-]+)";/;
const SHIPPED_OPTION = (SRC.match(INVESTOR_RULE_RE) || [])[1] || "";
L.investor = closure(SRC, {
	roots: ["investorMaySeeReceipt", "investorReceiptImageIds"].filter((n) => SRC.includes(`\nfunction ${n}(`)),
	routes: [INVESTOR_LIST_HEAD],
	provided: PROVIDED,
	denied: ["server", "io", "httpServer"],
}).text;
ok(`lifted every /uploads mount from server.js (${L.mounts.length})`, L.mounts.length === 4);
ok(`server.js ships one of the two Investor options (found ${JSON.stringify(SHIPPED_OPTION)})`, ["own-trucks", "none"].includes(SHIPPED_OPTION));
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
	A_PERSONAL: "1788000000007-a7a7a7a7a7a7.jpg", // A's receipt with a live Personal deduction
};
const U = {
	sa: { id: 1, role: "Super Admin", username: "admin_t" },
	disp: { id: 2, role: "Dispatcher", username: "dispatch_t" },
	drvA: { id: 10, role: "Driver", username: "drv_a", driverName: DRIVER_A },
	drvAspaced: { id: 10, role: "Driver", username: "drv_a", driverName: "  tamsin   VALE " },
	drvB: { id: 11, role: "Driver", username: "drv_b", driverName: DRIVER_B },
	drvBlank: { id: 12, role: "Driver", username: "drv_blank", driverName: "" },
	inv: { id: 50, role: "Investor", username: "inv_t" },          // owns truck T-1 (Driver A's)
	invOther: { id: 51, role: "Investor", username: "inv_u" },     // owns truck T-2 (Driver B's)
	invNone: { id: 52, role: "Investor", username: "inv_v" },      // owns no truck
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
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_PERSONAL), IMG.aJpg);
	fs.writeFileSync(path.join(RECEIPTS_DIR, "thumbs", "1.jpg"), IMG.thumb);
	fs.writeFileSync(path.join(RECEIPTS_DIR, "thumbs", "2.jpg"), IMG.thumb);
	fs.mkdirSync(path.join(UP, "chat"), { recursive: true });
	fs.writeFileSync(path.join(UP, "chat", "chat_1_abcde.jpg"), IMG.bJpg);
	fs.mkdirSync(path.join(UP, "onboarding-templates"), { recursive: true });
	fs.writeFileSync(path.join(UP, "onboarding-templates", "blank-form.pdf"), IMG.pdf);
}

// `noTrucks`: a database whose trucks table cannot be read (the Investor
// check's "could not tell").
function makeDb({ noTrucks = false } = {}) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT '', driver TEXT, load_id TEXT DEFAULT '',
		type TEXT DEFAULT 'Fuel', amount REAL DEFAULT 10, description TEXT DEFAULT '', date TEXT DEFAULT '2026-10-01',
		photo_data TEXT DEFAULT '', status TEXT DEFAULT 'Pending', gallons REAL DEFAULT 0, odometer REAL DEFAULT 0,
		truck_unit TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, location_city TEXT DEFAULT '', location_state TEXT DEFAULT '',
		posted_period TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
	db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, company_name TEXT DEFAULT '');
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY, truck_id INTEGER, driver_name TEXT DEFAULT '', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '');
		CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT);
		INSERT INTO users (id, username, role) VALUES (1, 'admin_t', 'Super Admin'), (50, 'inv_t', 'Investor'), (51, 'inv_u', 'Investor'), (52, 'inv_v', 'Investor');`);
	if (!noTrucks) {
		db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, owner_id INTEGER, assigned_driver TEXT DEFAULT '',
			created_at TEXT DEFAULT '2026-01-05 00:00:00', in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '', status TEXT DEFAULT 'Active');
			INSERT INTO trucks (id, unit_number, owner_id, assigned_driver) VALUES (1, 'T-1', 50, '${DRIVER_A}'), (2, 'T-2', 51, '${DRIVER_B}');`);
	}
	db.exec(personalExpense.SCHEMA_SQL);
	const add = (driver, file, owner, unit) => db.prepare("INSERT INTO expenses (driver, photo_data, owner_id, truck_unit) VALUES (?, ?, ?, ?)")
		.run(driver, file ? `/uploads/expense-receipts/${file}` : "", owner, unit).lastInsertRowid;
	add(DRIVER_A, F.A_JPG, 50, "T-1");         // 1
	add(DRIVER_B, F.B_JPG, 51, "T-2");         // 2
	add(DRIVER_A, F.A_PDF, 50, "T-1");         // 3
	add(DRIVER_B, F.A_JPG, 51, "T-2");         // 4: a second row, another driver's, naming the same file
	add(DRIVER_A, F.A_UNREADABLE, 50, "T-1");  // 5
	add(DRIVER_A, F.A_BROKEN, 50, "T-1");      // 6
	const personalId = add(DRIVER_A, F.A_PERSONAL, 50, "T-1");  // 7: $4 of its $10 is Personal
	db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start,
		created_at, created_by, created_by_id, created_role) VALUES (?, 'deduct', 400, 1000, '2026-10', 1, '2026-10-01', '2026-09-26',
		'2026-10-02T00:00:00Z', 'admin_t', 1, 'Super Admin')`).run(personalId);
	return db;
}

const agent = new http.Agent({ keepAlive: false });
const servers = [];

// `option` replaces the shipped INVESTOR_RECEIPT_IMAGES value, so both options run.
async function build({ option = SHIPPED_OPTION, db = makeDb() } = {}) {
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
	// getInvestorDriverMonthWindows() runs as shipped, behind a counter (§6 counts
	// how often a page of photos rebuilds an investor's windows).
	const investorText = (option ? L.investor.replace(INVESTOR_RULE_RE, `\nconst INVESTOR_RECEIPT_IMAGES = "${option}";`) : L.investor)
		.replace("\nfunction getInvestorDriverMonthWindows(", "\nfunction getInvestorDriverMonthWindowsShipped(")
		+ "\nfunction getInvestorDriverMonthWindows(userId) { windowCalls.n++; return getInvestorDriverMonthWindowsShipped(userId); }";
	const windowCalls = { n: 0 };
	const body = [
		'"use strict";',
		...L.consts, ...L.fns, investorText, L.receiptGuardFn, L.receiptGuardConst, L.guardedDirs, ...L.mounts, L.thumbRoute,
		"return { saveReceiptToDisk };",
	].join("\n");
	// server.js's own require("./lib/…") calls resolve from the repo root.
	const serverRequire = (m) => require(m.startsWith("./lib/") ? path.join(__dirname, "..", m) : m);
	const mod = new Function(
		"app", "express", "path", "fs", "crypto", "DATA_DIR", "RECEIPTS_DIR", "db", "requireAuth", "requireRole",
		"imageLimits", "receiptFiles", "imageMetadata", "guardDriverSignedDoc", "guardInvestorSignedDoc",
		"guardInvoicePdf", "guardDrugTestFile", "guardRootLoadDocument", "guardChatAttachment", "console", "require", "windowCalls",
		body,
	)(app, express, path, fs, crypto, TMP, RECEIPTS_DIR, db, requireAuth, requireRole,
		require("../lib/image-size"), require("../lib/receipt-files"), require("../lib/image-metadata"),
		stub("guardDriverSignedDoc"), stub("guardInvestorSignedDoc"), stub("guardInvoicePdf"), stub("guardDrugTestFile"),
		stub("guardRootLoadDocument"), stub("guardChatAttachment"), fakeConsole, serverRequire, windowCalls);
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
	return { ...mod, get, logs, db, windowCalls };
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
		ok("§1 another driver is refused (404); the first row naming the file decides", refused(await T.get(R(F.A_JPG), U.drvB)));
		ok("§1 a driver with no driver name is refused", refused(await T.get(R(F.A_JPG), U.drvBlank)));
		ok("§1 an Investor with no claim on it (no truck) is refused", refused(await T.get(R(F.A_JPG), U.invNone)));
		ok("§1 an Investor whose truck carries only a LATER row naming the file is refused", refused(await T.get(R(F.A_JPG), U.invOther)));
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

		// PDF receipts are staff only since 2026-10-22 (scripts/test-receipt-pdf-access.js).
		const pdfDisp = await T.get(R(F.A_PDF), U.disp);
		ok("§1 a PDF receipt opens for a Dispatcher as application/pdf, unchanged", pdfDisp.status === 200 && /application\/pdf/.test(pdfDisp.headers["content-type"]) && pdfDisp.body.equals(IMG.pdf));
		ok("§1 ... and is refused to its own driver, another driver and an Investor",
			refused(await T.get(R(F.A_PDF), U.drvA)) && refused(await T.get(R(F.A_PDF), U.drvB)) && refused(await T.get(R(F.A_PDF), U.invNone)));

		ok("§1 a file no row names is refused, Super Admin included", refused(await T.get(R(F.ORPHAN), U.sa)) && refused(await T.get(R(F.ORPHAN), U.disp)));
		ok("§1 an image cut inside its metadata is refused, never sent as stored", refused(await T.get(R(F.A_BROKEN), U.sa)));
		ok("§1 a name that is not there: 404", refused(await T.get(R("1788000000099-000000000000.jpg"), U.sa)));

		const head = await T.get(R(F.A_JPG), U.drvA, { method: "HEAD" });
		ok("§1 HEAD answers like GET, with no body", head.status === 200 && head.body.length === 0);
		ok("§1 a served receipt may not be stored by any cache (private, no-store, no ETag)",
			own.headers["cache-control"] === "private, no-store" && !own.headers.etag);
		ok("§1 a POST is not served", (await T.get(R(F.A_JPG), U.sa, { method: "POST" })).status === 404);
		ok("§1 another unguarded folder is unchanged (onboarding-templates/ still opens for a Driver)", (await T.get("/uploads/onboarding-templates/blank-form.pdf", U.drvA)).status === 200);
		ok("§1 chat/ goes to its own guard, not the receipt guard", (await T.get("/uploads/chat/chat_1_abcde.jpg", U.drvA)).headers["x-test-guard"] === "guardChatAttachment");
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

	// §6 The Investor rule, under both options. [label, user, file, A, B]: the
	// status each option answers. Investor 50 owns Driver A's truck, 51 Driver B's.
	{
		const CASES = [
			["their own truck's photo receipt", U.inv, F.A_JPG, 200, 404],
			["their own truck's PDF receipt (staff only since 2026-10-22)", U.inv, F.A_PDF, 404, 404],
			["their own truck's receipt with a Personal part", U.inv, F.A_PERSONAL, 404, 404],
			["another investor's truck's receipt", U.inv, F.B_JPG, 404, 404],
			["the other investor's own receipt", U.invOther, F.B_JPG, 200, 404],
			["a receipt whose first row is on another investor's truck", U.invOther, F.A_JPG, 404, 404],
			["any receipt, owning no truck", U.invNone, F.A_JPG, 404, 404],
		];
		const shown = (list, id) => (list.find((e) => Number(e.id) === id) || {}).photo_data;
		for (const [option, col] of [["own-trucks", 3], ["none", 4]]) {
			const tag = option === "own-trucks" ? "A (own trucks)" : "B (none)";
			const T6 = await build({ option });
			for (const c of CASES) {
				const r = await T6.get(R(c[2]), c[1]);
				ok(`§6 option ${tag}: an Investor opening ${c[0]} gets ${c[col]}`, r.status === c[col] && (c[col] !== 200 || r.body.length > 0));
				if (c[col] === 200 && r.status === 200 && /^image\//.test(String(r.headers["content-type"]))) {
					ok(`§6 option ${tag}: ... and the copy is stripped`, clean(r));
				}
			}
			ok(`§6 option ${tag}: Super Admin still opens the Personal receipt`, isImage(await T6.get(R(F.A_PERSONAL), U.sa)));
			ok(`§6 option ${tag}: the receipt's driver still opens the Personal receipt`, isImage(await T6.get(R(F.A_PERSONAL), U.drvA)));

			const parse = (r) => { try { return JSON.parse(r.body.toString("utf8")).expenses || []; } catch { return []; } };
			const inv = parse(await T6.get("/api/investor/expenses", U.inv));
			const preview = parse(await T6.get("/api/investor/expenses?as_user_id=50", U.sa));
			const admin = parse(await T6.get("/api/investor/expenses", U.sa));
			ok(`§6 option ${tag}: the investor's list holds their five receipts`, inv.length === 5);
			if (option === "own-trucks") {
				ok("§6 option A: the list links the photos the investor may open, and no PDF receipt", shown(inv, 1) === R(F.A_JPG) && shown(inv, 3) === "");
				ok("§6 option A: the list sends no photo for the receipt with a Personal part", inv.length === 5 && shown(inv, 7) === "");
			} else {
				ok("§6 option B: the list sends no receipt photo at all", inv.length === 5 && inv.every((e) => e.photo_data === ""));
			}
			ok(`§6 option ${tag}: every photo the list links opens for the investor`,
				(await Promise.all(inv.filter((e) => e.photo_data && ![5, 6].includes(Number(e.id)))
					.map((e) => T6.get(e.photo_data, U.inv)))).every((r) => r.status === 200));
			ok(`§6 option ${tag}: a Super Admin preview shows what the investor sees`,
				JSON.stringify(preview.map((e) => [e.id, e.photo_data])) === JSON.stringify(inv.map((e) => [e.id, e.photo_data])));
			ok(`§6 option ${tag}: a Super Admin's own list keeps every photo`, admin.length === 7 && shown(admin, 7) === R(F.A_PERSONAL) && shown(admin, 1) === R(F.A_JPG));
		}
		const TU = await build({ option: "own-trucks", db: makeDb({ noTrucks: true }) });
		const unverified = await TU.get(R(F.A_JPG), U.inv);
		ok("§6 an Investor check that cannot read the database answers a retryable 503, never the file",
			unverified.status === 503 && /RECEIPT_ACCESS_UNVERIFIED/.test(unverified.body.toString("utf8")) && unverified.headers["retry-after"] === "5");
		ok("§6 ... while Super Admin is unaffected", isImage(await TU.get(R(F.A_JPG), U.sa)));
	}

	// §7 The cost of a page of photos: an investor's driver windows are built once
	// for a burst of photos, not once per photo, and the file lookup uses an index.
	{
		const T7 = await build({ option: "own-trucks" });
		T7.windowCalls.n = 0;
		for (const f of [F.A_JPG, F.A_PDF, F.A_JPG, F.A_UNREADABLE, F.A_JPG, F.A_PDF]) await T7.get(R(f), U.inv);
		ok(`§7 six photos for one investor build their driver windows once (built ${T7.windowCalls.n} times)`, T7.windowCalls.n === 1);
		await T7.get(R(F.B_JPG), U.invOther);
		ok("§7 ... and another investor gets their own", T7.windowCalls.n === 2);

		const m = SRC.match(/\ntry \{ db\.exec\(`(CREATE INDEX IF NOT EXISTS (\w+) ON expenses\(photo_data\))`\); \} catch \{\}/);
		ok("§7 server.js indexes expenses.photo_data", !!m);
		if (m) {
			const db = makeDb();
			db.exec(m[1]);
			const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id, driver FROM expenses WHERE photo_data = ?").all("x").map((r) => r.detail).join(" ");
			ok(`§7 ... and the receipt lookup uses it (${plan})`, plan.includes(m[2]));
		}
	}

	for (const s of servers) s.close();
	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(failed ? `\n${failed} FAILED` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
