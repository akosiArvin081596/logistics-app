#!/usr/bin/env node
/**
 * scripts/test-receipt-pdf-access.js — a PDF receipt's file opens for staff only
 * (Arvin, 2026-10-22, driver privacy DP1 and DP3).
 *
 * The rule: a PDF receipt under /uploads/expense-receipts/ opens only for Super
 * Admin and Dispatcher (the roles that review receipts). The receipt's own driver
 * and every Investor get the guard's usual refusal (404, empty) by every path
 * spelling and method: GET, HEAD and a Range request. "PDF" is read from the
 * file's own bytes, so PDF bytes stored under an image name are refused too.
 * Investors' receipt list (GET /api/investor/expenses, as the investor and as a
 * Super Admin previewing as them) sends a PDF row with no link and
 * receipt_kind "pdf_office_copy", which the screen shows as
 * "PDF receipt (office copy)". The driver's own list
 * (GET /api/driver/:driverName) sends no PDF reference. Image receipts keep
 * their rules (scripts/test-receipt-image-access.js). PDF_RECEIPT_ACCESS in
 * lib/receipt-files.js is a code constant; both of its values are run.
 *
 *   T1  the receipt's driver: 404 under every path spelling, as GET, HEAD and a
 *       Range request; also for PDF bytes stored under a .jpg name
 *   T2  the Investor whose truck the PDF row is on: 404, GET / HEAD / Range
 *   T3  the investor's receipt list, as the investor and as a Super Admin
 *       previewing as them: a PDF row (by name, or an inline PDF) comes back
 *       with photo_data "" and receipt_kind "pdf_office_copy"; the screen and
 *       docs/investor-portal-copy.md carry the text
 *   T4  Super Admin and Dispatcher: 200, the same bytes, GET / HEAD / Range
 *   T5  another driver, another truck's investor, an investor with no truck, an
 *       unknown role: 404; signed out: 401
 *   T6  image receipts: their driver and the own-truck investor still open them
 *   T7  under PDF_RECEIPT_ACCESS "as-images" (the earlier rule), T1-T3 answer as
 *       before 2026-10-22
 *   T10 an Investor's (and the driver's) request from another site is refused
 *       like any other
 *   T11 the driver's own list blanks every PDF reference, inline ones included
 *
 * WHAT IS REAL: every /uploads mount in file order, normalizedUploadPath,
 * uploadsPathGuard, GUARDED_UPLOAD_DIRS, uploadMissLimiter and its constants, the
 * receipt guard's wiring and the Investor rule, GET /api/investor/expenses with
 * every declaration it reaches (scripts/lib/server-lift.js), and the driver
 * list's photo column, all LIFTED from server.js, plus lib/receipt-files.js;
 * mounted on a real Express app over a temp uploads/ tree and driven over HTTP on
 * 127.0.0.1. FIXTURES: an in-memory SQLite, a header-driven session, stubs for
 * the other directory guards. Made-up names, trucks and files only.
 * Run: node scripts/test-receipt-pdf-access.js
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
const receiptFiles = require("../lib/receipt-files");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// Lifting (the scanner test-receipt-image-access.js uses)
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, "..");
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
function liftFn(name) {
	for (const prefix of ["\nasync function ", "\nfunction "]) {
		const at = SRC.indexOf(`${prefix}${name}(`);
		if (at < 0) continue;
		const bodyOpen = SRC.indexOf("{", closeOf(SRC.indexOf("(", at + prefix.length)));
		return SRC.slice(at + 1, closeOf(bodyOpen));
	}
	die(`could not locate function ${name} in server.js`);
}
function liftConst(name) {
	const at = SRC.indexOf(`\nconst ${name} =`);
	if (at < 0) die(`could not locate const ${name} in server.js`);
	return statementFrom(at + 1);
}
function liftStatements(needle) {
	const out = [];
	for (let at = SRC.indexOf(needle); at >= 0; at = SRC.indexOf(needle, at + 1)) out.push(statementFrom(at + 1));
	return out;
}

const L = {
	consts: ["INLINE_SAFE_UPLOAD_EXTS", "UPLOAD_MISS_WINDOW_MS", "UPLOAD_MISS_MAX", "UPLOAD_MISS_BURST_MAX", "UPLOAD_MISS_KEYS_MAX",
		"uploadMissCounts"].map((n) => liftConst(n)),
	receiptGuardConst: liftConst("expenseReceiptGuard"),
	receiptGuardFn: liftFn("guardExpenseReceipt"),
	guardedDirs: liftConst("GUARDED_UPLOAD_DIRS"),
	fns: ["normalizeDriverName", "normalizedUploadPath", "uploadMissLimiter", "uploadsPathGuard"].map((n) => liftFn(n)),
	mounts: liftStatements('\napp.use("/uploads'),
};
const PROVIDED = [
	"app", "express", "path", "fs", "crypto", "DATA_DIR", "RECEIPTS_DIR", "db", "requireAuth", "requireRole",
	"receiptFiles", "console", "require", "INLINE_SAFE_UPLOAD_EXTS", "UPLOAD_MISS_WINDOW_MS", "UPLOAD_MISS_MAX",
	"UPLOAD_MISS_BURST_MAX", "UPLOAD_MISS_KEYS_MAX", "uploadMissCounts", "expenseReceiptGuard", "guardExpenseReceipt",
	"GUARDED_UPLOAD_DIRS", "normalizeDriverName", "normalizedUploadPath", "uploadMissLimiter", "uploadsPathGuard",
	"guardDriverSignedDoc", "guardInvestorSignedDoc", "guardInvoicePdf", "guardDrugTestFile", "guardRootLoadDocument",
	"guardChatAttachment",
];
const INVESTOR_LIST_HEAD = 'app.get("/api/investor/expenses", requireRole("Super Admin", "Investor"), async (req, res) => {';
L.investor = closure(SRC, {
	roots: ["investorMaySeeReceipt", "investorReceiptImageIds"],
	routes: [INVESTOR_LIST_HEAD],
	provided: PROVIDED,
	denied: ["server", "io", "httpServer"],
}).text;
// The driver's own list: the expression its photoData column is read with.
const DRIVER_LIST_AT = SRC.indexOf('\napp.get("/api/driver/:driverName"');
const DRIVER_PHOTO_EXPR = DRIVER_LIST_AT < 0 ? ""
	: ((SRC.slice(DRIVER_LIST_AT, DRIVER_LIST_AT + 20000).match(/,\s*((?:CASE[^,]{1,400}?END|photo_data)) AS photoData,/) || [])[1] || "");
ok(`lifted every /uploads mount from server.js (${L.mounts.length})`, L.mounts.length === 4);
ok("found the driver list's photoData column", !!DRIVER_PHOTO_EXPR);

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const DRIVER_A = "Tamsin Vale";
const DRIVER_B = "Orrin Cade";
const F = {
	A_JPG: "1789000000001-a1a1a1a1a1a1.jpg",        // Driver A's photo receipt
	A_PDF: "1789000000002-a2a2a2a2a2a2.pdf",        // a PDF receipt filed for Driver A (truck T-1)
	A_PDF_AS_JPG: "1789000000003-a3a3a3a3a3a3.jpg", // PDF bytes stored under an image name, Driver A
	B_PDF: "1789000000004-b4b4b4b4b4b4.pdf",        // a PDF receipt filed for Driver B (truck T-2)
	A_PDF_PERSONAL: "1789000000005-a5a5a5a5a5a5.pdf", // Driver A's PDF receipt with a live Personal part
};
const INLINE_PDF = "data:application/pdf;base64,JVBERi0xLjQKJSBtYWRlLXVwCiUlRU9GCg==";
const U = {
	sa: { id: 1, role: "Super Admin", username: "admin_t" },
	disp: { id: 2, role: "Dispatcher", username: "dispatch_t" },
	drvA: { id: 10, role: "Driver", username: "drv_a", driverName: DRIVER_A },
	drvAspaced: { id: 10, role: "Driver", username: "drv_a", driverName: "  tamsin   VALE " },
	drvB: { id: 11, role: "Driver", username: "drv_b", driverName: DRIVER_B },
	inv: { id: 50, role: "Investor", username: "inv_t" },          // owns truck T-1 (Driver A's)
	invOther: { id: 51, role: "Investor", username: "inv_u" },     // owns truck T-2 (Driver B's)
	invNone: { id: 52, role: "Investor", username: "inv_v" },      // owns no truck
	odd: { id: 60, role: "Auditor", username: "odd_t" },
};
// Expense ids, in insert order.
const E = { A_JPG: 1, A_PDF: 2, A_PDF_AS_JPG: 3, B_PDF: 4, A_INLINE_PDF: 5, A_PDF_PERSONAL: 6 };

let IMG;   // filled below
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-pdf-access-"));
const UP = path.join(TMP, "uploads");
const RECEIPTS_DIR = path.join(UP, "expense-receipts");

function writeTree() {
	fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_JPG), IMG.jpg);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_PDF), IMG.pdfA);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_PDF_AS_JPG), IMG.pdfA);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.B_PDF), IMG.pdfB);
	fs.writeFileSync(path.join(RECEIPTS_DIR, F.A_PDF_PERSONAL), IMG.pdfA);
}

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT DEFAULT '', driver TEXT, load_id TEXT DEFAULT '',
		type TEXT DEFAULT 'Tolls', amount REAL DEFAULT 10, description TEXT DEFAULT '', date TEXT DEFAULT '2026-10-01',
		photo_data TEXT DEFAULT '', status TEXT DEFAULT 'Pending', gallons REAL DEFAULT 0, odometer REAL DEFAULT 0,
		truck_unit TEXT DEFAULT '', owner_id INTEGER DEFAULT 0, location_city TEXT DEFAULT '', location_state TEXT DEFAULT '',
		posted_period TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
	db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, company_name TEXT DEFAULT '');
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY, truck_id INTEGER, driver_name TEXT DEFAULT '', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '');
		CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT);
		INSERT INTO users (id, username, role) VALUES (1, 'admin_t', 'Super Admin'), (50, 'inv_t', 'Investor'), (51, 'inv_u', 'Investor'), (52, 'inv_v', 'Investor');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, owner_id INTEGER, assigned_driver TEXT DEFAULT '',
			created_at TEXT DEFAULT '2026-01-05 00:00:00', in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '', status TEXT DEFAULT 'Active');
		INSERT INTO trucks (id, unit_number, owner_id, assigned_driver) VALUES (1, 'T-1', 50, '${DRIVER_A}'), (2, 'T-2', 51, '${DRIVER_B}');`);
	db.exec(personalExpense.SCHEMA_SQL);
	const add = (driver, photo, owner, unit) => db.prepare("INSERT INTO expenses (driver, photo_data, owner_id, truck_unit) VALUES (?, ?, ?, ?)")
		.run(driver, photo, owner, unit).lastInsertRowid;
	const R = (f) => `/uploads/expense-receipts/${f}`;
	add(DRIVER_A, R(F.A_JPG), 50, "T-1");            // 1
	add(DRIVER_A, R(F.A_PDF), 50, "T-1");            // 2
	add(DRIVER_A, R(F.A_PDF_AS_JPG), 50, "T-1");     // 3
	add(DRIVER_B, R(F.B_PDF), 51, "T-2");            // 4
	add(DRIVER_A, INLINE_PDF, 50, "T-1");            // 5: a legacy row holding its PDF inline
	const personalId = add(DRIVER_A, R(F.A_PDF_PERSONAL), 50, "T-1");  // 6: $4 of its $10 is Personal
	db.prepare(`INSERT INTO expense_personal (expense_id, kind, cents, receipt_cents, cost_period, in_place, book_date, week_start,
		created_at, created_by, created_by_id, created_role) VALUES (?, 'deduct', 400, 1000, '2026-10', 1, '2026-10-01', '2026-09-26',
		'2026-10-02T00:00:00Z', 'admin_t', 1, 'Super Admin')`).run(personalId);
	return db;
}

const agent = new http.Agent({ keepAlive: false });
const servers = [];

// `pdfAccess` runs the receipt rule under the other value of PDF_RECEIPT_ACCESS
// (lib/receipt-files.js), as server.js would ship it.
function receiptFilesUnder(pdfAccess) {
	if (!pdfAccess) return receiptFiles;
	return {
		...receiptFiles,
		PDF_RECEIPT_ACCESS: pdfAccess,
		pdfReceiptOpensFor: (user, access = pdfAccess) => receiptFiles.pdfReceiptOpensFor(user, access),
		createExpenseReceiptGuard: (opts) => receiptFiles.createExpenseReceiptGuard({ ...opts, pdfAccess }),
	};
}

async function build({ pdfAccess = "", readFile = null } = {}) {
	const lib = receiptFilesUnder(pdfAccess);
	const libUsed = readFile ? { ...lib, createExpenseReceiptGuard: (o) => lib.createExpenseReceiptGuard({ ...o, readFile }) } : lib;
	const db = makeDb();
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
	const body = [
		'"use strict";',
		...L.consts, ...L.fns, L.investor, L.receiptGuardFn, L.receiptGuardConst, L.guardedDirs, ...L.mounts,
	].join("\n");
	const serverRequire = (m) => require(m.startsWith("./lib/") ? path.join(ROOT, m) : m);
	new Function(
		"app", "express", "path", "fs", "crypto", "DATA_DIR", "RECEIPTS_DIR", "db", "requireAuth", "requireRole",
		"receiptFiles", "guardDriverSignedDoc", "guardInvestorSignedDoc", "guardInvoicePdf", "guardDrugTestFile",
		"guardRootLoadDocument", "guardChatAttachment", "console", "require",
		body,
	)(app, express, path, fs, crypto, TMP, RECEIPTS_DIR, db, requireAuth, requireRole,
		libUsed, stub("guardDriverSignedDoc"), stub("guardInvestorSignedDoc"), stub("guardInvoicePdf"),
		stub("guardDrugTestFile"), stub("guardRootLoadDocument"), stub("guardChatAttachment"), fakeConsole, serverRequire);
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
	return { get, logs, db };
}

const R = (name) => `/uploads/expense-receipts/${name}`;
const refused = (r) => r.status === 404 && r.body.length === 0 && !/pdf/i.test(String(r.headers["content-type"] || ""));
const isPdfBody = (r, bytes) => r.status === 200 && /application\/pdf/.test(String(r.headers["content-type"] || "")) && r.body.equals(bytes);
const isImage = (r) => r.status === 200 && /^image\//.test(String(r.headers["content-type"] || "")) && r.body.length > 0;
const METHODS = [
	["GET", {}],
	["HEAD", {}],
	["a Range request", { headers: { Range: "bytes=0-4" } }],
];
const as = ([label, opts]) => ({ label, opts: label === "HEAD" ? { method: "HEAD" } : opts });
const SPELLINGS = (f) => [
	["the plain path", R(f)],
	["a doubled slash", `/uploads//expense-receipts/${f}`],
	["a dot segment", `/uploads/./expense-receipts/${f}`],
	["a mixed-case folder", `/uploads/Expense-Receipts/${f}`],
	["an encoded folder name", `/uploads/%65xpense-receipts/${f}`],
	["an upper-case file name", R(f.toUpperCase())],
];
const parseList = (r) => { try { return JSON.parse(r.body.toString("utf8")).expenses || []; } catch { return []; } };
const rowOf = (list, id) => list.find((e) => Number(e.id) === id) || {};

(async () => {
	const base = await fx.cleanImages();
	IMG = {
		jpg: fx.jpegWithMetadata(base.jpeg, { orientation: 1 }),
		pdfA: Buffer.from("%PDF-1.4\n% made-up toll statement, truck T-1\n%%EOF\n", "latin1"),
		pdfB: Buffer.from("%PDF-1.4\n% made-up toll statement, truck T-2\n%%EOF\n", "latin1"),
	};
	writeTree();

	// lib/receipt-files.js: the rule itself
	{
		ok("lib: PDF_RECEIPT_ACCESS ships as \"staff\"", receiptFiles.PDF_RECEIPT_ACCESS === "staff");
		const opens = typeof receiptFiles.pdfReceiptOpensFor === "function" ? receiptFiles.pdfReceiptOpensFor : () => undefined;
		ok("lib: a PDF receipt opens for Super Admin and Dispatcher", opens(U.sa) === true && opens(U.disp) === true);
		ok("lib: ... not for a Driver, an Investor, an unknown role or no one",
			opens(U.drvA) === false && opens(U.inv) === false && opens(U.odd) === false && opens(null) === false);
		ok("lib: under \"as-images\" the PDF rule adds nothing to the photo rule", opens(U.drvA, "as-images") === true && opens(U.inv, "as-images") === true);
		ok("lib: any other value is read as staff only", opens(U.drvA, "anything") === false && opens(U.sa, "anything") === true);
		ok("lib: the list marker is \"pdf_office_copy\"", receiptFiles.PDF_OFFICE_COPY === "pdf_office_copy");
		const ref = typeof receiptFiles.isPdfReceiptRef === "function" ? receiptFiles.isPdfReceiptRef : () => undefined;
		ok("lib: a .pdf name (any case) and an inline PDF are PDF references",
			ref(R(F.A_PDF)) === true && ref(R(F.A_PDF.toUpperCase())) === true && ref(INLINE_PDF) === true && ref("DATA:Application/PDF;base64,JVBE") === true);
		ok("lib: an image name, an inline image and nothing are not",
			ref(R(F.A_JPG)) === false && ref("data:image/jpeg;base64,/9j/") === false && ref("") === false && ref(null) === false);
	}

	const T = await build();

	// T1 The receipt's own driver
	for (const [where, p] of SPELLINGS(F.A_PDF)) {
		for (const m of METHODS.map(as)) {
			ok(`T1 the receipt's driver is refused his PDF receipt through ${where}, as ${m.label}`, refused(await T.get(p, U.drvA, m.opts)));
		}
	}
	for (const m of METHODS.map(as)) {
		ok(`T1 ... and under a spacing / case variant of his name, as ${m.label}`, refused(await T.get(R(F.A_PDF), U.drvAspaced, m.opts)));
		ok(`T1 PDF bytes stored under a .jpg name are refused to the receipt's driver, as ${m.label}`, refused(await T.get(R(F.A_PDF_AS_JPG), U.drvA, m.opts)));
	}

	// T2 The Investor whose truck the PDF row is on
	for (const m of METHODS.map(as)) {
		ok(`T2 the own-truck Investor is refused a PDF receipt, as ${m.label}`, refused(await T.get(R(F.A_PDF), U.inv, m.opts)));
		ok(`T2 ... and PDF bytes under a .jpg name, as ${m.label}`, refused(await T.get(R(F.A_PDF_AS_JPG), U.inv, m.opts)));
		ok(`T2 the other investor is refused their own truck's PDF receipt, as ${m.label}`, refused(await T.get(R(F.B_PDF), U.invOther, m.opts)));
	}

	// T3 The investor's receipt list
	{
		const inv = parseList(await T.get("/api/investor/expenses", U.inv));
		const preview = parseList(await T.get("/api/investor/expenses?as_user_id=50", U.sa));
		const admin = parseList(await T.get("/api/investor/expenses", U.sa));
		ok(`T3 the investor's list holds their truck's five receipts (${inv.length})`, inv.length === 5);
		for (const [who, list] of [["the investor", inv], ["a Super Admin previewing as the investor", preview]]) {
			const pdf = rowOf(list, E.A_PDF);
			ok(`T3 ${who}: a PDF receipt row has no link`, list.length === 5 && pdf.photo_data === "");
			ok(`T3 ${who}: ... and is marked receipt_kind "pdf_office_copy"`, pdf.receipt_kind === "pdf_office_copy");
			const inline = rowOf(list, E.A_INLINE_PDF);
			ok(`T3 ${who}: an inline PDF receipt row has no PDF in it, and the same mark`, inline.photo_data === "" && inline.receipt_kind === "pdf_office_copy");
			const img = rowOf(list, E.A_JPG);
			ok(`T3 ${who}: a photo receipt keeps its link and has no mark`, img.photo_data === R(F.A_JPG) && img.receipt_kind === undefined);
			const personal = rowOf(list, E.A_PDF_PERSONAL);
			ok(`T3 ${who}: a PDF receipt with a Personal part stays withheld as before, with no mark`, personal.photo_data === "" && personal.receipt_kind === undefined);
			ok(`T3 ${who}: no row anywhere carries a PDF reference`, list.every((e) => !/\.pdf$/i.test(e.photo_data || "") && !/^data:application\/pdf/i.test(e.photo_data || "")));
		}
		ok("T3 a Super Admin preview shows exactly what the investor sees",
			JSON.stringify(preview.map((e) => [e.id, e.photo_data, e.receipt_kind])) === JSON.stringify(inv.map((e) => [e.id, e.photo_data, e.receipt_kind])));
		ok("T3 a Super Admin's own list keeps every PDF link, with no mark",
			rowOf(admin, E.A_PDF).photo_data === R(F.A_PDF) && rowOf(admin, E.B_PDF).photo_data === R(F.B_PDF)
			&& admin.every((e) => e.receipt_kind === undefined));
		const other = parseList(await T.get("/api/investor/expenses", U.invOther));
		ok("T3 the other investor's list marks their own PDF row the same way",
			other.length === 1 && rowOf(other, E.B_PDF).photo_data === "" && rowOf(other, E.B_PDF).receipt_kind === "pdf_office_copy");

		const vue = fs.readFileSync(path.join(ROOT, "client", "src", "components", "investor", "ExpensesSection.vue"), "utf8");
		ok("T3 the investor Expenses screen turns the mark into \"PDF receipt (office copy)\"",
			/v-if="e\.receipt_kind === 'pdf_office_copy'"[^>]*>PDF receipt \(office copy\)</.test(vue));
		const doc = fs.readFileSync(path.join(ROOT, "docs", "investor-portal-copy.md"), "utf8");
		const s10 = doc.slice(doc.indexOf("## 10. Expenses table"), doc.indexOf("## 11."));
		ok("T3 docs/investor-portal-copy.md §10 lists the text word for word", s10.includes("`PDF receipt (office copy)`"));
	}

	// T4 Staff
	for (const [who, user] of [["Super Admin", U.sa], ["a Dispatcher", U.disp]]) {
		ok(`T4 ${who} opens a PDF receipt: the same bytes, as application/pdf`, isPdfBody(await T.get(R(F.A_PDF), user), IMG.pdfA));
		const head = await T.get(R(F.A_PDF), user, { method: "HEAD" });
		ok(`T4 ${who}: HEAD answers 200 with no body`, head.status === 200 && head.body.length === 0 && /application\/pdf/.test(String(head.headers["content-type"])));
		const range = await T.get(R(F.A_PDF), user, { headers: { Range: "bytes=0-4" } });
		ok(`T4 ${who}: a Range request gets that range (206)`, range.status === 206 && range.body.toString("latin1") === "%PDF-");
		ok(`T4 ${who}: PDF bytes under a .jpg name open as application/pdf`, isPdfBody(await T.get(R(F.A_PDF_AS_JPG), user), IMG.pdfA));
		const pdf = await T.get(R(F.A_PDF), user);
		ok(`T4 ${who}: the copy is private, no-store and nosniff`, pdf.headers["cache-control"] === "private, no-store" && pdf.headers["x-content-type-options"] === "nosniff");
	}

	// T5 Everyone else, as before
	for (const [who, user, file] of [
		["another driver", U.drvB, F.A_PDF],
		["another truck's investor", U.invOther, F.A_PDF],
		["an investor with no truck", U.invNone, F.A_PDF],
		["an unknown role", U.odd, F.A_PDF],
		["another driver (PDF bytes under a .jpg name)", U.drvB, F.A_PDF_AS_JPG],
	]) {
		for (const m of METHODS.map(as)) ok(`T5 ${who} is refused, as ${m.label}`, refused(await T.get(R(file), user, m.opts)));
	}
	ok("T5 signed out: 401", (await T.get(R(F.A_PDF), null)).status === 401);

	// T6 Image receipts keep their rules
	ok("T6 the receipt's driver still opens his photo receipt", isImage(await T.get(R(F.A_JPG), U.drvA)));
	ok("T6 the own-truck investor still opens it", isImage(await T.get(R(F.A_JPG), U.inv)));
	ok("T6 another driver is still refused it", refused(await T.get(R(F.A_JPG), U.drvB)));
	// T1/T2 A JPEG on disk whose whole read comes back as PDF bytes (changed since its head was read): never sent.
	const TS = await build({ readFile: async () => IMG.pdfA });
	ok("T1 PDF bytes from the whole read of an image are refused to the receipt's driver", refused(await TS.get(R(F.A_JPG), U.drvA)));
	ok("T2 ... and to the own-truck investor", refused(await TS.get(R(F.A_JPG), U.inv)));
	ok("T1 ... and to a Range past the header (bytes=8-20)", refused(await TS.get(R(F.A_JPG), U.drvA, { headers: { Range: "bytes=8-20" } })));

	// T10 A request from another site
	{
		const cross = { headers: { Origin: "https://elsewhere.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" } };
		ok("T10 an Investor's request from another site is refused the PDF receipt", refused(await T.get(R(F.A_PDF), U.inv, cross)));
		ok("T10 ... as is the receipt's driver's", refused(await T.get(R(F.A_PDF), U.drvA, cross)));
		ok("T10 ... and a ranged one", refused(await T.get(R(F.A_PDF), U.inv, { headers: { ...cross.headers, Range: "bytes=0-4" } })));
	}

	// T11 The driver's own list (GET /api/driver/:driverName's photoData column)
	{
		const db = new Database(":memory:");
		db.exec("CREATE TABLE expenses (id INTEGER PRIMARY KEY, photo_data TEXT)");
		const cases = [
			[R(F.A_PDF), ""],
			[R(F.A_PDF.toUpperCase()), ""],
			[INLINE_PDF, ""],
			["DATA:APPLICATION/PDF;base64,JVBERi0=", ""],
			[R(F.A_JPG), R(F.A_JPG)],
			["data:image/jpeg;base64,/9j/", "data:image/jpeg;base64,/9j/"],
			["", ""],
		];
		const ins = db.prepare("INSERT INTO expenses (photo_data) VALUES (?)");
		for (const [p] of cases) ins.run(p);
		let got = [];
		try { got = db.prepare(`SELECT ${DRIVER_PHOTO_EXPR} AS photoData FROM expenses ORDER BY id`).all().map((r) => r.photoData); } catch { got = []; }
		ok("T11 the driver's list sends no PDF receipt reference (.pdf in any case, or an inline PDF)", got.length === cases.length && cases.slice(0, 4).every((c, i) => got[i] === ""));
		ok("T11 ... and keeps photo receipts as they are", got.length === cases.length && cases.slice(4).every((c, i) => got[i + 4] === c[1]));
	}

	// T7 Under the other value ("as-images", the rule before 2026-10-22)
	{
		const T7 = await build({ pdfAccess: "as-images" });
		ok("T7 \"as-images\": the receipt's driver opens his PDF receipt", isPdfBody(await T7.get(R(F.A_PDF), U.drvA), IMG.pdfA));
		const range = await T7.get(R(F.A_PDF), U.drvA, { headers: { Range: "bytes=0-4" } });
		ok("T7 \"as-images\": ... a Range request gets 206", range.status === 206);
		ok("T7 \"as-images\": ... and PDF bytes under a .jpg name", isPdfBody(await T7.get(R(F.A_PDF_AS_JPG), U.drvA), IMG.pdfA));
		ok("T7 \"as-images\": the own-truck investor opens it", isPdfBody(await T7.get(R(F.A_PDF), U.inv), IMG.pdfA));
		ok("T7 \"as-images\": another driver and another truck's investor are still refused",
			refused(await T7.get(R(F.A_PDF), U.drvB)) && refused(await T7.get(R(F.A_PDF), U.invOther)));
		const inv = parseList(await T7.get("/api/investor/expenses", U.inv));
		ok("T7 \"as-images\": the investor's list links the PDF receipt, with no mark",
			rowOf(inv, E.A_PDF).photo_data === R(F.A_PDF) && inv.every((e) => e.receipt_kind === undefined));
	}

	for (const s of servers) s.close();
	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(failed ? `\n${failed} FAILED` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
