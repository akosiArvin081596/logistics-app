#!/usr/bin/env node
/**
 * scripts/test-uploads-root-guard.js — flat files in the uploads ROOT.
 *
 * The uploads root holds load documents (POD, BOL, receipt, "Other"), written
 * by POST /api/documents/upload as `${loadId}_${docType}_${ms}.<ext>` with a
 * `documents` row each, and served by the authenticated /uploads static mount.
 * uploadsPathGuard sends every single-segment path to guardRootLoadDocument,
 * which admits:
 *   Super Admin, Dispatcher — always (they read every load's documents);
 *   a Driver   — a row their load's Documents panel lists, on a load that is theirs;
 *   an Investor — a row their Document Portal lists;
 * and answers everyone else 404. A miss anywhere under /uploads is a 404, and
 * 404s are counted per user by uploadMissLimiter.
 *
 * WHAT IS REAL HERE. Every piece of decision code is LIFTED from server.js and
 * run as shipped: normalizedUploadPath, uploadsPathGuard, GUARDED_UPLOAD_DIRS,
 * guardRootLoadDocument, driverOwnsAnyLoad, sentIfLoadOwnershipUnverified,
 * investorDocumentScope, getInvestorDriverSet, getCarrierDBFromSQLite,
 * LOAD_PANEL_DOCUMENT_FILTER, uploadMissLimiter and its constants, the
 * GET /api/documents/:loadId and GET /api/investor/documents handlers, and
 * EVERY `app.use("/uploads…")` statement, in file order — mounted on a real
 * Express app in front of a real express.static over a temp directory, and
 * driven over HTTP on an ephemeral 127.0.0.1 port.
 *
 * WHAT IS A FIXTURE. An in-memory SQLite, the temp uploads/ tree, a
 * header-driven session, and a scripted loadBelongsToDriver() with the same
 * true / false / null contract (test-load-ownership-guard.js covers the real
 * one). The four directory guards are stubs that only report being reached —
 * each has a runner of its own; here the question is which rule a path lands on.
 *
 * DISCRIMINATION: §7 rebuilds the app with one protective clause removed and
 * requires the matching assertion to flip.
 *
 * No server.js boot, no app.db, no real uploads/, nothing off 127.0.0.1.
 * Run: node scripts/test-uploads-root-guard.js
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const Database = require("better-sqlite3");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

// ---------------------------------------------------------------------------
// Lifting — a small scanner that skips strings, template literals and comments
// while matching brackets, so a `{` or `;` inside either cannot end a lift early.
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

const LIFTED = {
	consts: [
		"LOAD_PANEL_DOCUMENT_FILTER", "INLINE_SAFE_UPLOAD_EXTS", "UPLOAD_MISS_WINDOW_MS", "UPLOAD_MISS_MAX",
		"UPLOAD_MISS_BURST_MAX", "UPLOAD_MISS_KEYS_MAX", "uploadMissCounts", "GUARDED_UPLOAD_DIRS",
	].map(liftConst),
	findCol: liftFn("findCol"),
	getInvestorDriverSet: liftFn("getInvestorDriverSet"),
	getCarrierDBFromSQLite: liftFn("getCarrierDBFromSQLite"),
	investorDocumentScope: liftFn("investorDocumentScope"),
	resolvePreviewUser: liftFn("resolvePreviewUser"),
	sentIfLoadOwnershipUnverified: liftFn("sentIfLoadOwnershipUnverified"),
	driverOwnsAnyLoad: liftFn("driverOwnsAnyLoad"),
	guardRootLoadDocument: liftFn("guardRootLoadDocument"),
	normalizedUploadPath: liftFn("normalizedUploadPath"),
	uploadMissLimiter: liftFn("uploadMissLimiter"),
	uploadsPathGuard: liftFn("uploadsPathGuard"),
	// Every /uploads mount, rate-cons sub-path included, in the order server.js
	// registers them — the order IS part of the guard.
	mounts: liftStatements('\napp.use("/uploads'),
	loadDocsRoute: liftStatements('\napp.get("/api/documents/:loadId"')[0],
	investorDocsRoute: liftStatements('\napp.get("/api/investor/documents"')[0],
};
ok(`lifted every /uploads mount from server.js (${LIFTED.mounts.length})`, LIFTED.mounts.length === 4);
ok("lifted both listing routes", !!LIFTED.loadDocsRoute && !!LIFTED.investorDocsRoute);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const F = {
	A: "L100_POD_1788000000001.pdf",            // Deshorn King's load
	B: "L200_POD_1788000000002.pdf",            // Shorn King's load
	A_DELETED: "L100_Receipt_1788000000003.pdf", // soft-deleted row
	A_RATECON: "L100_RATECON_1788000000004.pdf", // rate con uploaded into the root
	ORPHAN: "L100_POD_1788000000005.pdf",        // file with no row
	UNVERIFIED: "L300_POD_1788000000006.pdf",    // load whose ownership cannot be read
	SHARED: "L100_BOL_1788000000007.pdf",        // ONE name, rows on two loads
	B_UPPER: "L200_Other_1788000000008.pdf",     // row names the driver in capitals
	BACKSLASH: "L200\\POD_1788000000009.pdf",    // a root file with a literal backslash, no row
	CARRIER: "L400_POD_1788000000010.pdf",       // driver reached through the carrier name
};
const body = (name) => `BODY:${name}`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-root-guard-"));
const UP = path.join(TMP, "uploads");
fs.mkdirSync(UP);
for (const name of Object.values(F)) fs.writeFileSync(path.join(UP, name), body(name));
for (const [dir, name] of [["expense-receipts", "r.jpg"], ["invoices", "INV-1.pdf"], ["rate-cons", "L100.pdf"], ["onboarding-signed", "w9-10-signed.pdf"]]) {
	fs.mkdirSync(path.join(UP, dir));
	fs.writeFileSync(path.join(UP, dir, name), body(`${dir}/${name}`));
}

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, driver TEXT NOT NULL, type TEXT NOT NULL,
			file_name TEXT NOT NULL, drive_file_id TEXT DEFAULT '', drive_url TEXT DEFAULT '',
			uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP, ocr_text TEXT DEFAULT '',
			deleted_at DATETIME DEFAULT NULL, deleted_by TEXT DEFAULT '', delete_reason TEXT DEFAULT ''
		);
		CREATE INDEX idx_documents_file_name ON documents(file_name);
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, company_name TEXT DEFAULT '');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, owner_id INTEGER, assigned_driver TEXT DEFAULT '');
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY, truck_id INTEGER, driver_name TEXT DEFAULT '', end_date TEXT DEFAULT '');
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY, driver_name TEXT, carrier_name TEXT DEFAULT '',
			state TEXT, city TEXT, zip TEXT, address TEXT, trucks TEXT, hazmat TEXT, phone TEXT, cell TEXT,
			email TEXT, dot TEXT, mc TEXT, rating TEXT, status TEXT);
		CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT);
	`);
	const doc = db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, deleted_at) VALUES (?, ?, ?, ?, ?, ?)");
	const add = (load, driver, type, name, deleted = null) => doc.run(load, driver, type, name, `/uploads/${name}`, deleted);
	add("L100", "Deshorn King", "POD", F.A);
	add("L200", "Shorn King", "POD", F.B);
	add("L100", "Deshorn King", "Receipt", F.A_DELETED, "2026-09-01T00:00:00Z");
	add("L100", "Deshorn King", "RATECON", F.A_RATECON);
	add("L300", "Deshorn King", "POD", F.UNVERIFIED);
	add("L100", "Deshorn King", "BOL", F.SHARED);
	add("L200", "Shorn King", "BOL", F.SHARED);
	add("L200", "SHORN KING", "Other", F.B_UPPER);
	add("L400", "Howard Reddie", "POD", F.CARRIER);
	db.exec(`
		INSERT INTO users (id, username, role, company_name) VALUES
			(50, 'inv_acme', 'Investor', 'Acme Haul'), (51, 'inv_bravo', 'Investor', ''), (52, 'inv_empty', 'Investor', '');
		INSERT INTO trucks (id, owner_id, assigned_driver) VALUES (1, 50, 'Deshorn King'), (2, 51, 'Shorn King');
		INSERT INTO drivers_directory (id, driver_name, carrier_name) VALUES (1, 'Howard Reddie', 'Acme Haul');
	`);
	return db;
}

// The same three answers as the real guard: true, false, or null (could not verify).
const LOAD_OWNER = { L100: "deshorn king", L200: "shorn king", L400: "howard reddie" };
const UNVERIFIABLE = new Set(["L300"]);
async function loadBelongsToDriver(loadId, driverName) {
	if (!loadId || !driverName) return false;
	if (UNVERIFIABLE.has(loadId)) return null;
	return LOAD_OWNER[loadId] === String(driverName).trim().toLowerCase();
}

const U = {
	sa: { id: 1, role: "Super Admin", username: "super_admin" },
	disp: { id: 2, role: "Dispatcher", username: "dispatch1" },
	drvA: { id: 10, role: "Driver", username: "deshorn", driverName: "Deshorn King" },
	drvB: { id: 11, role: "Driver", username: "shorn", driverName: "Shorn King" },
	drvBlank: { id: 12, role: "Driver", username: "blank", driverName: "" },
	inv1: { id: 50, role: "Investor", username: "inv_acme" },
	inv2: { id: 51, role: "Investor", username: "inv_bravo" },
	inv3: { id: 52, role: "Investor", username: "inv_empty" },
	odd: { id: 60, role: "Auditor", username: "odd" },
};

// ---------------------------------------------------------------------------
// The app: fixtures in front, then the lifted code registers itself exactly as
// server.js does, then an SPA-style catch-all like the one at the bottom of
// server.js, so a miss that escaped /uploads would show up as a 200 page.
// ---------------------------------------------------------------------------
const clock = { now: Date.now() };
class FakeDate extends Date { static now() { return clock.now; } }

function compose(L) {
	return [
		'"use strict";',
		...L.consts, L.findCol, L.getInvestorDriverSet, L.getCarrierDBFromSQLite, L.investorDocumentScope,
		L.resolvePreviewUser, L.sentIfLoadOwnershipUnverified, L.driverOwnsAnyLoad, L.guardRootLoadDocument,
		L.normalizedUploadPath, L.uploadMissLimiter, L.uploadsPathGuard,
		...L.mounts, L.loadDocsRoute, L.investorDocsRoute,
		"return { uploadMissCounts, UPLOAD_MISS_MAX, UPLOAD_MISS_BURST_MAX, UPLOAD_MISS_WINDOW_MS, guardRootLoadDocument, uploadMissLimiter };",
	].join("\n");
}

const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
const servers = [];

async function build(L = LIFTED, { db = makeDb() } = {}) {
	const app = express();
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	const requireAuth = (req, res, next) =>
		(req.session && req.session.user ? next() : res.status(401).json({ error: "Not authenticated" }));
	const requireRole = (...roles) => (req, res, next) => {
		const u = req.session && req.session.user;
		if (!u) return res.status(401).json({ error: "Not authenticated" });
		if (!roles.includes(u.role)) return res.status(403).json({ error: "Forbidden" });
		next();
	};
	const stub = (name) => (req, res) => { res.setHeader("X-Test-Guard", name); res.status(404).end(); };
	const logs = [];
	const fakeConsole = { log() {}, warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
	const mod = new Function(
		"app", "express", "path", "__dirname", "db", "requireAuth", "requireRole", "loadBelongsToDriver",
		"guardDriverSignedDoc", "guardInvestorSignedDoc", "guardInvoicePdf", "guardDrugTestFile", "console", "Date",
		compose(L),
	)(app, express, path, TMP, db, requireAuth, requireRole, loadBelongsToDriver,
		stub("guardDriverSignedDoc"), stub("guardInvestorSignedDoc"), stub("guardInvoicePdf"), stub("guardDrugTestFile"),
		fakeConsole, FakeDate);
	app.get("*", (req, res) => res.status(200).send("<html>SPA-CATCH-ALL</html>"));
	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	const port = server.address().port;
	const get = (urlPath, user, method = "GET") => new Promise((resolve, reject) => {
		const req = http.request({
			host: "127.0.0.1", port, method, path: urlPath, agent,
			headers: user ? { "x-test-user": JSON.stringify(user) } : {},
		}, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end();
	});
	return { ...mod, get, logs, db };
}

const url = (name) => `/uploads/${encodeURIComponent(name)}`;
const served = (r, name) => r.status === 200 && r.body === body(name);
const refused = (r, name) => r.status === 404 && !r.body.includes(body(name));
// Server-side "finish" handlers run before the client sees "end" in practice;
// a short wait makes the counter reads independent of that ordering.
const settle = () => new Promise((r) => setTimeout(r, 25));

// Drive the lifted limiter directly, holding requests IN FLIGHT — the one state
// HTTP timing cannot pin. Returns the response, whether it passed, and a finisher.
const { EventEmitter } = require("events");
function admit(limiter, user) {
	const res = new EventEmitter();
	Object.assign(res, {
		statusCode: 200, headers: {},
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		status(c) { this.statusCode = c; return this; },
		json() { return this; }, end() { return this; },
	});
	let passed = false;
	limiter({ session: { user } }, res, () => { passed = true; });
	return { res, passed, finish(code) { res.statusCode = code; res.emit("finish"); res.emit("close"); } };
}

(async () => {
	const T = await build();
	const refusals = [];
	const expectRefused = async (user, name, label) => {
		const r = await T.get(url(name), user);
		refusals.push(r);
		ok(label, refused(r, name));
	};

	// =========================================================================
	console.log("\n§1  who may read a document in the uploads root");
	// =========================================================================
	for (const [who, u] of [["Super Admin", U.sa], ["Dispatcher", U.disp]]) {
		ok(`${who} reads any load's root document`, served(await T.get(url(F.A), u), F.A) && served(await T.get(url(F.B), u), F.B));
		ok(`${who} keeps reading a root file with no documents row (access unchanged)`, served(await T.get(url(F.ORPHAN), u), F.ORPHAN));
	}
	ok("Super Admin reads a soft-deleted document", served(await T.get(url(F.A_DELETED), U.sa), F.A_DELETED));

	ok("a Driver reads their OWN load's root document", served(await T.get(url(F.A), U.drvA), F.A));
	ok("...and so does the other driver, for theirs", served(await T.get(url(F.B), U.drvB), F.B));
	await expectRefused(U.drvA, F.B, "a Driver is refused ANOTHER load's root document (404)");
	await expectRefused(U.drvB, F.A, "...in both directions");
	await expectRefused(U.drvA, F.ORPHAN, "a Driver is refused a root file with no row");
	await expectRefused(U.drvA, F.A_DELETED, "a Driver is refused their own SOFT-DELETED document (their panel no longer lists it)");
	await expectRefused(U.drvA, F.A_RATECON, "a Driver is refused a RATE CON in the root, even on their own load (their panel hides it)");
	await expectRefused(U.drvBlank, F.A, "a Driver session with no driver name is refused");
	{
		const r = await T.get(url(F.UNVERIFIED), U.drvA);
		let parsed = {};
		try { parsed = JSON.parse(r.body); } catch {}
		ok("ownership that cannot be verified → 503 LOAD_OWNERSHIP_UNVERIFIED, retryable, no file bytes",
			r.status === 503 && parsed.code === "LOAD_OWNERSHIP_UNVERIFIED" && parsed.retryable === true &&
			r.headers["retry-after"] === "5" && !r.body.includes(body(F.UNVERIFIED)));
	}
	ok("MEMBERSHIP: one name with rows on two loads opens for BOTH drivers",
		served(await T.get(url(F.SHARED), U.drvA), F.SHARED) && served(await T.get(url(F.SHARED), U.drvB), F.SHARED));

	ok("an Investor reads a document of a driver on their truck", served(await T.get(url(F.A), U.inv1), F.A));
	ok("...and of a driver reached through their carrier name", served(await T.get(url(F.CARRIER), U.inv1), F.CARRIER));
	ok("...matched case-insensitively, exactly as the portal's LOWER(driver) does", served(await T.get(url(F.B_UPPER), U.inv2), F.B_UPPER));
	ok("...including a rate con, because the portal lists those too", served(await T.get(url(F.A_RATECON), U.inv1), F.A_RATECON));
	await expectRefused(U.inv1, F.B, "an Investor is refused a document of a driver who is not theirs");
	await expectRefused(U.inv2, F.A, "...in both directions");
	await expectRefused(U.inv1, F.A_DELETED, "an Investor is refused a soft-deleted document");
	await expectRefused(U.inv1, F.ORPHAN, "an Investor is refused a root file with no row");
	await expectRefused(U.inv3, F.A, "an Investor with no drivers is refused everything");
	await expectRefused(U.odd, F.A, "an unrecognized role is refused");
	ok("every refusal above is a 404, never a 403 (a 403 would confirm the name exists)",
		refusals.length >= 12 && refusals.every((r) => r.status === 404));
	ok("no refusal carried a body", refusals.every((r) => r.body === ""));
	ok("an unauthenticated request never reaches the guard (401)", (await T.get(url(F.A), null)).status === 401);

	// =========================================================================
	console.log("\n§2  every spelling of another load's document is refused");
	// =========================================================================
	// Driver B asking for Driver A's POD. Each shape is one the guard and
	// express.static could disagree about if the guard judged the raw request.
	const VARIANTS = [
		["plain", `/uploads/${F.A}`],
		["doubled slash", `/uploads//${F.A}`],
		["encoded leading slash", `/uploads/%2F${F.A}`],
		["dot segment", `/uploads/./${F.A}`],
		["encoded letter", `/uploads/%4C100_POD_1788000000001.pdf`],
		["encoded _ and .", `/uploads/L100%5FPOD%5F1788000000001%2Epdf`],
		["mixed-case name (resolves on a case-insensitive filesystem)", `/uploads/l100_pod_1788000000001.PDF`],
		["mixed-case mount", `/UPLOADS/${F.A}`],
		["`..` through a sibling directory", `/uploads/expense-receipts/../${F.A}`],
		["encoded `..`", `/uploads/x/%2e%2e/${F.A}`],
		["encoded separator + `..`", `/uploads/x%2F..%2F${F.A}`],
		["backslash", `/uploads/x%5C..%5C${F.A}`],
		["trailing slash", `/uploads/${F.A}/`],
		["NUL", `/uploads/${F.A}%00`],
		["query string", `/uploads/${F.A}?download=1`],
		["malformed escape", `/uploads/${F.A}%E0%A4%A`],
	];
	for (const [label, p] of VARIANTS) {
		const r = await T.get(p, U.drvB);
		ok(`${label}: refused with no file bytes (${r.status})`, r.status === 404 && !r.body.includes(body(F.A)));
	}
	{
		const r = await T.get(`/uploads/${F.A}`, U.drvB, "HEAD");
		ok("HEAD is refused the same way", r.status === 404);
	}
	ok("the OWNER's percent-encoded spelling still opens (decoded, then matched exactly)",
		served(await T.get(`/uploads/%4C100%5FPOD%5F1788000000001%2Epdf`, U.drvA), F.A));
	ok("the OWNER's doubled-slash spelling still opens", served(await T.get(`/uploads//${F.A}`, U.drvA), F.A));
	ok("the OWNER's mixed-case spelling finds no row and is refused (fails closed)",
		refused(await T.get(`/uploads/l100_pod_1788000000001.PDF`, U.drvA), F.A));
	ok("a trailing slash never serves the file, even to its owner", refused(await T.get(`/uploads/${F.A}/`, U.drvA), F.A));
	ok("a root file whose name holds a backslash is unreachable (%5C is refused before any lookup)",
		refused(await T.get(url(F.BACKSLASH), U.sa), F.BACKSLASH) && refused(await T.get(url(F.BACKSLASH), U.drvA), F.BACKSLASH));

	// =========================================================================
	console.log("\n§3  directories keep their own rules");
	// =========================================================================
	for (const [p, guard] of [
		["/uploads/invoices/INV-1.pdf", "guardInvoicePdf"],
		["/uploads/Invoices/INV-1.pdf", "guardInvoicePdf"],
		["/uploads/onboarding-signed/w9-10-signed.pdf", "guardDriverSignedDoc"],
	]) {
		const r = await T.get(p, U.drvA);
		ok(`${p} reaches ${guard}, not the root rule`, r.headers["x-test-guard"] === guard);
	}
	ok("/uploads/rate-cons/<id>.pdf keeps its role gate (403 to a Driver)", (await T.get("/uploads/rate-cons/L100.pdf", U.drvA)).status === 403);
	ok("/uploads/rate-cons/<id>.pdf still opens for a Dispatcher", served(await T.get("/uploads/rate-cons/L100.pdf", U.disp), "rate-cons/L100.pdf"));
	ok("an unguarded directory is unchanged (a Driver still opens expense-receipts/)",
		served(await T.get("/uploads/expense-receipts/r.jpg", U.drvA), "expense-receipts/r.jpg"));
	ok("a directory name without its slash is a single segment → root rule → 404 to a Driver",
		(await T.get("/uploads/invoices", U.drvA)).status === 404);

	// =========================================================================
	console.log("\n§4  every file the portals list still opens — and only those");
	// =========================================================================
	for (const inv of [U.inv1, U.inv2]) {
		const r = await T.get("/api/investor/documents", inv);
		const docs = (JSON.parse(r.body).documents || []).filter((d) => /^\/uploads\/[^/]+$/.test(d.drive_url));
		ok(`${inv.username}: the portal lists root documents (${docs.length})`, r.status === 200 && docs.length >= 2);
		let opened = 0;
		for (const d of docs) if (served(await T.get(d.drive_url, inv), d.file_name)) opened++;
		ok(`${inv.username}: every one of them opens (${opened}/${docs.length})`, opened === docs.length);
		const listed = new Set(docs.map((d) => d.file_name));
		let leaked = 0;
		for (const name of Object.values(F)) {
			if (listed.has(name)) continue;
			if ((await T.get(url(name), inv)).status === 200) leaked++;
		}
		ok(`${inv.username}: no root file the portal does NOT list opens`, leaked === 0);
	}
	{
		const r = await T.get("/api/documents/L100", U.drvA);
		const docs = (JSON.parse(r.body).documents || []);
		ok("Driver A: their load's Documents panel lists root documents", r.status === 200 && docs.length >= 2);
		let opened = 0;
		for (const d of docs) if (served(await T.get(d.drive_url, U.drvA), d.file_name)) opened++;
		ok(`Driver A: every listed document opens (${opened}/${docs.length})`, opened === docs.length);
		const listed = new Set(docs.map((d) => d.file_name));
		ok("Driver A: the panel hides the soft-deleted document and the rate con — and so does the guard",
			!listed.has(F.A_DELETED) && !listed.has(F.A_RATECON) &&
			refused(await T.get(url(F.A_DELETED), U.drvA), F.A_DELETED) && refused(await T.get(url(F.A_RATECON), U.drvA), F.A_RATECON));
		ok("Driver A cannot list another driver's load (the lifted route's own check)",
			(await T.get("/api/documents/L200", U.drvA)).status === 403);
	}

	// =========================================================================
	console.log("\n§5  a miss is a 404, and 404s are limited per user");
	// =========================================================================
	{
		const r = await T.get("/uploads/L999_POD_1.pdf", U.sa);
		ok("a missing root file answers 404 to staff — not the SPA page", r.status === 404 && !r.body.includes("SPA-CATCH-ALL"));
		const s = await T.get("/uploads/expense-receipts/nope.jpg", U.sa);
		ok("a missing file in a subdirectory answers 404 too", s.status === 404 && !s.body.includes("SPA-CATCH-ALL"));
	}
	const MAX = T.UPLOAD_MISS_MAX, BURST = T.UPLOAD_MISS_BURST_MAX;
	ok(`the shipped limits are small and ordered (${MAX} misses, ${BURST} with requests in flight, per ${T.UPLOAD_MISS_WINDOW_MS / 60000} min)`,
		MAX > 0 && MAX <= 100 && BURST > MAX && T.UPLOAD_MISS_WINDOW_MS === 15 * 60 * 1000);
	const guesser = { id: 70, role: "Driver", username: "guesser", driverName: "Nobody Here" };
	for (let i = 0; i < MAX; i++) await T.get(`/uploads/L100_POD_${1788000000100 + i}.pdf`, guesser);
	await settle();
	ok(`after ${MAX} misses the counter holds ${MAX}`, T.uploadMissCounts.get("u:70").misses === MAX);
	{
		const r = await T.get(url(F.A), guesser);
		ok("the next /uploads request is refused 429 with Retry-After", r.status === 429 && Number(r.headers["retry-after"]) > 0);
		await T.get(url(F.A), guesser);
		await settle();
		ok("a 429 is not itself counted as a miss", T.uploadMissCounts.get("u:70").misses === MAX);
	}
	{
		// In flight: nothing has finished, so nothing is a miss yet.
		const u = { id: 75, role: "Investor" };
		const held = Array.from({ length: BURST }, () => admit(T.uploadMissLimiter, u));
		const over = admit(T.uploadMissLimiter, u);
		ok(`${BURST} requests in flight at once are all admitted (a heavy page fits)`, held.every((h) => h.passed));
		ok(`request ${BURST + 1} in flight is refused 429 — a burst cannot outrun the count`,
			!over.passed && over.res.statusCode === 429);
		held.forEach((h) => h.finish(200));
		const w = T.uploadMissCounts.get("u:75");
		ok("once they finish as successes, nothing is counted and nothing is in flight", w.misses === 0 && w.inflight === 0);
		ok("...and the next request is admitted", admit(T.uploadMissLimiter, u).passed);
		const two = [admit(T.uploadMissLimiter, u), admit(T.uploadMissLimiter, u)];
		two[0].finish(404); two[1].finish(404); two[1].finish(404);   // a second finish must not count twice
		ok("a finished 404 counts once, however many events it emits", T.uploadMissCounts.get("u:75").misses === 2);
	}
	ok("the limit is per USER: another session is unaffected", (await T.get(`/uploads/L100_POD_1.pdf`, { ...guesser, id: 71 })).status === 404);
	{
		const heavy = { ...U.drvA, id: 72 };
		const rs = await Promise.all(Array.from({ length: 150 }, () => T.get(url(F.A), heavy)));
		ok("150 simultaneous successful reads all succeed (a heavy page is not a burst of misses)",
			rs.every((r) => served(r, F.A)));
		await settle();
		const w = T.uploadMissCounts.get("u:72");
		ok("...and leave nothing counted or in flight", w.misses === 0 && w.inflight === 0);
	}
	{
		const flaky = { ...U.drvA, id: 74 };
		for (let i = 0; i < 5; i++) await T.get(url(F.UNVERIFIED), flaky);
		await settle();
		ok("a 503 (could not verify) is not counted as a miss", T.uploadMissCounts.get("u:74").misses === 0);
	}
	{
		const burster = { id: 73, role: "Investor", username: "burster" };   // no scope: every root read misses
		const n = BURST + 60;
		const rs = await Promise.all(Array.from({ length: n }, (_, i) => T.get(`/uploads/L100_POD_${1788000100000 + i}.pdf`, burster)));
		const misses = rs.filter((r) => r.status === 404).length, limited = rs.filter((r) => r.status === 429).length;
		ok(`a burst of ${n} simultaneous misses gets at most ${BURST} answers (${misses} × 404, ${limited} × 429)`,
			misses <= BURST && misses + limited === n);
		ok("...and the session is then blocked", (await T.get(url(F.A), burster)).status === 429);
	}
	{
		clock.now += T.UPLOAD_MISS_WINDOW_MS;
		ok("once the window has passed, the blocked session is admitted again", (await T.get(url(F.A), guesser)).status === 404);
		await settle();
		ok("...with a fresh count", T.uploadMissCounts.get("u:70").misses === 1);
	}

	// =========================================================================
	console.log("\n§6  failure and wiring");
	// =========================================================================
	{
		const broken = { prepare() { throw Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { code: "SQLITE_IOERR" }); } };
		const B = await build(LIFTED, { db: broken });
		const call = async (user) => {
			let status = null, nexted = false;
			const res = { headersSent: false, statusCode: 200, setHeader() {}, status(c) { status = c; return this; }, end() { return this; }, json() { return this; } };
			await B.guardRootLoadDocument({ session: { user } }, res, () => { nexted = true; }, F.A);
			return { status, nexted };
		};
		for (const [who, u] of [["Driver", U.drvA], ["Investor", U.inv1]]) {
			const r = await call(u);
			ok(`${who}: an unreadable documents table refuses (404) and never passes`, r.status === 404 && !r.nexted);
		}
		ok("staff are decided without touching the database", (await call(U.sa)).nexted === true);
		let rejected = false;
		try { await B.guardRootLoadDocument({ session: {} }, { headersSent: false, status() { return this; }, end() { return this; } }, () => {}, F.A); }
		catch { rejected = true; }
		ok("⚠️ the async guard never rejects (a rejection would end the process)", rejected === false);
	}
	const lineOf = (needle) => SRC.split("\n").findIndex((l) => l.startsWith(needle));
	const guardAt = lineOf('app.use("/uploads", requireAuth, uploadMissLimiter, uploadsPathGuard);');
	const staticAt = lineOf('app.use("/uploads", requireAuth, express.static(');
	const endAt = lineOf('app.use("/uploads", requireAuth, (req, res) => res.status(404).end());');
	const spaAt = lineOf('app.get("*"');
	ok("server.js mounts: guard (behind requireAuth and the miss limiter) → static → terminal 404 → SPA catch-all",
		guardAt > 0 && guardAt < staticAt && staticAt < endAt && endAt < spaAt);
	ok("uploadsPathGuard sends every single-segment path to guardRootLoadDocument",
		/if \(segments\.length === 1\) return guardRootLoadDocument\(req, res, next, segments\[0\]\);/.test(LIFTED.uploadsPathGuard));
	ok("guardRootLoadDocument uses .all(), never .get() — file_name is not unique",
		/\.all\(/.test(LIFTED.guardRootLoadDocument) && !/\.get\(/.test(LIFTED.guardRootLoadDocument));
	ok("the driver's panel and the guard read ONE filter (LOAD_PANEL_DOCUMENT_FILTER)",
		LIFTED.loadDocsRoute.includes("${LOAD_PANEL_DOCUMENT_FILTER}") && LIFTED.guardRootLoadDocument.includes("${LOAD_PANEL_DOCUMENT_FILTER}"));
	ok("the investor portal and the guard read ONE scope (investorDocumentScope)",
		LIFTED.investorDocsRoute.includes("investorDocumentScope(user.id)") && LIFTED.guardRootLoadDocument.includes("investorDocumentScope(user.id)"));
	ok("idx_documents_file_name exists and is NOT unique",
		/CREATE INDEX IF NOT EXISTS idx_documents_file_name ON documents\(file_name\)/.test(SRC) &&
		!/CREATE UNIQUE INDEX[^\n]*documents\s*\(\s*file_name/.test(SRC));
	ok("no unexpected errors were logged by the guard or the routes", T.logs.length === 0);

	// =========================================================================
	console.log("\n§7  DISCRIMINATION — remove a protective clause, the matching assertion must flip");
	// =========================================================================
	const mutate = (key, from, to) => {
		const src = LIFTED[key];
		if (!src.includes(from)) die(`mutant anchor not found in ${key}: ${from}`);
		return { ...LIFTED, [key]: src.replace(from, to) };
	};
	{
		const M = await build(mutate("uploadsPathGuard",
			"if (segments.length === 1) return guardRootLoadDocument(req, res, next, segments[0]);", ""));
		ok("MUTANT no root rule: Driver B reads Driver A's POD — so §1's refusal is load-bearing",
			served(await M.get(url(F.A), U.drvB), F.A));
	}
	{
		const M = await build(mutate("normalizedUploadPath",
			'if (rel.includes("\\\\")) return null;\n\tconst collapsed = rel.replace(/\\/{2,}/g, "/");',
			'const collapsed = rel.replace(/\\\\/g, "/").replace(/\\/{2,}/g, "/");'));
		ok("MUTANT backslash folded instead of refused: a root file slips past the root rule as a 2-segment path",
			served(await M.get(url(F.BACKSLASH), U.drvA), F.BACKSLASH));
	}
	{
		const M = await build(mutate("uploadMissLimiter",
			"if (w.misses >= UPLOAD_MISS_MAX || w.misses + w.inflight >= UPLOAD_MISS_BURST_MAX) {",
			"if (false) {"));
		for (let i = 0; i < MAX; i++) await M.get(`/uploads/L100_POD_${1788000200000 + i}.pdf`, guesser);
		ok("MUTANT no admission check: the guesser is never refused — so §5's 429 is load-bearing",
			(await M.get(url(F.A), guesser)).status === 404);
	}
	{
		const M = await build(mutate("uploadMissLimiter",
			" || w.misses + w.inflight >= UPLOAD_MISS_BURST_MAX", ""));
		const u = { id: 76, role: "Investor" };
		Array.from({ length: BURST }, () => admit(M.uploadMissLimiter, u));
		ok("MUTANT no in-flight term: a burst past the cap is admitted — so §5's burst refusal is load-bearing",
			admit(M.uploadMissLimiter, u).passed === true);
	}

	for (const s of servers) s.close();
	agent.destroy();
	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => {
	console.error("FAIL  runner crashed:", err && err.stack);
	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
	process.exit(1);
});
