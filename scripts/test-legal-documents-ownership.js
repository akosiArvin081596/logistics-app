#!/usr/bin/env node
/**
 * An Investor uploads and deletes legal documents only for what is theirs.
 *
 * POST /api/legal-documents/upload and DELETE /api/legal-documents/:id admit
 * Super Admin and Investor. For an Investor:
 *   - upload: `investorId`, when sent, must be their own investors record (left
 *     out, it is theirs); `truckId`, when sent, must be a truck they own; and
 *     `driverId` is refused (the Investor portal never sends one). Anything
 *     else is 403 NOT_OWNER, before a byte is written: no row, no file.
 *   - delete: only a document uploaded under their own account AND still filed
 *     against their own investors record or a truck they own. Anything else is
 *     404 DOCUMENT_NOT_FOUND, the same body as a missing id; nothing deleted.
 * A Super Admin's uploads and deletes are unchanged.
 *
 * WHAT IS ASSERTED. Both handlers are lifted out of server.js, with the file
 * checks they call (validateFileExt, verifyInlineServedBytes), and run against
 * an in-memory SQLite built from server.js's own legal_documents DDL and a
 * fresh mkdtemp as the upload root.
 *   §1 Investor uploads: the portal's own request (profile level, and from a
 *      truck of theirs) stores; another investor's record, another's truck, a
 *      truck that does not exist, or any driverId: 403 NOT_OWNER, nothing
 *      stored or written to disk.
 *   §2 Super Admin uploads against any investor, truck or driver: unchanged.
 *   §3 Investor deletes: their own upload goes; another investor's document,
 *      an admin's document on their own truck, their own upload on a truck they
 *      no longer own, and a missing id: 404 DOCUMENT_NOT_FOUND with one body,
 *      the row and the file left in place.
 *   §4 Super Admin deletes anything, and a missing id is still 404.
 *   §5 source pins: each check precedes its route's first write.
 *   §6 MUTANTS: either ownership check dropped is caught.
 *
 * Pure: no server, no app.db, no network (files go to a temporary directory).
 *
 * Run: node scripts/test-legal-documents-ownership.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${name}()`);
	return SRC.slice(a, end + 2);
}
function liftLine(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 line starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf("\n", a));
}
function liftRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const HEADS = {
	upload: 'app.post("/api/legal-documents/upload", requireRole("Super Admin", "Investor"), async (req, res) => {',
	del: 'app.delete("/api/legal-documents/:id", requireRole("Super Admin", "Investor"), (req, res) => {',
};
const ROUTES = Object.fromEntries(Object.entries(HEADS).map(([k, h]) => [k, liftRoute(h)]));
const HELPERS = new Function("path", `"use strict";\n${[
	liftLine("const ALLOWED_FILE_EXTS = "),
	liftLine("function validateFileExt(fileName) "),
	liftFunction("sniffImageFormat"),
	liftFunction("verifyInlineServedBytes"),
].join("\n")}\nreturn { validateFileExt, verifyInlineServedBytes };`)(path);

// ── fixtures ────────────────────────────────────────────────────────────────
function legalDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS legal_documents \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE legal_documents");
	const alters = ["investor_id", "driver_id", "visible_to_driver"].map((col) => {
		const a = SRC.match(new RegExp(`ALTER TABLE legal_documents ADD COLUMN ${col} [^"]*`));
		if (!a) die(`could not locate the legal_documents.${col} migration`);
		return a[0];
	});
	return [`CREATE TABLE legal_documents (${m[1]}\n)`, ...alters];
}
const SUPER = { id: 1, username: "super_admin", role: "Super Admin" };
const INV_A = { id: 2, username: "inv_a", role: "Investor" };
const INV_B = { id: 3, username: "inv_b", role: "Investor" };
const INV_NONE = { id: 4, username: "inv_norecord", role: "Investor" }; // no investors record
const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n% QA\n").toString("base64")}`;

function makeWorld() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "legal-docs-"));
	const db = new Database(":memory:");
	for (const sql of legalDdl()) db.exec(sql);
	db.exec("CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT)");
	db.exec("CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, owner_id INTEGER DEFAULT 0)");
	db.prepare("INSERT INTO investors (id, user_id, full_name) VALUES (16, 2, 'Investor A')").run();
	db.prepare("INSERT INTO investors (id, user_id, full_name) VALUES (17, 3, 'Investor B')").run();
	db.prepare("INSERT INTO trucks (id, unit_number, owner_id) VALUES (19, 'TA-1', 2)").run();
	db.prepare("INSERT INTO trucks (id, unit_number, owner_id) VALUES (20, 'TB-1', 3)").run();
	return { root, db };
}
const legalDir = (w) => path.join(w.root, "uploads", "legal");
const filesOnDisk = (w) => (fs.existsSync(legalDir(w)) ? fs.readdirSync(legalDir(w)).length : 0);
const rows = (w) => w.db.prepare("SELECT * FROM legal_documents ORDER BY id").all();

function mountRoute(routeSrc, env) {
	let handler = null;
	const grab = (p, ...fns) => { handler = fns[fns.length - 1]; };
	const all = { app: { post: grab, delete: grab }, requireRole: () => (req, res, next) => next(), ...env };
	const names = Object.keys(all);
	new Function(...names, routeSrc)(...names.map((k) => all[k]));
	if (typeof handler !== "function") die("a lifted route did not register a handler");
	return async (req) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
		const e = console.error;
		console.error = () => {};
		try { await handler({ params: {}, query: {}, body: {}, ...req }, res); } finally { console.error = e; }
		return out;
	};
}
function mount(w, routes = ROUTES) {
	const env = { db: w.db, fs, path, __dirname: w.root, ...HELPERS };
	const up = mountRoute(routes.upload, env);
	const del = mountRoute(routes.del, env);
	return {
		upload: (user, body) => up({ session: { user }, body }),
		del: (user, id) => del({ session: { user }, params: { id: String(id) } }),
	};
}
// The body LegalDocumentPortal.vue sends from the Investor portal (no truck
// picker, no investor or driver id), with `over` on top.
const portalBody = (name, over = {}) => ({
	truckId: 0, unitNumber: "", docType: "Other", fileName: name, fileData: PDF, notes: "",
	uploadedBy: "x", investorId: undefined, driverId: undefined, visibleToDriver: false, ...over,
});

// ─────────────────────────────────────────────────────── §1 Investor uploads
async function investorUploadSection(routes) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const app = mount(w, routes);
	const own = await app.upload(INV_A, portalBody("a-profile.pdf"));
	const ownRow = rows(w).find((x) => x.id === Number(own.body && own.body.id));
	t(own.status === 200 && ownRow && ownRow.investor_id === 16 && ownRow.truck_id === 0 && ownRow.uploaded_by === "inv_a",
		`§1 the portal's own upload stores against A's investors record (got ${own.status} ${JSON.stringify(ownRow)})`);
	const ownTruck = await app.upload(INV_A, portalBody("a-truck.pdf", { truckId: 19, unitNumber: "TA-1" }));
	t(ownTruck.status === 200 && rows(w).some((x) => x.truck_id === 19 && x.file_name === "a-truck.pdf"),
		`§1 an upload from A's own truck stores on that truck (got ${ownTruck.status})`);
	const ownId = await app.upload(INV_A, portalBody("a-own-id.pdf", { investorId: 16 }));
	t(ownId.status === 200, `§1 naming their own investors record is accepted (got ${ownId.status})`);

	const beforeRows = rows(w).length;
	const beforeFiles = filesOnDisk(w);
	for (const [label, user, over] of [
		["B names A's investors record", INV_B, { investorId: 16 }],
		["B names A's record as text", INV_B, { investorId: "16" }],
		["B names A's truck", INV_B, { truckId: 19, unitNumber: "TA-1" }],
		["B names a truck that does not exist", INV_B, { truckId: 999 }],
		["B names A's truck beside their own record", INV_B, { truckId: 19, investorId: 17 }],
		["an Investor names a driver", INV_A, { driverId: 7 }],
		["an Investor names a driver as text", INV_A, { driverId: "7" }],
		["an Investor with no record names one", INV_NONE, { investorId: 16 }],
	]) {
		const x = await app.upload(user, portalBody(`refused-${label.replace(/\W+/g, "-")}.pdf`, over));
		t(x.status === 403 && x.body && x.body.code === "NOT_OWNER", `§1 ${label}: 403 NOT_OWNER (got ${x.status} ${JSON.stringify(x.body)})`);
	}
	t(rows(w).length === beforeRows, `§1 ...no refused upload stored a row (${rows(w).length - beforeRows} extra)`);
	t(filesOnDisk(w) === beforeFiles, `§1 ...and none wrote a file (${filesOnDisk(w) - beforeFiles} extra)`);
	fs.rmSync(w.root, { recursive: true, force: true });
	return r;
}

// ─────────────────────────────────────────────────────── §2 Super Admin uploads
async function adminUploadSection(routes) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const app = mount(w, routes);
	const inv = await app.upload(SUPER, portalBody("sa-inv.pdf", { investorId: 16 }));
	const truck = await app.upload(SUPER, portalBody("sa-truck.pdf", { truckId: 20, unitNumber: "TB-1", visibleToDriver: true }));
	const drv = await app.upload(SUPER, portalBody("sa-driver.pdf", { driverId: 7 }));
	const byName = (n) => rows(w).find((x) => x.file_name === n) || {};
	t(inv.status === 200 && byName("sa-inv.pdf").investor_id === 16, "§2 a Super Admin files against any investors record");
	t(truck.status === 200 && byName("sa-truck.pdf").truck_id === 20 && byName("sa-truck.pdf").visible_to_driver === 1, "§2 ...against any truck, driver-visible");
	t(drv.status === 200 && byName("sa-driver.pdf").driver_id === 7 && byName("sa-driver.pdf").truck_id === 0, "§2 ...and against a driver");
	fs.rmSync(w.root, { recursive: true, force: true });
	return r;
}

// ─────────────────────────────────────────────────────── §3 / §4 deletes
async function deleteSection(routes) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const w = makeWorld();
	const app = mount(w, routes);
	const idOf = async (user, name, over) => Number((await app.upload(user, portalBody(name, over))).body.id);
	const aProfile = await idOf(INV_A, "a-profile.pdf");
	const aTruck = await idOf(INV_A, "a-truck.pdf", { truckId: 19, unitNumber: "TA-1" });
	const aMoved = await idOf(INV_A, "a-moved.pdf", { truckId: 19, unitNumber: "TA-1" });
	const adminOnA = await idOf(SUPER, "admin-on-a.pdf", { truckId: 19, unitNumber: "TA-1" });
	const bProfile = await idOf(INV_B, "b-profile.pdf");
	const fileOf = (id) => path.join(w.root, w.db.prepare("SELECT file_url FROM legal_documents WHERE id = ?").get(id).file_url);
	const exists = (id) => !!w.db.prepare("SELECT 1 FROM legal_documents WHERE id = ?").get(id);

	const missing = await app.del(INV_B, 99999);
	t(missing.status === 404 && missing.body.code === "DOCUMENT_NOT_FOUND", `§3 a missing id: 404 DOCUMENT_NOT_FOUND (got ${missing.status} ${JSON.stringify(missing.body)})`);
	const aFile = fileOf(aProfile);
	for (const [label, user, id] of [
		["B deletes A's profile document", INV_B, aProfile],
		["B deletes A's truck document", INV_B, aTruck],
		["A deletes the admin's document on A's own truck", INV_A, adminOnA],
	]) {
		const x = await app.del(user, id);
		t(x.status === 404 && JSON.stringify(x.body) === JSON.stringify(missing.body),
			`§3 ${label}: 404 with the missing-id body (got ${x.status} ${JSON.stringify(x.body)})`);
		t(exists(id), `§3 ...and the row is still there`);
	}
	t(fs.existsSync(aFile), "§3 ...and A's file is still on disk");
	// A truck-only row A uploaded (investor_id 0, as a row filed before uploads
	// were also tagged with the investor's record), after the truck moved to B.
	const legacy = Number(w.db.prepare(
		"INSERT INTO legal_documents (truck_id, unit_number, doc_type, file_name, file_url, uploaded_by, investor_id) VALUES (19, 'TA-1', 'Other', 'legacy.pdf', '', 'inv_a', 0)"
	).run().lastInsertRowid);
	w.db.prepare("UPDATE trucks SET owner_id = 3 WHERE id = 19").run();
	const moved = await app.del(INV_A, legacy);
	t(moved.status === 404 && exists(legacy), `§3 A's own truck-only upload on a truck A no longer owns: 404, kept (got ${moved.status})`);
	const stillFiled = await app.del(INV_A, aMoved);
	t(stillFiled.status === 200 && !exists(aMoved), `§3 ...while A's upload that is also filed on A's own record stays A's (got ${stillFiled.status})`);
	w.db.prepare("UPDATE trucks SET owner_id = 2 WHERE id = 19").run();

	const mine = await app.del(INV_A, aProfile);
	t(mine.status === 200 && !exists(aProfile) && !fs.existsSync(aFile), `§3 A deletes A's own upload: 200, row and file gone (got ${mine.status})`);
	const mineTruck = await app.del(INV_A, aTruck);
	t(mineTruck.status === 200 && !exists(aTruck), "§3 ...and A's own upload on A's own truck");

	const sa = await app.del(SUPER, bProfile);
	t(sa.status === 200 && !exists(bProfile), "§4 a Super Admin deletes any document");
	const sa2 = await app.del(SUPER, adminOnA);
	t(sa2.status === 200 && !exists(adminOnA), "§4 ...including one on an investor's truck");
	const saMissing = await app.del(SUPER, 99999);
	t(saMissing.status === 404 && saMissing.body.code === "DOCUMENT_NOT_FOUND", "§4 a missing id is 404 for a Super Admin too");
	fs.rmSync(w.root, { recursive: true, force: true });
	return r;
}

// ─────────────────────────────────────────────────────── §5 source pins
function pinSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const up = code(ROUTES.upload);
	const check = up.indexOf('code: "NOT_OWNER"');
	t(check > 0 && ["fs.mkdirSync(", "fs.writeFileSync(", "INSERT INTO legal_documents"].every((w) => up.indexOf(w) > check),
		"§5 the upload's ownership check precedes the directory, the file and the row");
	const del = code(ROUTES.del);
	const guard = del.indexOf("if (!inScope || !uploadedByThem) return notFound();");
	t(guard > 0 && ["fs.unlinkSync(", "DELETE FROM legal_documents"].every((w) => del.indexOf(w) > guard),
		"§5 the delete's ownership check precedes the file unlink and the row delete");
	t(!/or owner removes/.test(SRC), "§5 the old \"Super Admin or owner\" comment is gone");
	return r;
}

// ─────────────────────────────────────────────────────── §6 mutants
async function mutantSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const failed = (results) => results.some((x) => !x.ok);
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	const noUploadCheck = { ...ROUTES, upload: swap(ROUTES.upload, 'if (req.session.user.role === "Investor") {', "if (false) {") };
	t(failed(await investorUploadSection(noUploadCheck)), "MUTANT the upload's ownership check dropped: caught by §1");
	const noDeleteCheck = { ...ROUTES, del: swap(ROUTES.del, 'if (user.role !== "Super Admin") {', "if (false) {") };
	t(failed(await deleteSection(noDeleteCheck)), "MUTANT the delete's ownership check dropped: caught by §3");
	const scopeOnly = { ...ROUTES, del: swap(ROUTES.del, "if (!inScope || !uploadedByThem)", "if (!inScope)") };
	t(failed(await deleteSection(scopeOnly)), "MUTANT the delete's uploader test dropped: caught by §3");
	return r;
}

function record(results) {
	for (const x of results) ok(x.ok, x.name);
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

(async () => {
	section("§1 Investor uploads");
	record(await investorUploadSection());
	section("§2 Super Admin uploads");
	record(await adminUploadSection());
	section("§3/§4 deletes");
	record(await deleteSection());
	section("§5 source pins");
	record(pinSection());
	section("§6 mutants");
	record(await mutantSection());

	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
