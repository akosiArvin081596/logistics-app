#!/usr/bin/env node
/**
 * scripts/test-driver-delete-keeps-documents.js — deleting an account never
 * removes the load documents filed under it (2026-10-22, plan option A).
 *
 * THE BUG. DELETE /api/users/:id ran `DELETE FROM documents WHERE LOWER(driver)
 * = ?` inside its cascade, so deleting a driver hard-deleted every load
 * document filed under his name, PODs included, while every other way out of
 * the documents table is a soft delete (DELETE /api/documents/:id stamps
 * deleted_at and refuses to remove the last POD on a delivered load). The
 * delete guard (userDeleteLockBlockers()) never looked at documents, so a
 * driver whose history is all in an open month, with no paid invoice, could be
 * deleted and take his PODs with him: the loads lose their Proof of Delivery,
 * the Delivered rule's POD count drops, and broker invoice drafting finds none.
 *
 * THE RULE ASSERTED (option A):
 *   - the delete is refused (409 DRIVER_HAS_DOCUMENTS, audited as
 *     delete_user_blocked, nothing written) while any LIVE load document is
 *     filed under the account, any type, matched like the invoices blocker:
 *     the stored spelling case aside, or another spelling of the driver's name
 *     no other account holds;
 *   - the cascade deletes no documents row at all: soft-deleted rows stay as
 *     they are (office records, recoverable by one UPDATE) and are reported as
 *     retained;
 *   - no file on disk is unlinked.
 *
 * WHAT MUST NOT CHANGE (these pass on main too):
 *   - a driver with no documents deletes exactly as before;
 *   - other drivers' documents and the rate-con archive rows (filed under no
 *     one) are untouched by any delete;
 *   - an existing refusal keeps its code: PERIOD_FINALIZED still wins, and
 *     INVOICE_ALREADY_PAID stays first, so the new blocker is appended last.
 *
 *   §1 THE BUG: a live POD on an open-month driver refuses the delete.
 *   §2 Any live type (BOL, Other, Receipt) refuses it too.
 *   §3 Soft-deleted rows only: the delete goes through and the rows stay.
 *   §4 Other spellings, and the other-account rule.
 *   §5 A username-only account's exact-match rows are protected too.
 *   §6 What must not change.
 *   §7 Source pins.
 *
 * The route registration is lifted whole from server.js, with the real guard
 * (userDeleteLockBlockers() and the rename cascade's leg helpers), the real
 * truck lookup and periodLabel(), over an in-memory database whose documents
 * table is built from server.js's own CREATE TABLE and ALTER TABLE statements.
 * Month locks, the signed-artifact archive, sessions, the sheet sync and the
 * audit writer are stubs. Files are written only under a fresh mkdtemp.
 * No server, no port, no app.db, no network. Made-up names only.
 *
 * Run: node scripts/test-driver-delete-keeps-documents.js   # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function eq(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	ok(name, a === e, `expected ${e}, got ${a}`);
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

// --- lifting ---------------------------------------------------------------
// A top-level `function name(` up to the first line that is exactly "}".
function liftFn(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) fatal(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle);
	const b = SRC.indexOf("\n}\n", a);
	if (b < 0) fatal(`could not locate the end of function ${name} in server.js`);
	return SRC.slice(a + 1, b + 2);
}
function liftConst(head, close) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) fatal(`expected exactly 1 statement starting ${JSON.stringify(head)} in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const b = SRC.indexOf(close, a);
	if (b < 0) fatal(`no end found after ${head}`);
	return SRC.slice(a, b + close.length);
}
// The registration, from its line to the first `});` in column 0 after it.
function routeSource(verb, routePath) {
	const head = `\napp.${verb}("${routePath}",`;
	const hits = SRC.split(head).length - 1;
	if (hits !== 1) fatal(`expected exactly 1 registration of ${verb.toUpperCase()} ${routePath}, found ${hits}`);
	const a = SRC.indexOf(head) + 1;
	const b = SRC.indexOf("\n});\n", a);
	if (b < 0) fatal(`could not find the end of ${verb.toUpperCase()} ${routePath}`);
	return SRC.slice(a, b + 4);
}
const DELETE_SRC = routeSource("delete", "/api/users/:id");

// The helpers the guard and the cascade call, real. `db` is bound per scenario.
const RENAME_LEG_SRC = [
	...["normalizeDriverName", "isBuiltInPropertyName", "findDriverNameClashes", "driverNameHeldByOtherAccount"].map(liftFn),
	liftConst("const DRIVER_RENAME_TARGETS = [", "\n];"),
	...["driverRenameWhereSql", "driverRenameWhereArgs", "driverRenameWidens", "driverRenameSpellings"].map(liftFn),
	liftFn("personalLedgerPresent"),
].join("\n");
const GUARD_SRC = [
	liftFn("invoiceRowPeriodLocked"),
	liftFn("namedLockedPeriods"),
	RENAME_LEG_SRC,
	liftFn("userDeleteLockBlockers"),
].join("\n");
const TRUCK_SRC = ["findTruckForDriver", "findTruckForDriverAccount"].map(liftFn).join("\n");
const periodLabel = new Function(`${liftFn("periodLabel")}\nreturn periodLabel;`)();
const quiet = { log() {}, warn() {}, error() {} };

// --- scratch database ------------------------------------------------------
// The documents table exactly as server.js builds it; the rest carry the
// columns the route and its guard read (the FK children with their FOREIGN
// KEYs, as in scripts/test-user-delete-cascade.js).
function scratch() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	const create = SRC.match(/CREATE TABLE IF NOT EXISTS documents \([\s\S]*?\n\t\)/);
	if (!create) fatal("CREATE TABLE documents not found in server.js");
	db.exec(create[0]);
	for (const m of SRC.matchAll(/ALTER TABLE documents ADD COLUMN [^"`\n]+/g)) {
		try { db.exec(m[0]); } catch { /* a column added twice, as the boot's try/catch allows */ }
	}
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, driver_name TEXT DEFAULT '', full_name TEXT DEFAULT '', role TEXT);
		CREATE TABLE driver_onboarding (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, application_id INTEGER NOT NULL,
			driver_name TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE onboarding_documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, doc_key TEXT NOT NULL, doc_name TEXT NOT NULL,
			signed INTEGER DEFAULT 0, signed_pdf_url TEXT DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE driver_payment_info (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, amount REAL DEFAULT 0, date TEXT DEFAULT '', posted_period TEXT DEFAULT '', created_at TEXT DEFAULT '');
		CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, "from" TEXT, "to" TEXT);
		CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT);
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT);
		CREATE TABLE load_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT);
		CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT, assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0,
			routemate_vehicle_id TEXT DEFAULT '', in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '', created_at TEXT DEFAULT '');
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER NOT NULL, driver_name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT DEFAULT '');
		CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT DEFAULT '');
		CREATE TABLE investor_config (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER);
		CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY, owner_id INTEGER, period TEXT, status TEXT, paid_at TEXT, finalized_at TEXT);
		CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT, driver TEXT, week_start TEXT, week_end TEXT, paid_at TEXT DEFAULT '', deleted_at TEXT DEFAULT '');
		CREATE TABLE period_locks (period TEXT, status TEXT);
	`);
	return db;
}

// --- fixtures (made up) ----------------------------------------------------
const ADMIN = { id: 1, username: "super_admin", driver_name: "", role: "Super Admin" };
const TVALE = { id: 7, username: "tvale", driver_name: "Tamsin Vale", role: "Driver" };
const OPIKE = { id: 9, username: "opike", driver_name: "Orrin Pike", role: "Driver" };

function account(db, u) {
	db.prepare("INSERT INTO users (id, username, driver_name, full_name, role) VALUES (?,?,?,?,?)")
		.run(u.id, u.username, u.driver_name, u.driver_name, u.role);
}
function doc(db, root, o) {
	const file = o.file;
	const url = o.url || `/uploads/${file}`;
	fs.writeFileSync(path.join(root, url.replace(/^\//, "")), Buffer.from(`MADE-UP ${o.type} BYTES ${file}\n`));
	return db.prepare("INSERT INTO documents (load_id, driver, type, file_name, drive_url, deleted_at, deleted_by) VALUES (?,?,?,?,?,?,?)")
		.run(o.load, o.driver, o.type, file, url, o.deleted || null, o.deleted ? "super_admin" : "").lastInsertRowid;
}
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

// One world per scenario: an admin, the driver to delete with open-month
// history (a receipt, a message, a notification, a ping, a load response, his
// truck), another driver with his own POD, and a rate-con archive row filed
// under no one.
function world(opts = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "drvdel-"));
	fs.mkdirSync(path.join(root, "uploads", "rate-cons"), { recursive: true });
	const db = scratch();
	account(db, ADMIN);
	account(db, opts.target || TVALE);
	account(db, OPIKE);
	for (const u of opts.accounts || []) account(db, u);
	const t = (opts.target || TVALE).driver_name || (opts.target || TVALE).username;
	db.prepare("INSERT INTO expenses (driver, amount, date, posted_period, created_at) VALUES (?, 84.10, '2026-10-05', '', '2026-10-05 15:00:00')").run(t);
	db.prepare(`INSERT INTO messages ("from", "to") VALUES (?, 'Dispatch')`).run(t);
	db.prepare("INSERT INTO notifications (driver_name) VALUES (?)").run(t.toLowerCase());
	db.prepare("INSERT INTO driver_locations (driver) VALUES (?)").run(t);
	db.prepare("INSERT INTO load_responses (driver_name) VALUES (?)").run(t.toLowerCase());
	db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver) VALUES (1, 'MADE-UP-101', ?)").run(t);
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (1, ?, '2026-10-01', '')").run(t);
	doc(db, root, { load: "L-9100", driver: "Orrin Pike", type: "POD", file: "L-9100_POD_op.jpg" });
	doc(db, root, { load: "L-9001", driver: "", type: "RATECON", file: "L-9001.pdf", url: "/uploads/rate-cons/L-9001.pdf" });
	for (const d of opts.docs || []) doc(db, root, d);
	for (const e of opts.expenses || []) db.prepare("INSERT INTO expenses (driver, amount, date, posted_period, created_at) VALUES (?,?,?,?,?)").run(e.driver, e.amount, e.date, e.posted_period || "", e.date);
	for (const i of opts.invoices || []) db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, week_end, paid_at) VALUES (?,?,?,?,?)").run(i.n, i.driver, i.ws, i.we, i.paid || "");
	return { db, root, locked: new Set(opts.locked || []) };
}

// The registration, executed against a capturing `app`, with its dependencies.
function deleteRoute(w, rec) {
	const isLocked = (p) => w.locked.has(p);
	const month = (r) => String(r.posted_period || r.date || "").slice(0, 7);
	const guard = new Function(
		"db", "isLocked", "periodLocksReadable", "expenseRowPeriodLocked", "blockedExpensePeriods", "truckFixedCostLockedMonths",
		`${GUARD_SRC}\nreturn userDeleteLockBlockers;`,
	)(w.db, isLocked, () => true, (r) => isLocked(month(r)), (rows) => [...new Set(rows.map(month))].sort(), () => []);
	const truck = new Function("db", `${TRUCK_SRC}\n${liftFn("normalizeDriverName")}\nreturn { findTruckForDriverAccount, normalizeDriverName };`)(w.db);
	const deps = {
		requireRole: () => (req, res, next) => next(),
		db: w.db,
		userDeleteLockBlockers: guard,
		recordPeriodRefusal: (audit, code, periods) => rec.refusals.push({ action: audit.action, code, periods }),
		auditText: (v, max) => String(v == null ? "" : v).slice(0, max),
		periodLabel,
		archiveUserSignedArtifacts: () => ({ archived: [], skipped: [] }),
		logAudit: (req, action, entity, id, details) => rec.audits.push({ action, entity, id, details }),
		findTruckForDriverAccount: truck.findTruckForDriverAccount,
		normalizeDriverName: truck.normalizeDriverName,
		purgeUserSessions: (id) => { rec.purged.push(id); return 0; },
		syncDriverToCarrierSheet: (name, o) => rec.synced.push({ name, action: o && o.action }),
		notifyChange: () => {},
		DATA_DIR: w.root,
		fs, path, console: quiet,
	};
	let captured = null;
	const app = { delete: (p, ...chain) => { captured = { path: p, chain }; } };
	new Function("app", ...Object.keys(deps), `${DELETE_SRC};`)(app, ...Object.values(deps));
	if (!captured || captured.path !== "/api/users/:id") fatal("the lifted registration did not register DELETE /api/users/:id");
	return captured.chain;
}
function del(w, id) {
	const rec = { refusals: [], audits: [], purged: [], synced: [] };
	const chain = deleteRoute(w, rec);
	const req = { method: "DELETE", params: { id: String(id) }, body: {}, query: {}, headers: {}, session: { user: { ...ADMIN } } };
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
	};
	let threw = null;
	try {
		for (const mw of chain) {
			let next = false;
			mw(req, res, () => { next = true; });
			if (!next) break;
		}
	} catch (err) { threw = err.message; }
	return { status: res.statusCode, body: res.body || {}, threw, ...rec };
}
const fileThere = (w, url) => fs.existsSync(path.join(w.root, url.replace(/^\//, "")));
const userThere = (w, id) => count(w.db, "SELECT COUNT(*) AS n FROM users WHERE id = ?", id) === 1;
const done = (w) => { w.db.close(); fs.rmSync(w.root, { recursive: true, force: true }); };

// ---------------------------------------------------------------------------
// §1 THE BUG: a live POD on a driver whose history is all in an open month.
// ---------------------------------------------------------------------------
{
	const w = world({ docs: [{ load: "L-9001", driver: "Tamsin Vale", type: "POD", file: "L-9001_POD_tv.jpg" }] });
	const r = del(w, TVALE.id);
	eq("§1 the delete is refused with 409", r.status, 409);
	eq("§1 ...code DRIVER_HAS_DOCUMENTS", r.body.code, "DRIVER_HAS_DOCUMENTS");
	ok("§1 ...the route did not throw", r.threw === null, r.threw);
	ok("§1 the account is still there", userThere(w, TVALE.id));
	eq("§1 the POD row is still there and live",
		w.db.prepare("SELECT COUNT(*) AS n FROM documents WHERE file_name = 'L-9001_POD_tv.jpg' AND deleted_at IS NULL").get().n, 1);
	ok("§1 the POD file is still on disk", fileThere(w, "/uploads/L-9001_POD_tv.jpg"));
	eq("§1 nothing else was written: receipt, message, notification, ping, load response, truck all as before", [
		count(w.db, "SELECT COUNT(*) AS n FROM expenses"),
		count(w.db, "SELECT COUNT(*) AS n FROM messages"),
		count(w.db, "SELECT COUNT(*) AS n FROM notifications"),
		count(w.db, "SELECT COUNT(*) AS n FROM driver_locations"),
		count(w.db, "SELECT COUNT(*) AS n FROM load_responses"),
		w.db.prepare("SELECT assigned_driver FROM trucks WHERE id = 1").get().assigned_driver,
	], [1, 1, 1, 1, 1, "Tamsin Vale"]);
	eq("§1 the refusal is audited once as delete_user_blocked with its code",
		r.refusals.map((x) => [x.action, x.code]), [["delete_user_blocked", "DRIVER_HAS_DOCUMENTS"]]);
	eq("§1 no delete_user success row", r.audits.filter((a) => a.action === "delete_user").length, 0);
	eq("§1 no session purged, no sheet sync", [r.purged.length, r.synced.length], [0, 0]);
	const b = (r.body.blockers || []).find((x) => x && x.table === "documents");
	ok("§1 the 409 lists a documents blocker counting the one row", !!b && b.rows === 1, JSON.stringify(r.body.blockers));
	ok("§1 the message names the PODs", /POD/.test(String(r.body.error || "")), r.body.error);
	ok("§1 the message does not claim a closed month", !!r.body.error && !/closed month|finalized/i.test(r.body.error), r.body.error);
	done(w);
}

// ---------------------------------------------------------------------------
// §2 Any live load document refuses it: a BOL, an Other, a Receipt.
// ---------------------------------------------------------------------------
for (const type of ["BOL", "Other", "Receipt"]) {
	const file = `L-9002_${type}_tv.pdf`;
	const w = world({ docs: [{ load: "L-9002", driver: "Tamsin Vale", type, file }] });
	const r = del(w, TVALE.id);
	eq(`§2 a live ${type} alone refuses the delete (409 DRIVER_HAS_DOCUMENTS)`, [r.status, r.body.code], [409, "DRIVER_HAS_DOCUMENTS"]);
	eq(`§2 ...and the ${type} row stays`, count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE file_name = ?", file), 1);
	done(w);
}

// ---------------------------------------------------------------------------
// §3 Soft-deleted rows only: the delete goes through and the rows stay.
// ---------------------------------------------------------------------------
{
	const w = world({ docs: [{ load: "L-9003", driver: "Tamsin Vale", type: "POD", file: "L-9003_POD_tv_old.jpg", deleted: "2026-10-03 14:00:00" }] });
	const before = w.db.prepare("SELECT * FROM documents WHERE file_name = 'L-9003_POD_tv_old.jpg'").get();
	const r = del(w, TVALE.id);
	eq("§3 a driver with only soft-deleted documents is deleted (200)", [r.status, r.body.success], [200, true]);
	ok("§3 ...the account is gone", !userThere(w, TVALE.id));
	eq("§3 the soft-deleted row is still there, unchanged",
		w.db.prepare("SELECT * FROM documents WHERE file_name = 'L-9003_POD_tv_old.jpg'").get() || null, before);
	ok("§3 ...its file is still on disk", fileThere(w, "/uploads/L-9003_POD_tv_old.jpg"));
	ok("§3 the cascade reports no removed documents", !r.body.removed || !r.body.removed.documents, JSON.stringify(r.body.removed));
	eq("§3 the response counts it as retained", r.body.retained && r.body.retained.documents, 1);
	const line = (r.audits.find((a) => a.action === "delete_user") || {}).details || "";
	ok("§3 the audit line lists it as retained, not removed",
		/retained \(not deleted\):[^;]*documents=1/.test(line) && !/cascade:[^;]*documents=/.test(line), line);
	done(w);
}

// ---------------------------------------------------------------------------
// §4 Other spellings: matched through the rename cascade's documents leg, like
// the invoices blocker, unless another account holds that spelling.
// ---------------------------------------------------------------------------
{
	const w = world({ docs: [{ load: "L-9004", driver: "tamsin  vale", type: "POD", file: "L-9004_POD_tv.jpg" }] });
	const r = del(w, TVALE.id);
	eq("§4 a live POD filed under another spacing of his name refuses the delete", [r.status, r.body.code], [409, "DRIVER_HAS_DOCUMENTS"]);
	eq("§4 ...and the row stays", count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE file_name = 'L-9004_POD_tv.jpg'"), 1);
	done(w);
}
{
	const LEGACY = { id: 8, username: "legacy_tv", driver_name: "Tamsin  Vale", role: "Driver" };
	const w = world({ accounts: [LEGACY], docs: [{ load: "L-9005", driver: "Tamsin  Vale", type: "POD", file: "L-9005_POD_legacy.jpg" }] });
	const r = del(w, TVALE.id);
	eq("§4 another account holding that spelling: the row is that account's, the delete goes through", r.status, 200);
	eq("§4 ...and that account's POD is untouched",
		w.db.prepare("SELECT driver, deleted_at FROM documents WHERE file_name = 'L-9005_POD_legacy.jpg'").get(), { driver: "Tamsin  Vale", deleted_at: null });
	done(w);
}

// ---------------------------------------------------------------------------
// §5 A username-only account (no driver name): the cascade name is the
// username, matched exactly. Rows under it are protected the same way.
// ---------------------------------------------------------------------------
{
	const DISPATCHER = { id: 7, username: "rhea quill", driver_name: "", role: "Dispatcher" };
	const w = world({ target: DISPATCHER, docs: [{ load: "L-9006", driver: "Rhea Quill", type: "POD", file: "L-9006_POD_rq.jpg" }] });
	const r = del(w, DISPATCHER.id);
	eq("§5 a live POD under the username refuses the delete", [r.status, r.body.code], [409, "DRIVER_HAS_DOCUMENTS"]);
	eq("§5 ...and the row stays", count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE file_name = 'L-9006_POD_rq.jpg'"), 1);
	done(w);
}
{
	const DISPATCHER = { id: 7, username: "rhea  quill", driver_name: "", role: "Dispatcher" };
	const w = world({ target: DISPATCHER, docs: [{ load: "L-9007", driver: "Rhea Quill", type: "POD", file: "L-9007_POD_rq.jpg" }] });
	const r = del(w, DISPATCHER.id);
	eq("§5 a username is not a driver identity: another spacing of it is not matched (200)", r.status, 200);
	eq("§5 ...and that row is untouched", count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE file_name = 'L-9007_POD_rq.jpg' AND deleted_at IS NULL"), 1);
	done(w);
}

// ---------------------------------------------------------------------------
// §6 What must not change (passes on main too).
// ---------------------------------------------------------------------------
{
	// A driver with no documents deletes exactly as before.
	const w = world();
	const r = del(w, TVALE.id);
	eq("§6 no documents: the delete goes through (200)", [r.status, r.body.success], [200, true]);
	ok("§6 ...the account is gone", !userThere(w, TVALE.id));
	eq("§6 ...the cascade removes what it always removed", [
		r.body.removed && r.body.removed.expenses,
		r.body.removed && r.body.removed.messages,
		r.body.removed && r.body.removed.notifications,
		r.body.removed && r.body.removed.driver_locations,
		r.body.removed && r.body.removed.load_responses,
		r.body.removed && r.body.removed.trucks_unassigned,
	], [1, 1, 1, 1, 1, 1]);
	eq("§6 ...the open assignment is closed, not deleted", [
		r.body.detached && r.body.detached.truck_assignments_closed,
		count(w.db, "SELECT COUNT(*) AS n FROM truck_assignments"),
	], [1, 1]);
	eq("§6 ...one delete_user audit row, sessions purged, sheet synced", [
		r.audits.filter((a) => a.action === "delete_user").length, r.purged, r.synced.map((s) => s.action),
	], [1, [TVALE.id], ["delete"]]);
	eq("§6 ...no refusal recorded", r.refusals.length, 0);
	eq("§6 ...another driver's POD and the rate-con archive row are untouched", [
		count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE driver = 'Orrin Pike' AND deleted_at IS NULL"),
		count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE driver = '' AND type = 'RATECON'"),
	], [1, 1]);
	ok("§6 ...their files are still on disk", fileThere(w, "/uploads/L-9100_POD_op.jpg") && fileThere(w, "/uploads/rate-cons/L-9001.pdf"));
	done(w);
}
{
	// A closed-month receipt and a live POD: PERIOD_FINALIZED still wins.
	const w = world({
		locked: ["2026-09"],
		expenses: [{ driver: "Tamsin Vale", amount: 61.25, date: "2026-09-12" }],
		docs: [{ load: "L-9008", driver: "Tamsin Vale", type: "POD", file: "L-9008_POD_tv.jpg" }],
	});
	const r = del(w, TVALE.id);
	eq("§6 closed-month receipt + POD: refused with PERIOD_FINALIZED, as before", [r.status, r.body.code], [409, "PERIOD_FINALIZED"]);
	eq("§6 ...naming the closed month", r.body.periods, ["2026-09"]);
	eq("§6 ...the POD stays", count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE file_name = 'L-9008_POD_tv.jpg'"), 1);
	done(w);
}
{
	// A paid invoice and a live POD: INVOICE_ALREADY_PAID stays the code (the
	// documents blocker is appended after the invoices blocker).
	const w = world({
		invoices: [{ n: "INV-MADEUP-01", driver: "tamsin vale", ws: "2026-10-03", we: "2026-10-09", paid: "2026-10-12" }],
		docs: [{ load: "L-9009", driver: "Tamsin Vale", type: "POD", file: "L-9009_POD_tv.jpg" }],
	});
	const r = del(w, TVALE.id);
	eq("§6 paid invoice + POD: refused with INVOICE_ALREADY_PAID, as before", [r.status, r.body.code], [409, "INVOICE_ALREADY_PAID"]);
	ok("§6 ...the invoices blocker comes first", (r.body.blockers || [])[0] && r.body.blockers[0].table === "invoices", JSON.stringify(r.body.blockers));
	done(w);
}

// ---------------------------------------------------------------------------
// §7 Source pins.
// ---------------------------------------------------------------------------
{
	ok("§7 the user delete route deletes no documents row", !/DELETE\s+FROM\s+documents\b/i.test(DELETE_SRC));
	ok("§7 ...and unlinks no file", !/\bunlink(Sync)?\s*\(|\brm(Sync)?\s*\(/.test(DELETE_SRC));
	ok("§7 the cascade still removes the driver's receipts and messages (unchanged)",
		/DELETE FROM expenses WHERE LOWER\(driver\) = \?/.test(DELETE_SRC) && /DELETE FROM messages WHERE/.test(DELETE_SRC));
	const SOFT = routeSource("delete", "/api/documents/:id");
	ok("§7 DELETE /api/documents/:id is still a soft delete", /UPDATE documents SET deleted_at = CURRENT_TIMESTAMP/.test(SOFT) && !/DELETE\s+FROM\s+documents\b/i.test(SOFT));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
