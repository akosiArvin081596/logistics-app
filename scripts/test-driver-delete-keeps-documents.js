#!/usr/bin/env node
/**
 * scripts/test-driver-delete-keeps-documents.js — deleting an account never
 * removes the load documents filed under it, and never removes a receipt from
 * any month's figures (2026-10-22, plan option A plus DD10).
 *
 * THE BUG. The cascade inside DELETE /api/users/:id removed every documents
 * row filed under the account's name, so deleting a driver hard-deleted his
 * load documents, PODs included, while every other way out of that table is a
 * soft delete (DELETE /api/documents/:id stamps deleted_at and refuses to remove
 * the last POD on a delivered load). The delete guard (userDeleteLockBlockers())
 * never looked at documents, so a driver whose history is all in an open month,
 * with no paid invoice, could be deleted and take his PODs with him: the loads
 * lose their Proof of Delivery, the Delivered rule's POD count drops, and broker
 * invoice drafting finds none. The same delete removed his open-month receipts,
 * changing that month's P&L (DD10).
 *
 * THE RULE ASSERTED:
 *   - the delete is refused (409, audited as delete_user_blocked, nothing
 *     written) while any LIVE load document is filed under the account
 *     (DRIVER_HAS_DOCUMENTS), any type, matched like the invoices blocker: the
 *     stored spelling case aside, or another spelling of the driver's name no
 *     other account holds; a username-only account by its exact username;
 *   - ...and while any expense row the cascade would remove sits in an open
 *     month (OPEN_MONTH_EXPENSES), rejected receipts included; closed-month rows
 *     keep refusing as PERIOD_FINALIZED;
 *   - the cascade removes no documents row at all: soft-deleted rows stay as
 *     they are, under the deleted name, and are reported as retained;
 *   - no file on disk is unlinked;
 *   - the blockers carry counts only, and the 409 reads as the plan's L4 text.
 *
 * WHAT MUST NOT CHANGE (these pass on main too):
 *   - an account with no documents and no receipts deletes exactly as before;
 *   - other drivers' documents and the rate-con archive rows (filed under no
 *     one) are untouched by any delete;
 *   - an existing refusal keeps its code: PERIOD_FINALIZED still wins, and
 *     INVOICE_ALREADY_PAID stays first, so the new blockers are appended last.
 *
 *   §1 THE BUG: a live POD on a driver with no other history refuses the delete.
 *   §2 Any live type (BOL, Other, Receipt, a rate con filed under him) refuses it.
 *   §3 Soft-deleted rows: never counted, never removed, reported as retained.
 *   §4 Other spellings, and the other-account rule.
 *   §5 A username-only account: its exact username only, "account" in the text.
 *   §6 DD10: open-month receipts refuse the delete.
 *   §7 What must not change.
 *   §8 Source pins (comments stripped before matching).
 *   §9 Discrimination: each new clause of the guard, taken out, flips a check.
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
// Code only: full-line and trailing `//` comments and `/* */` blocks removed,
// so a pin never matches the words of a comment.
function codeOnly(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((l) => !/^\s*\/\//.test(l))
		.map((l) => l.replace(/\s\/\/\s.*$/, ""))
		.join("\n");
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
		CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, amount REAL DEFAULT 0, date TEXT DEFAULT '',
			posted_period TEXT DEFAULT '', created_at TEXT DEFAULT '', status TEXT DEFAULT 'Pending');
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
const DOC_HINT = "A document filed in error can be removed from its load's Documents panel first.";

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
const docRows = (db, file) => count(db, "SELECT COUNT(*) AS n FROM documents WHERE file_name = ?", file);

// One world per scenario: an admin, the account to delete with operational
// history (a message, a notification, a ping, a load response, his truck),
// another driver with his own POD and receipt, and a rate-con archive row
// filed under no one. Receipts for the target only when a scenario adds them.
function world(opts = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "drvdel-"));
	fs.mkdirSync(path.join(root, "uploads", "rate-cons"), { recursive: true });
	const db = scratch();
	const target = opts.target || TVALE;
	account(db, ADMIN);
	account(db, target);
	account(db, OPIKE);
	for (const u of opts.accounts || []) account(db, u);
	if (opts.personalLedger) db.exec("CREATE TABLE expense_personal (id INTEGER PRIMARY KEY AUTOINCREMENT, expense_id INTEGER)");
	const t = target.driver_name || target.username;
	db.prepare(`INSERT INTO messages ("from", "to") VALUES (?, 'Dispatch')`).run(t);
	db.prepare("INSERT INTO notifications (driver_name) VALUES (?)").run(t.toLowerCase());
	db.prepare("INSERT INTO driver_locations (driver) VALUES (?)").run(t);
	db.prepare("INSERT INTO load_responses (driver_name) VALUES (?)").run(t.toLowerCase());
	db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver) VALUES (1, 'MADE-UP-101', ?)").run(t);
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (1, ?, '2026-10-01', '')").run(t);
	db.prepare("INSERT INTO expenses (driver, amount, date, created_at) VALUES ('Orrin Pike', 40.00, '2026-10-06', '2026-10-06 12:00:00')").run();
	doc(db, root, { load: "L-9100", driver: "Orrin Pike", type: "POD", file: "L-9100_POD_op.jpg" });
	doc(db, root, { load: "L-9001", driver: "", type: "RATECON", file: "L-9001.pdf", url: "/uploads/rate-cons/L-9001.pdf" });
	for (const d of opts.docs || []) doc(db, root, d);
	for (const e of opts.expenses || []) {
		const id = db.prepare("INSERT INTO expenses (driver, amount, date, posted_period, created_at, status) VALUES (?,?,?,?,?,?)")
			.run(e.driver, e.amount, e.date, e.posted_period || "", e.date, e.status || "Pending").lastInsertRowid;
		if (e.personal) db.prepare("INSERT INTO expense_personal (expense_id) VALUES (?)").run(id);
	}
	for (const i of opts.invoices || []) db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, week_end, paid_at) VALUES (?,?,?,?,?)").run(i.n, i.driver, i.ws, i.we, i.paid || "");
	return { db, root, locked: new Set(opts.locked || []) };
}

// The registration, executed against a capturing `app`, with its dependencies.
function deleteRoute(w, rec, guardSrc = GUARD_SRC) {
	const isLocked = (p) => w.locked.has(p);
	const month = (r) => String(r.posted_period || r.date || "").slice(0, 7);
	const guard = new Function(
		"db", "isLocked", "periodLocksReadable", "expenseRowPeriodLocked", "blockedExpensePeriods", "truckFixedCostLockedMonths",
		`${guardSrc}\nreturn userDeleteLockBlockers;`,
	)(w.db, isLocked, () => true, (r) => isLocked(month(r)), (rows) => [...new Set(rows.map(month))].sort(), () => []);
	const truck = new Function("db", `${TRUCK_SRC}\n${liftFn("normalizeDriverName")}\nreturn { findTruckForDriverAccount, normalizeDriverName };`)(w.db);
	// The staff desks: the delete keeps a desk's messages (test-user-delete-cascade.js).
	const chatDeskKey = new Function(`${liftConst("const CHAT_DESK_NAMES = ", ";\n")}\n${liftFn("chatDeskKey")}\nreturn chatDeskKey;`)();
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
		chatDeskKey,
		purgeUserSessions: (id) => { rec.purged.push(id); return 0; },
		syncDriverToCarrierSheet: (name, o) => rec.synced.push({ name, action: o && o.action }),
		notifyChange: () => {},
		// Voice notes' unlink (scripts/test-voice-note-routes.js §17 runs the real one).
		userVoiceNoteFiles: () => [],
		removeUserVoiceNotes: () => 0,
		DATA_DIR: w.root,
		fs, path, console: quiet,
	};
	let captured = null;
	const app = { delete: (p, ...chain) => { captured = { path: p, chain }; } };
	new Function("app", ...Object.keys(deps), `${DELETE_SRC};`)(app, ...Object.values(deps));
	if (!captured || captured.path !== "/api/users/:id") fatal("the lifted registration did not register DELETE /api/users/:id");
	return captured.chain;
}
function del(w, id, guardSrc) {
	const rec = { refusals: [], audits: [], purged: [], synced: [] };
	const chain = deleteRoute(w, rec, guardSrc);
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
// Everything the cascade would have written, for "nothing was written".
const snapshot = (w) => [
	count(w.db, "SELECT COUNT(*) AS n FROM users"),
	count(w.db, "SELECT COUNT(*) AS n FROM expenses"),
	count(w.db, "SELECT COUNT(*) AS n FROM messages"),
	count(w.db, "SELECT COUNT(*) AS n FROM notifications"),
	count(w.db, "SELECT COUNT(*) AS n FROM driver_locations"),
	count(w.db, "SELECT COUNT(*) AS n FROM load_responses"),
	count(w.db, "SELECT COUNT(*) AS n FROM documents"),
	count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL"),
	w.db.prepare("SELECT assigned_driver FROM trucks WHERE id = 1").get().assigned_driver,
	count(w.db, "SELECT COUNT(*) AS n FROM truck_assignments WHERE end_date = ''"),
];
const blockerOf = (r, code) => (r.body.blockers || []).find((b) => b && b.code === code);

// ---------------------------------------------------------------------------
// §1 THE BUG: a live POD on a driver with no other history.
// ---------------------------------------------------------------------------
{
	const w = world({ docs: [{ load: "L-9001", driver: "Tamsin Vale", type: "POD", file: "L-9001_POD_tv.jpg" }] });
	const before = snapshot(w);
	const r = del(w, TVALE.id);
	eq("§1 the delete is refused with 409", r.status, 409);
	eq("§1 ...code DRIVER_HAS_DOCUMENTS", r.body.code, "DRIVER_HAS_DOCUMENTS");
	ok("§1 ...the route did not throw", r.threw === null, r.threw);
	ok("§1 the account is still there", userThere(w, TVALE.id));
	eq("§1 the POD row is still there and live",
		count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE file_name = 'L-9001_POD_tv.jpg' AND deleted_at IS NULL"), 1);
	ok("§1 the POD file is still on disk", fileThere(w, "/uploads/L-9001_POD_tv.jpg"));
	eq("§1 nothing was written (accounts, receipts, messages, notifications, pings, load responses, documents, truck, assignment)",
		snapshot(w), before);
	eq("§1 the refusal is audited once as delete_user_blocked with its code",
		r.refusals.map((x) => [x.action, x.code]), [["delete_user_blocked", "DRIVER_HAS_DOCUMENTS"]]);
	eq("§1 no delete_user success row", r.audits.filter((a) => a.action === "delete_user").length, 0);
	eq("§1 no session purged, no sheet sync", [r.purged.length, r.synced.length], [0, 0]);
	eq("§1 the message reads as the plan's L4 text",
		r.body.error,
		"Cannot delete Tamsin Vale: 1 load document (1 POD) is filed under this driver. Deleting the account would leave it under a name no account holds, so it stays in place. " +
		`${DOC_HINT} Nothing was changed.`);
	const b = blockerOf(r, "DRIVER_HAS_DOCUMENTS");
	eq("§1 the blocker carries counts only (table, code, rows, pods, periods, detail)",
		b ? Object.keys(b).sort() : null, ["code", "detail", "periods", "pods", "rows", "table"]);
	eq("§1 ...one document, one POD, no period", b ? [b.table, b.rows, b.pods, b.periods] : null, ["documents", 1, 1, []]);
	ok("§1 the 409 names no load ID and no file name",
		!/L-9001|POD_tv/.test(JSON.stringify(r.body)), JSON.stringify(r.body));
	done(w);
}

// ---------------------------------------------------------------------------
// §2 Any live load document refuses it: a BOL, an Other, a Receipt, and a rate
// con filed under him (L10: it survives the refused delete).
// ---------------------------------------------------------------------------
for (const type of ["BOL", "Other", "Receipt", "Rate Con"]) {
	const file = `L-9002_${type.replace(/\s/g, "")}_tv.pdf`;
	const w = world({ docs: [{ load: "L-9002", driver: "Tamsin Vale", type, file }] });
	const r = del(w, TVALE.id);
	eq(`§2 a live ${type} alone refuses the delete (409 DRIVER_HAS_DOCUMENTS)`, [r.status, r.body.code], [409, "DRIVER_HAS_DOCUMENTS"]);
	eq(`§2 ...and the ${type} row stays`, docRows(w.db, file), 1);
	if (type === "BOL") {
		ok("§2 with no POD the count leaves out \"(0 PODs)\"",
			/^Cannot delete Tamsin Vale: 1 load document is filed under this driver\. /.test(String(r.body.error || "")), r.body.error);
	}
	done(w);
}

// ---------------------------------------------------------------------------
// §3 Soft-deleted rows: never counted, never removed, reported as retained.
// ---------------------------------------------------------------------------
{
	const w = world({ docs: [{ load: "L-9003", driver: "Tamsin Vale", type: "POD", file: "L-9003_POD_tv_old.jpg", deleted: "2026-10-03 14:00:00" }] });
	const before = w.db.prepare("SELECT * FROM documents WHERE file_name = 'L-9003_POD_tv_old.jpg'").get();
	const r = del(w, TVALE.id);
	eq("§3 a driver with only soft-deleted documents is deleted (200)", [r.status, r.body.success], [200, true]);
	ok("§3 ...the account is gone", !userThere(w, TVALE.id));
	eq("§3 the soft-deleted row is still there, unchanged, under the deleted name",
		w.db.prepare("SELECT * FROM documents WHERE file_name = 'L-9003_POD_tv_old.jpg'").get() || null, before);
	ok("§3 ...its file is still on disk", fileThere(w, "/uploads/L-9003_POD_tv_old.jpg"));
	ok("§3 the cascade reports no removed documents", !r.body.removed || !r.body.removed.documents, JSON.stringify(r.body.removed));
	eq("§3 the response counts it as retained", r.body.retained && r.body.retained.documents, 1);
	const line = (r.audits.find((a) => a.action === "delete_user") || {}).details || "";
	ok("§3 the audit line lists it as retained, not removed",
		/retained \(not deleted\):[^;]*documents=1/.test(line) && !/cascade:[^;]*documents=/.test(line), line);
	done(w);
}
{
	// Live and soft-deleted together: only the live rows count; PODs counted
	// whatever their letter case or edge spaces.
	const w = world({ docs: [
		{ load: "L-9010", driver: "Tamsin Vale", type: "pod", file: "L-9010_pod_tv.jpg" },
		{ load: "L-9011", driver: "Tamsin Vale", type: " POD ", file: "L-9011_POD_tv.jpg" },
		{ load: "L-9011", driver: "Tamsin Vale", type: "BOL", file: "L-9011_BOL_tv.pdf" },
		{ load: "L-9012", driver: "Tamsin Vale", type: "POD", file: "L-9012_POD_tv_dup.jpg", deleted: "2026-10-04 09:00:00" },
	] });
	const r = del(w, TVALE.id);
	const b = blockerOf(r, "DRIVER_HAS_DOCUMENTS");
	eq("§3 live plus soft-deleted: three live rows counted, two of them PODs", b ? [b.rows, b.pods] : null, [3, 2]);
	eq("§3 ...the plural message",
		r.body.error,
		"Cannot delete Tamsin Vale: 3 load documents (2 PODs) are filed under this driver. Deleting the account would leave them under a name no account holds, so it stays in place. " +
		`${DOC_HINT} Nothing was changed.`);
	eq("§3 ...all four rows stay", count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE LOWER(driver) = 'tamsin vale'"), 4);
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
	eq("§4 ...and the row stays", docRows(w.db, "L-9004_POD_tv.jpg"), 1);
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
// username, matched exactly, and the text says "account".
// ---------------------------------------------------------------------------
{
	const DISPATCHER = { id: 7, username: "rhea quill", driver_name: "", role: "Dispatcher" };
	const w = world({ target: DISPATCHER, docs: [{ load: "L-9006", driver: "Rhea Quill", type: "POD", file: "L-9006_POD_rq.jpg" }] });
	const r = del(w, DISPATCHER.id);
	eq("§5 a live POD under the username refuses the delete", [r.status, r.body.code], [409, "DRIVER_HAS_DOCUMENTS"]);
	eq("§5 ...and the row stays", docRows(w.db, "L-9006_POD_rq.jpg"), 1);
	ok("§5 ...the message says \"this account\"",
		/^Cannot delete rhea quill: 1 load document \(1 POD\) is filed under this account\. /.test(String(r.body.error || "")), r.body.error);
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
// §6 DD10: an expense row the cascade would remove, in an open month, refuses
// the delete, so a delete never removes a receipt from any month's figures.
// ---------------------------------------------------------------------------
const OPEN_RCPT = { driver: "Tamsin Vale", amount: 84.10, date: "2026-10-05" };
{
	const w = world({ expenses: [OPEN_RCPT] });
	const before = snapshot(w);
	const r = del(w, TVALE.id);
	eq("§6 one open-month receipt refuses the delete (409 OPEN_MONTH_EXPENSES)", [r.status, r.body.code], [409, "OPEN_MONTH_EXPENSES"]);
	eq("§6 ...nothing was written", snapshot(w), before);
	eq("§6 ...audited once as delete_user_blocked", r.refusals.map((x) => [x.action, x.code]), [["delete_user_blocked", "OPEN_MONTH_EXPENSES"]]);
	eq("§6 ...the message",
		r.body.error,
		"Cannot delete Tamsin Vale: 1 open-month expense (receipt) is filed under this driver. Deleting the account would delete it and change an open month's figures, so it stays in place. Nothing was changed.");
	const b = blockerOf(r, "OPEN_MONTH_EXPENSES");
	eq("§6 ...the blocker carries counts only", b ? [Object.keys(b).sort(), b.table, b.rows, b.periods] : null,
		[["code", "detail", "periods", "rows", "table"], "expenses", 1, []]);
	done(w);
}
{
	// Two open months, a rejected receipt among them: every row the cascade
	// would remove counts.
	const w = world({ expenses: [OPEN_RCPT, { driver: "tamsin vale", amount: 12.5, date: "2026-11-01", status: "Rejected" }] });
	const r = del(w, TVALE.id);
	eq("§6 a rejected receipt counts too (2 rows)", [r.status, r.body.code, (blockerOf(r, "OPEN_MONTH_EXPENSES") || {}).rows], [409, "OPEN_MONTH_EXPENSES", 2]);
	ok("§6 ...the plural message",
		/^Cannot delete Tamsin Vale: 2 open-month expenses \(receipts\) are filed under this driver\. Deleting the account would delete them and change an open month's figures, so it stays in place\. Nothing was changed\.$/.test(String(r.body.error || "")),
		r.body.error);
	eq("§6 ...both rows stay", count(w.db, "SELECT COUNT(*) AS n FROM expenses WHERE LOWER(driver) = 'tamsin vale'"), 2);
	done(w);
}
{
	// A receipt under another spacing is not removed by the cascade (it matches
	// the stored spelling only), so it does not refuse the delete, and it stays.
	const w = world({ expenses: [{ driver: "tamsin  vale", amount: 9.99, date: "2026-10-07" }] });
	const r = del(w, TVALE.id);
	eq("§6 a receipt under another spacing does not refuse the delete (200)", r.status, 200);
	eq("§6 ...and it stays", count(w.db, "SELECT COUNT(*) AS n FROM expenses WHERE driver = 'tamsin  vale'"), 1);
	done(w);
}
{
	// Closed and open months together: PERIOD_FINALIZED still wins.
	const w = world({ locked: ["2026-09"], expenses: [OPEN_RCPT, { driver: "Tamsin Vale", amount: 61.25, date: "2026-09-12" }] });
	const r = del(w, TVALE.id);
	eq("§6 closed + open receipts: PERIOD_FINALIZED, naming the closed month", [r.status, r.body.code, r.body.periods], [409, "PERIOD_FINALIZED", ["2026-09"]]);
	ok("§6 ...the open-month blocker is listed too", !!blockerOf(r, "OPEN_MONTH_EXPENSES"), JSON.stringify(r.body.blockers));
	eq("§6 ...counting exactly the one open-month row (the closed-month row is not counted twice)",
		(blockerOf(r, "OPEN_MONTH_EXPENSES") || {}).rows, 1);
	done(w);
}
{
	// Documents and open-month receipts together: one combined sentence.
	const w = world({ expenses: [OPEN_RCPT], docs: [{ load: "L-9013", driver: "Tamsin Vale", type: "POD", file: "L-9013_POD_tv.jpg" }] });
	const r = del(w, TVALE.id);
	eq("§6 documents + open-month receipt: DRIVER_HAS_DOCUMENTS first", [r.status, r.body.code], [409, "DRIVER_HAS_DOCUMENTS"]);
	eq("§6 ...the combined message",
		r.body.error,
		"Cannot delete Tamsin Vale: 1 load document (1 POD) is filed under this driver; 1 open-month expense (receipt) is filed under this driver. " +
		"Deleting the account would leave its load documents under a name no account holds and delete its open-month expenses, changing an open month's figures, so it stays in place. " +
		`${DOC_HINT} Nothing was changed.`);
	done(w);
}
{
	// L3: Personal lines and documents refuse together. The documents sentence
	// replaces the fallback that claims a closed month.
	const w = world({ personalLedger: true, expenses: [{ ...OPEN_RCPT, personal: true }], docs: [{ load: "L-9014", driver: "Tamsin Vale", type: "POD", file: "L-9014_POD_tv.jpg" }] });
	const r = del(w, TVALE.id);
	eq("§6 Personal lines + documents: refused, EXPENSE_PERSONAL_LINES first as before", [r.status, r.body.code], [409, "EXPENSE_PERSONAL_LINES"]);
	const msg = String(r.body.error || "");
	ok("§6 ...no fallback sentence about a closed month", !/closed month|finalized/i.test(msg), msg);
	ok("§6 ...the documents sentence and the hint are there",
		msg.includes("Deleting the account would leave its load documents under a name no account holds") && msg.includes(DOC_HINT) && msg.endsWith("Nothing was changed."), msg);
	done(w);
}

// ---------------------------------------------------------------------------
// §7 What must not change (passes on main too).
// ---------------------------------------------------------------------------
{
	// An account with no documents and no receipts deletes exactly as before.
	const w = world();
	const r = del(w, TVALE.id);
	eq("§7 no documents, no receipts: the delete goes through (200)", [r.status, r.body.success], [200, true]);
	ok("§7 ...the account is gone", !userThere(w, TVALE.id));
	eq("§7 ...the cascade removes what it always removed", [
		r.body.removed && r.body.removed.expenses,
		r.body.removed && r.body.removed.messages,
		r.body.removed && r.body.removed.notifications,
		r.body.removed && r.body.removed.driver_locations,
		r.body.removed && r.body.removed.load_responses,
		r.body.removed && r.body.removed.trucks_unassigned,
	], [0, 1, 1, 1, 1, 1]);
	eq("§7 ...the open assignment is closed, not deleted", [
		r.body.detached && r.body.detached.truck_assignments_closed,
		count(w.db, "SELECT COUNT(*) AS n FROM truck_assignments"),
	], [1, 1]);
	eq("§7 ...one delete_user audit row, sessions purged, sheet synced", [
		r.audits.filter((a) => a.action === "delete_user").length, r.purged, r.synced.map((s) => s.action),
	], [1, [TVALE.id], ["delete"]]);
	eq("§7 ...no refusal recorded", r.refusals.length, 0);
	eq("§7 ...another driver's POD and receipt and the rate-con archive row are untouched", [
		count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE driver = 'Orrin Pike' AND deleted_at IS NULL"),
		count(w.db, "SELECT COUNT(*) AS n FROM expenses WHERE driver = 'Orrin Pike'"),
		count(w.db, "SELECT COUNT(*) AS n FROM documents WHERE driver = '' AND type = 'RATECON'"),
	], [1, 1, 1]);
	ok("§7 ...their files are still on disk", fileThere(w, "/uploads/L-9100_POD_op.jpg") && fileThere(w, "/uploads/rate-cons/L-9001.pdf"));
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
	eq("§7 closed-month receipt + POD: refused with PERIOD_FINALIZED, as before", [r.status, r.body.code], [409, "PERIOD_FINALIZED"]);
	eq("§7 ...naming the closed month", r.body.periods, ["2026-09"]);
	ok("§7 ...with the closed-month remedy", /Leave the account in place — a closed month's figures are attributed to it\. Nothing was changed\./.test(String(r.body.error || "")), r.body.error);
	eq("§7 ...the POD stays", docRows(w.db, "L-9008_POD_tv.jpg"), 1);
	done(w);
}
{
	// A paid invoice, a live POD and an open-month receipt: INVOICE_ALREADY_PAID
	// stays the code (both new blockers are appended after the invoices blocker).
	const w = world({
		invoices: [{ n: "INV-MADEUP-01", driver: "tamsin vale", ws: "2026-10-03", we: "2026-10-09", paid: "2026-10-12" }],
		expenses: [OPEN_RCPT],
		docs: [{ load: "L-9009", driver: "Tamsin Vale", type: "POD", file: "L-9009_POD_tv.jpg" }],
	});
	const r = del(w, TVALE.id);
	eq("§7 paid invoice + POD + open-month receipt: refused with INVOICE_ALREADY_PAID, as before", [r.status, r.body.code], [409, "INVOICE_ALREADY_PAID"]);
	ok("§7 ...the invoices blocker comes first", (r.body.blockers || [])[0] && r.body.blockers[0].table === "invoices", JSON.stringify(r.body.blockers));
	eq("§7 ...then the documents and open-month receipt blockers, in that order",
		(r.body.blockers || []).map((b) => b.code), ["INVOICE_ALREADY_PAID", "DRIVER_HAS_DOCUMENTS", "OPEN_MONTH_EXPENSES"]);
	done(w);
}

// ---------------------------------------------------------------------------
// §8 Source pins (comments stripped, so a comment's words never satisfy or
// break one).
// ---------------------------------------------------------------------------
{
	const CODE = codeOnly(DELETE_SRC);
	ok("§8 the user delete route removes no documents row", !/DELETE\s+FROM\s+documents\b/i.test(CODE));
	ok("§8 ...and unlinks no file", !/\bunlink(Sync)?\s*\(|\brm(Sync)?\s*\(/.test(CODE));
	ok("§8 the cascade still clears the driver's messages and notifications (unchanged)",
		/DELETE FROM messages WHERE/.test(CODE) && /DELETE FROM notifications WHERE LOWER\(driver_name\) = \?/.test(CODE));
	const SOFT = codeOnly(routeSource("delete", "/api/documents/:id"));
	ok("§8 DELETE /api/documents/:id is still a soft delete", /UPDATE documents SET deleted_at = CURRENT_TIMESTAMP/.test(SOFT) && !/DELETE\s+FROM\s+documents\b/i.test(SOFT));
	const GUARD = codeOnly(liftFn("userDeleteLockBlockers"));
	ok("§8 the guard asks driverRenameWidens() once, for both name-matched legs",
		(GUARD.match(/driverRenameWidens\(/g) || []).length === 1, String((GUARD.match(/driverRenameWidens\(/g) || []).length));
}

// ---------------------------------------------------------------------------
// §9 DISCRIMINATION: each new clause of the guard, taken out, must flip an
// assertion above. A mutant whose anchor is missing is a failure, never a pass.
// ---------------------------------------------------------------------------
{
	const REAL = liftFn("userDeleteLockBlockers");
	const guardWith = (from, to) => {
		const n = REAL.split(from).length - 1;
		if (n !== 1) { ok(`§9 mutant anchor found exactly once: ${from.slice(0, 60)}`, false, `found ${n}`); return null; }
		return GUARD_SRC.replace(REAL, REAL.replace(from, to));
	};
	const run = (src, opts) => { const w = world(opts); const r = del(w, TVALE.id, src); done(w); return r; };
	const POD = { docs: [{ load: "L-9020", driver: "Tamsin Vale", type: "POD", file: "L-9020_POD_tv.jpg" }] };

	const noDocs = guardWith("if (docs.n) blockers.push({", "if (false) blockers.push({");
	if (noDocs) eq("§9 mutant: without the documents blocker the POD no longer holds the delete", run(noDocs, POD).status, 200);

	const noOpen = guardWith("if (openExpenseRows) blockers.push({", "if (false) blockers.push({");
	if (noOpen) eq("§9 mutant: without the open-month blocker the receipt no longer holds the delete", run(noOpen, { expenses: [OPEN_RCPT] }).status, 200);

	const narrow = guardWith("? { userId: user.id } :", "? { userId: user.id, widens: false } :");
	if (narrow) eq("§9 mutant: without the widening a POD under another spacing no longer holds the delete",
		run(narrow, { docs: [{ load: "L-9021", driver: "tamsin  vale", type: "POD", file: "L-9021_POD_tv.jpg" }] }).status, 200);

	const liveAndGone = guardWith("AND deleted_at IS NULL`", "`");
	if (liveAndGone) eq("§9 mutant: counting soft-deleted rows refuses a delete §3 lets through",
		run(liveAndGone, { docs: [{ load: "L-9022", driver: "Tamsin Vale", type: "POD", file: "L-9022_POD_old.jpg", deleted: "2026-10-03 14:00:00" }] }).status, 409);

	const caseBound = guardWith("UPPER(TRIM(COALESCE(type, ''))) = 'POD'", "type = 'POD'");
	if (caseBound) {
		const r = run(caseBound, { docs: [
			{ load: "L-9023", driver: "Tamsin Vale", type: "pod", file: "L-9023_pod.jpg" },
			{ load: "L-9024", driver: "Tamsin Vale", type: " POD ", file: "L-9024_POD.jpg" },
		] });
		eq("§9 mutant: an exact-case POD test misses \"pod\" and \" POD \"", (blockerOf(r, "DRIVER_HAS_DOCUMENTS") || {}).pods, 0);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
