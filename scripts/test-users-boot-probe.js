#!/usr/bin/env node
/**
 * scripts/test-users-boot-probe.js: the users table's start-up role check (lib/users-table-migrate.js),
 * which server.js runs right after the users CREATE.
 *
 * server.js's block between the users CREATE and the full_name migration is lifted and run as a start
 * runs it, on made-up scratch databases opened as the app opens them (WAL, foreign keys on), with made-up
 * accounts, rows in the four child tables, a deleted top account (so the sequence sits above the highest
 * id), sessions and an audit table:
 *
 *   §1 the wiring: that block is the one call into the lib, whose new table is server.js's users CREATE
 *   §2 a probe that passes (server.js's table with its ALTERs; a CHECK that admits KPI Viewer, with a KPI
 *      Viewer row): nothing logged; the schema and every row as before, the probe's one id aside; the
 *      same database the probe's INSERT and DELETE leave when run as two statements; no probe row
 *   §3 probe failures other than the role CHECK (UNIQUE, another CHECK, a trigger, NOT NULL, a busy or a
 *      read-only database): no rebuild, one line naming the code only, the start goes on, every table as
 *      before
 *   §4 the probe leaves no row: its DELETE refused, or a failure at each of its steps
 *   §5 a role CHECK that leaves "Super Admin" out (an older table that lists "Admin"): rebuilt in one
 *      transaction; "Admin" rows become "Super Admin" and every other value, id and child row is as before;
 *      the child tables' entries and foreign keys unchanged and valid; the sequence kept; the index and the
 *      trigger re-created; sessions cleared; foreign keys back on; the next start finds nothing to do
 *   §6 a failure at each rebuild step, a row the four roles refuse, and a view naming users: rolled back,
 *      every table, the schema and the foreign keys as before, one line naming the step
 *   §7 a table the rebuild can't carry (another column; a users_new beside it): no rebuild, one line
 *   §8 mutants of the lib, each caught by the battery the shipped lib passes
 *
 * Fails on a base without lib/users-table-migrate.js: SERVER_ROOT=<a base checkout> runs that base's
 * block, and §1, §4, §6 and §8 need the lib.
 *
 * Hermetic: made-up data in a fresh temp folder, removed at the end.
 *   node scripts/test-users-boot-probe.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const BASE = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : ROOT;
const LIB_FILE = path.join(BASE, "lib", "users-table-migrate.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (label, actual, expected) => ok(label, same(actual, expected), { actual, expected });
// A section that throws (a base's block can leave a database these reads can't take) is one failure.
function section(name, fn) {
	try { fn(); } catch (err) { ok(`${name}: ran to the end`, false, err.stack || String(err)); }
}

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}

// ── what server.js runs ───────────────────────────────────────────────────────────────────────────
const SRC = serverSource();
function lift(re, what) {
	const m = re.exec(SRC);
	ok(`(fixture) server.js has ${what}`, !!m);
	return m ? m[0] : "";
}
const USERS_DDL = lift(/CREATE TABLE IF NOT EXISTS users \([\s\S]*?\n\t\)/, "the users CREATE");
const USERS_ALTERS = [...SRC.matchAll(/db\.exec\("(ALTER TABLE users ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]);
const CHILDREN = ["driver_emergency_contacts", "driver_onboarding", "driver_payment_info", "onboarding_documents"];
const CHILD_DDL = CHILDREN.map((t) => lift(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\([\\s\\S]*?\\n\\t\\)`), `the ${t} CREATE`));
const AUDIT_DDL = lift(/CREATE TABLE IF NOT EXISTS audit_trail \([\s\S]*?\n\t\)/, "the audit_trail CREATE");
// better-sqlite3-session-store's table.
const SESSIONS_DDL = "CREATE TABLE IF NOT EXISTS sessions (sid TEXT NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TEXT NOT NULL)";
// The block a start runs between the users CREATE and the next migration.
const CREATE_END = "\n`);\n";
const createAt = SRC.indexOf("CREATE TABLE IF NOT EXISTS users (");
const blockFrom = createAt > -1 ? SRC.indexOf(CREATE_END, createAt) : -1;
const blockTo = blockFrom > -1 ? SRC.indexOf("\n// Migrate: add full_name column if not present", blockFrom) : -1;
const BLOCK = blockFrom > -1 && blockTo > -1 ? SRC.slice(blockFrom + CREATE_END.length, blockTo) : "";
ok("(fixture) server.js has a block between the users CREATE and the full_name migration", BLOCK.trim() !== "");
const serverRequire = Module.createRequire(path.join(BASE, "server.js"));
const { checkRoles } = serverRequire("./lib/users-role-migration");

// A copy of the lib compiled from its text, so a mutant runs under the same requires.
function compileLib(src) {
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", src)(m, m.exports, Module.createRequire(LIB_FILE), LIB_FILE, path.dirname(LIB_FILE));
	return m.exports;
}
const LIB_SRC = fs.existsSync(LIB_FILE) ? fs.readFileSync(LIB_FILE, "utf8") : null;
const L = LIB_SRC ? compileLib(LIB_SRC) : null;
// The probe's two statements (the lib's, or a base's server.js's).
const PROBE_SRC = `${SRC}\n${LIB_SRC || ""}`;
const PROBE_INSERT = (/"(INSERT INTO users \(username, password_hash, role\) VALUES \('__test_sa__'[^"]*)"/.exec(PROBE_SRC) || [])[1];
const PROBE_DELETE = (/"(DELETE FROM users WHERE username = '__test_sa__')"/.exec(PROBE_SRC) || [])[1];
ok("(fixture) the probe's statements are found", !!PROBE_INSERT && !!PROBE_DELETE);
const PROBE_USERNAME = "__test_sa__";

// ── made-up worlds ────────────────────────────────────────────────────────────────────────────────
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-users-boot-probe-")));
const STAMP = "2026-10-20T14:00:00.000Z";
const LATER = new Date(Date.now() + 86400000).toISOString();
const EARLIER = new Date(Date.now() - 86400000).toISOString();
// server.js's table with its ALTERs (15 columns). One account has a blank email.
const TODAY_USERS = [
	{ id: 1, username: "owner_sample", password_hash: "made-up-hash-1", role: "Super Admin", email: "owner@example.test", full_name: "Olive Sample", last_login_at: STAMP, created_at: "2026-10-01 12:00:00" },
	{ id: 2, username: "desk_sample", password_hash: "made-up-hash-2", role: "Dispatcher", email: "desk@example.test", must_change_password: 1, disabled_at: STAMP, disabled_by: 1, disabled_reason: "made-up reason", created_at: "2026-10-01 12:00:00" },
	{ id: 3, username: "dana_sample", password_hash: "made-up-hash-3", role: "Driver", driver_name: "Dana Sample", email: "dana.o'neil@example.test", rating: 4.5, created_at: "2026-10-01 12:00:00" },
	{ id: 4, username: "drew_sample", password_hash: "made-up-hash-4", role: "Driver", driver_name: "Drew Sample", full_name: "Drew Ünal Sample", email: "drew@example.test", created_at: "2026-10-01 12:00:00" },
	{ id: 5, username: "ivan_sample", password_hash: "made-up-hash-5", role: "Investor", company_name: "Sample Haulers LLC", created_at: "2026-10-01 12:00:00" },
];
const KAY = { id: 6, username: "kay_sample", password_hash: "made-up-hash-6", role: "KPI Viewer", email: "kay@example.test", created_at: "2026-10-01 12:00:00" };
// server.js's CREATE alone (7 columns), and an older table of that shape whose CHECK lists "Admin".
const SEVEN_USERS = [
	{ id: 1, username: "owner_sample", password_hash: "made-up-hash-1", role: "Super Admin", email: "owner@example.test", created_at: "2026-03-20 12:00:00" },
	{ id: 2, username: "desk_sample", password_hash: "made-up-hash-2", role: "Dispatcher", email: "desk@example.test", created_at: "2026-03-20 12:00:00" },
	{ id: 3, username: "dana_sample", password_hash: "made-up-hash-3", role: "Driver", driver_name: "Dana Sample", email: "dana.o'neil@example.test", created_at: "2026-03-20 12:00:00" },
	{ id: 4, username: "drew_sample", password_hash: "made-up-hash-4", role: "Driver", driver_name: "Drew Ünal Sample", created_at: "2026-03-20 12:00:00" },
	{ id: 5, username: "ivan_sample", password_hash: "made-up-hash-5", role: "Investor", created_at: "2026-03-20 12:00:00" },
];
const LEGACY_USERS = SEVEN_USERS.map((u) => (u.role === "Super Admin" ? { ...u, role: "Admin" } : u));
const GONE = { id: 9, username: "gone_sample", password_hash: "made-up-hash-9", role: "Dispatcher" };
const VERA = { id: 7, username: "vera_sample", password_hash: "made-up-hash-7", role: "Viewer", created_at: "2026-03-20 12:00:00" };

const LEGACY_DDL = USERS_DDL.replace("CHECK(role IN ('Super Admin', ", "CHECK(role IN ('Admin', ");
const VIEWER_DDL = LEGACY_DDL.replace("'Investor'))", "'Investor', 'Viewer'))");
const KPI_DDL = USERS_DDL.replace("'Investor'))", "'Investor', 'KPI Viewer'))");
const HASH_CHECK_DDL = USERS_DDL.replace("password_hash TEXT NOT NULL,", "password_hash TEXT NOT NULL CHECK(length(password_hash) >= 12),");
const NOT_NULL_DDL = USERS_DDL.replace("created_at DATETIME DEFAULT CURRENT_TIMESTAMP", "created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n\t\tsample_code TEXT NOT NULL");
const EXTRA_COLUMN_DDL = LEGACY_DDL.replace("created_at DATETIME DEFAULT CURRENT_TIMESTAMP", "created_at DATETIME DEFAULT CURRENT_TIMESTAMP,\n\t\tfull_name TEXT NOT NULL DEFAULT ''");
ok("(fixture) each made-up variant of the users CREATE is a change to it",
	[LEGACY_DDL, KPI_DDL, HASH_CHECK_DDL, NOT_NULL_DDL].every((d) => d !== USERS_DDL) && VIEWER_DDL !== LEGACY_DDL && EXTRA_COLUMN_DDL !== LEGACY_DDL);
const INSERT_TRIGGER = "CREATE TRIGGER trg_users_insert_sample BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'made-up refusal'); END";
const DELETE_TRIGGER = "CREATE TRIGGER trg_users_delete_sample BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'made-up refusal'); END";
const UNIQUE_EMAIL = "CREATE UNIQUE INDEX idx_users_email_unique_sample ON users(email)";
const LEGACY_INDEX = "CREATE INDEX idx_users_email_sample ON users(email)";
const LEGACY_TRIGGER = "CREATE TRIGGER trg_users_email_sample AFTER UPDATE OF email ON users BEGIN SELECT 1; END";
const VIEW = "CREATE VIEW v_users_sample AS SELECT id, username FROM users";

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
function insert(db, table, row) {
	const keys = Object.keys(row);
	return db.prepare(`INSERT INTO ${q(table)} (${keys.map(q).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
}
const sessJson = (u, expire) => JSON.stringify({ cookie: { originalMaxAge: 86400000, expires: expire, httpOnly: true, path: "/" }, user: { id: u.id, username: u.username, role: u.role } });

let worlds = 0;
function world({ ddl = USERS_DDL, alters = true, users = TODAY_USERS, extraUsers = [], rowExtra = {}, after = [] } = {}) {
	const dir = path.join(tmp, `w${++worlds}`);
	fs.mkdirSync(dir);
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	try {
		db.pragma("journal_mode = WAL");
		db.exec(ddl);
		if (alters) for (const sql of USERS_ALTERS) db.exec(sql);
		// A stand-in parent for driver_onboarding.application_id.
		db.exec("CREATE TABLE job_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL DEFAULT '')");
		for (const sql of CHILD_DDL) db.exec(sql);
		db.exec(AUDIT_DDL);
		db.exec(SESSIONS_DDL);
		for (const u of [...users, ...extraUsers]) insert(db, "users", { ...u, ...rowExtra });
		insert(db, "users", { ...GONE, ...rowExtra });
		db.prepare("DELETE FROM users WHERE id = ?").run(GONE.id);
		insert(db, "job_applications", { id: 1, full_name: "Dana Sample" });
		insert(db, "job_applications", { id: 2, full_name: "Drew Sample" });
		insert(db, "driver_onboarding", { user_id: 3, application_id: 1, driver_name: "Dana Sample", status: "documents_signed" });
		insert(db, "driver_onboarding", { user_id: 4, application_id: 2, driver_name: "Drew Sample" });
		insert(db, "onboarding_documents", { user_id: 3, doc_key: "w9", doc_name: "W-9", signed: 1 });
		insert(db, "onboarding_documents", { user_id: 4, doc_key: "lease", doc_name: "Lease" });
		insert(db, "driver_payment_info", { user_id: 3, payment_method: "ach", bank_name: "Sample Bank", bank_routing: "routing-sample", bank_account: "account-sample" });
		for (const [position, name] of [[1, "Casey Sample"], [2, "Jordan Sample"]]) {
			insert(db, "driver_emergency_contacts", { user_id: 3, position, contact_name: name, relationship: "Sibling", contact_phone: `555-010${position}`, created_at: STAMP, updated_at: STAMP });
		}
		insert(db, "sessions", { sid: "sid-made-up-0001", sess: sessJson(users[0], LATER), expire: LATER });
		insert(db, "sessions", { sid: "sid-made-up-0002", sess: sessJson(users[2], LATER), expire: LATER });
		insert(db, "sessions", { sid: "sid-made-up-0003", sess: sessJson(users[1], EARLIER), expire: EARLIER });
		insert(db, "audit_trail", { timestamp: STAMP, user_id: 1, username: "owner_sample", role: users[0].role, action: "create_user", entity: "user", entity_id: "5", details: "made-up row" });
		for (const sql of after) db.exec(sql);
	} finally {
		db.close();
	}
	return file;
}
const todayWorld = ({ kpiViewer = false, uniqueEmail = false, notNull = false, after = [] } = {}) => world({
	ddl: kpiViewer ? KPI_DDL : notNull ? NOT_NULL_DDL : USERS_DDL,
	extraUsers: kpiViewer ? [KAY] : [],
	rowExtra: notNull ? { sample_code: "made-up-code" } : {},
	after: [...(uniqueEmail ? [UNIQUE_EMAIL] : []), ...after],
});
const sevenWorld = ({ hashCheck = false, after = [] } = {}) => world({ ddl: hashCheck ? HASH_CHECK_DDL : USERS_DDL, alters: false, users: SEVEN_USERS, after });
const legacyWorld = ({ viewer = false, extraColumn = false, after = [] } = {}) => world({
	ddl: viewer ? VIEWER_DDL : extraColumn ? EXTRA_COLUMN_DDL : LEGACY_DDL,
	alters: false,
	users: extraColumn ? LEGACY_USERS.map((u) => ({ ...u, full_name: `${u.username} full` })) : LEGACY_USERS,
	extraUsers: viewer ? [VERA] : [],
	after: [LEGACY_INDEX, LEGACY_TRIGGER, ...after],
});

// Every table's rows (each value with its storage class), sqlite_master, every table's foreign keys, the
// users columns and the foreign-key check.
function snapshot(file) {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
		const tables = {};
		const keys = {};
		for (const t of master.filter((m) => m.type === "table")) {
			const cols = db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").pluck().all(t.name);
			tables[t.name] = db.prepare(`SELECT ${cols.map((c) => `quote(${q(c)})`).join(", ")} FROM ${q(t.name)} ORDER BY rowid`).raw().all();
			keys[t.name] = db.prepare("SELECT \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq").all(t.name);
		}
		return {
			master,
			tables,
			keys,
			columns: db.prepare("SELECT * FROM pragma_table_info(?) ORDER BY cid").all("users"),
			fk: db.prepare("SELECT * FROM pragma_foreign_key_check()").all(),
		};
	} finally {
		db.close();
	}
}
const entry = (snap, name) => snap.master.find((m) => m.name === name) || null;
const masterBut = (snap, name) => snap.master.filter((m) => m.name !== name);
const tablesBut = (snap, ...names) => Object.fromEntries(Object.entries(snap.tables).filter(([t]) => !names.includes(t)));
const seqOf = (snap) => Number(((snap.tables.sqlite_sequence || []).find((r) => r[0] === "'users'") || [])[1]);
function read(file, sql, args = []) {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try { return db.prepare(sql).get(...args); } catch (err) { return { error: err.message }; } finally { db.close(); }
}
const probeRows = (file) => (read(file, "SELECT COUNT(*) AS n FROM users WHERE username = ?", [PROBE_USERNAME]) || {}).n;
const rolesIn = (file) => checkRoles((read(file, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", ["users"]) || {}).sql);
function attempt(file, sql, args) {
	const db = new Database(file);
	try { db.pragma("foreign_keys = ON"); db.prepare(sql).run(...args); return "ok"; } catch (err) { return err.message; } finally { db.close(); }
}
function holdWriteLock(file) {
	const holder = new Database(file);
	holder.exec("BEGIN IMMEDIATE");
	return holder;
}

function capture() {
	const lines = [];
	const push = (kind) => (...a) => lines.push([kind, a.join(" ")]);
	return { lines, log: { log: push("log"), error: push("error"), warn: push("warn") } };
}
const ALL_LINES = [];
// A start: the database opened as server.js opens it, then the lifted block.
function start(file, { timeout, readonly = false } = {}) {
	const c = capture();
	const db = new Database(file, { fileMustExist: true, readonly, ...(timeout ? { timeout } : {}) });
	const out = { threw: null, lines: c.lines, keys: null, open: null };
	try {
		if (!readonly) db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		try {
			new Function("require", "db", "console", BLOCK)(serverRequire, db, c.log);
		} catch (err) {
			out.threw = err.message;
		}
		out.keys = db.pragma("foreign_keys", { simple: true });
		out.open = db.inTransaction;
	} finally {
		db.close();
	}
	ALL_LINES.push(...c.lines);
	return out;
}
// The lib called directly (a compiled copy, a mutant's included), with a runner's hooks.
function startLib(Lx, file, { hooks, timeout } = {}) {
	const c = capture();
	const db = new Database(file, { fileMustExist: true, ...(timeout ? { timeout } : {}) });
	const out = { result: null, threw: null, lines: c.lines, keys: null, open: null };
	try {
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		try { out.result = Lx.startupRoleCheck(db, { log: c.log, hooks }); } catch (err) { out.threw = err.message; }
		out.keys = db.pragma("foreign_keys", { simple: true });
		out.open = db.inTransaction;
	} finally {
		db.close();
	}
	ALL_LINES.push(...c.lines);
	return out;
}
// The probe's INSERT and DELETE run as two statements: what a passing start writes.
function runProbeStatements(file) {
	const db = new Database(file, { fileMustExist: true });
	try {
		db.pragma("foreign_keys = ON");
		db.prepare(PROBE_INSERT).run();
		db.prepare(PROBE_DELETE).run();
	} finally {
		db.close();
	}
}
const failAt = (name) => ({ beforeStep: (step) => { if (step === name) throw new Error(`made-up failure at ${step}`); } });
// Removes the parent of a driver_onboarding row just before the foreign-key check.
const dropParentAt = (name) => ({ beforeStep: (step, db) => { if (step === name) db.prepare("DELETE FROM job_applications WHERE id = ?").run(2); } });
// Changes a copied value before the old table is dropped.
const changeCopyAt = (name) => ({ beforeStep: (step, db) => { if (step === name) db.prepare("UPDATE users_new SET email = ? WHERE id = ?").run("changed@example.test", 3); } });
// The users rows of a snapshot with "Admin" read as "Super Admin" in the role column.
function asRenamed(snap) {
	const at = snap.columns.findIndex((c) => c.name === "role");
	return snap.tables.users.map((row) => row.map((v, i) => (i === at && v === "'Admin'" ? "'Super Admin'" : v)));
}
const FOUR = ["Super Admin", "Dispatcher", "Driver", "Investor"];
const SEVEN = (() => {
	const mem = new Database(":memory:");
	try { mem.exec(USERS_DDL); return mem.prepare("SELECT name FROM pragma_table_info('users') ORDER BY cid").pluck().all(); } finally { mem.close(); }
})();

try {
	// ── §1 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§1 the wiring");
	section("§1", () => {
		const code = BLOCK.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
		eq("§1 server.js's block between the users CREATE and the full_name migration is the one call into lib/users-table-migrate.js",
			code, ['require("./lib/users-table-migrate").startupRoleCheck(db, { log: console });']);
		ok("§1 ...and server.js holds no other copy of the probe's INSERT", !SRC.includes("VALUES ('__test_sa__', '__test__', 'Super Admin')"));
		ok("§1 lib/users-table-migrate.js exists", !!L, LIB_FILE);
		if (!L) return;
		const mem = new Database(":memory:");
		try {
			mem.exec(USERS_DDL);
			mem.exec(L.CREATE_NEW);
			const info = (t) => mem.prepare("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid").all(t);
			const uniques = (t) => mem.prepare("SELECT * FROM pragma_index_list(?) WHERE origin = 'u'").all(t)
				.map((ix) => mem.prepare("SELECT name FROM pragma_index_info(?)").pluck().all(ix.name));
			const sqlOf = (t) => mem.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t).sql;
			eq("§1 the rebuild's new table has server.js's users columns (PRAGMA table_info)", info(L.NEW_TABLE), info("users"));
			eq("§1 ...its UNIQUE index", uniques(L.NEW_TABLE), uniques("users"));
			eq("§1 ...and its role list, the four roles", [checkRoles(sqlOf(L.NEW_TABLE)), checkRoles(sqlOf("users"))], [FOUR, FOUR]);
			eq("§1 the columns the rebuild carries are those of server.js's CREATE", [...L.COLUMNS], SEVEN);
			eq("§1 the probe's three steps and the rebuild's twelve", [[...L.PROBE_STEPS], [...L.STEPS]], [["probe insert", "probe delete", "probe commit"],
				["begin", "read", "create", "copy", "drop", "rename", "recreate", "sequence", "sessions", "fkcheck", "verify", "commit"]]);
		} finally {
			mem.close();
		}
	});

	// ── §2 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§2 a probe that passes");
	section("§2", () => {
		for (const [label, opts] of [["server.js's table and its ALTERs", {}], ["a CHECK that admits KPI Viewer, with a KPI Viewer row", { kpiViewer: true }]]) {
			const file = todayWorld(opts);
			const twin = todayWorld(opts);
			const before = snapshot(file);
			const s = start(file);
			const after = snapshot(file);
			runProbeStatements(twin);
			eq(`§2 ${label}: nothing logged, the start goes on, foreign keys on, no transaction open`, [s.threw, s.lines, s.keys, s.open], [null, [], 1, false]);
			eq(`§2 ...the schema byte for byte as before (${label})`, after.master, before.master);
			eq(`§2 ...every row of every table as before, sqlite_sequence aside (${label})`, tablesBut(after, "sqlite_sequence"), tablesBut(before, "sqlite_sequence"));
			eq(`§2 ...where users moved by the probe's one id (${label})`, seqOf(after), seqOf(before) + 1);
			eq(`§2 ...the same database the probe's INSERT and DELETE leave when run as two statements (${label})`, after, snapshot(twin));
			eq(`§2 ...and no probe row (${label})`, probeRows(file), 0);
		}
	});

	// ── §3 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§3 probe failures other than the role CHECK");
	section("§3", () => {
		const cases = [
			["a UNIQUE index the probe row collides with", () => todayWorld({ uniqueEmail: true }), {}, "SQLITE_CONSTRAINT_UNIQUE"],
			["the same, on a CHECK that admits KPI Viewer, with a KPI Viewer row", () => todayWorld({ kpiViewer: true, uniqueEmail: true }), {}, "SQLITE_CONSTRAINT_UNIQUE"],
			["another CHECK on the table refusing the probe row", () => sevenWorld({ hashCheck: true }), {}, "SQLITE_CONSTRAINT_CHECK"],
			["a trigger refusing the insert", () => todayWorld({ after: [INSERT_TRIGGER] }), {}, "SQLITE_CONSTRAINT_TRIGGER"],
			["the same, on an older table whose CHECK leaves Super Admin out", () => legacyWorld({ after: [INSERT_TRIGGER] }), {}, "SQLITE_CONSTRAINT_TRIGGER"],
			["a NOT NULL column with no default", () => todayWorld({ notNull: true }), {}, "SQLITE_CONSTRAINT_NOTNULL"],
			["the database busy (another connection holds the write lock)", () => todayWorld(), { busy: true, timeout: 50 }, "SQLITE_BUSY"],
			["the same, on an older table whose CHECK leaves Super Admin out", () => legacyWorld(), { busy: true, timeout: 50 }, "SQLITE_BUSY"],
			["the database opened read-only", () => todayWorld(), { readonly: true }, "SQLITE_READONLY"],
		];
		for (const [label, make, opts, code] of cases) {
			const file = make();
			const before = snapshot(file);
			const holder = opts.busy ? holdWriteLock(file) : null;
			let s;
			try {
				s = start(file, opts);
			} finally {
				if (holder) { holder.exec("ROLLBACK"); holder.close(); }
			}
			ok(`§3 ${label}: no rebuild, one line naming ${code}, the start goes on`,
				s.threw === null && s.lines.length === 1 && s.lines[0][0] === "error" && s.lines[0][1].includes(`(${code})`) && /no rebuild/.test(s.lines[0][1]), s);
			eq(`§3 ...every table, the schema and the foreign keys as before, sqlite_sequence too (${label})`, snapshot(file), before);
			eq(`§3 ...foreign keys on, no transaction open, no probe row (${label})`, [s.keys, s.open, probeRows(file)], [1, false, 0]);
		}
	});

	// ── §4 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§4 the probe leaves no row");
	section("§4", () => {
		const file = todayWorld({ after: [DELETE_TRIGGER] });
		const before = snapshot(file);
		const s = start(file);
		ok("§4 its DELETE refused (a trigger): no probe row, one line naming SQLITE_CONSTRAINT_TRIGGER, no rebuild",
			s.threw === null && probeRows(file) === 0 && s.lines.length === 1 && s.lines[0][1].includes("(SQLITE_CONSTRAINT_TRIGGER)") && /no rebuild/.test(s.lines[0][1]), s);
		eq("§4 ...every table, the schema and the foreign keys as before, sqlite_sequence too", snapshot(file), before);
		if (!L) return;
		for (const name of L.PROBE_STEPS) {
			const f = todayWorld();
			const b = snapshot(f);
			const r = startLib(L, f, { hooks: failAt(name) });
			ok(`§4 a failure at "${name}": skipped, no probe row, one line, foreign keys on, no transaction open`,
				r.threw === null && r.result && r.result.state === "skipped" && probeRows(f) === 0 && r.lines.length === 1 && r.keys === 1 && r.open === false, r);
			eq(`§4 ...every table as before, sqlite_sequence too (${name})`, snapshot(f), b);
		}
	});

	// ── §5 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§5 a role CHECK that leaves Super Admin out");
	section("§5", () => {
		const file = legacyWorld();
		const before = snapshot(file);
		eq("(fixture) the older table's CHECK lists Admin, not Super Admin", rolesIn(file), ["Admin", "Dispatcher", "Driver", "Investor"]);
		const s = start(file);
		const after = snapshot(file);
		ok("§5 one line: users rebuilt with the four roles in one transaction, naming the counts; the start goes on",
			s.threw === null && s.lines.length === 1 && s.lines[0][0] === "log"
			&& s.lines[0][1].includes('users rebuilt with the four roles in one transaction (5 rows, 1 "Admin" now "Super Admin"; sessions cleared)'), s);
		eq("§5 ...foreign keys back on, no transaction open", [s.keys, s.open], [1, false]);
		eq("§5 the CHECK lists the four roles", rolesIn(file), FOUR);
		eq("§5 every row as before, \"Admin\" now \"Super Admin\" (every value with its storage class, every id)", after.tables.users, asRenamed(before));
		eq("§5 the columns as server.js's CREATE makes them", after.columns.map((c) => c.name), SEVEN);
		for (const t of CHILDREN) {
			eq(`§5 ${t}: its sqlite_master entry byte for byte as before`, entry(after, t), entry(before, t));
			eq(`§5 ...its foreign keys as before (${t})`, after.keys[t], before.keys[t]);
			eq(`§5 ...and its rows (${t})`, after.tables[t], before.tables[t]);
		}
		eq("§5 foreign_key_check is empty", after.fk, []);
		eq("§5 the sequence keeps its old value (9), above the highest id", seqOf(after), 9);
		eq("§5 the index and the trigger on users are re-created, byte for byte",
			[entry(after, "idx_users_email_sample"), entry(after, "trg_users_email_sample")], [entry(before, "idx_users_email_sample"), entry(before, "trg_users_email_sample")]);
		eq("§5 sessions are cleared (they hold the old role names)", after.tables.sessions, []);
		eq("§5 every other table as before", tablesBut(after, "users", "sessions", "sqlite_sequence"), tablesBut(before, "users", "sessions", "sqlite_sequence"));
		eq("§5 sqlite_master: only the users entry changed", masterBut(after, "users"), masterBut(before, "users"));
		// What server.js runs next, then a second start.
		const db = new Database(file);
		try { for (const sql of USERS_ALTERS) db.exec(sql); } finally { db.close(); }
		const mid = snapshot(file);
		const s2 = start(file);
		const end = snapshot(file);
		eq("§5 the next start, after the ALTERs: nothing logged, the start goes on", [s2.threw, s2.lines, s2.keys, s2.open], [null, [], 1, false]);
		eq("§5 ...the schema and the rows as before, sqlite_sequence aside", [end.master, tablesBut(end, "sqlite_sequence")], [mid.master, tablesBut(mid, "sqlite_sequence")]);
		eq("§5 ...and users has server.js's 15 columns", end.columns.length, 15);
		const id = (() => { const w = new Database(file); try { w.pragma("foreign_keys = ON"); return Number(insert(w, "users", { username: "next_sample", password_hash: "made-up-hash-n", role: "Super Admin" }).lastInsertRowid); } finally { w.close(); } })();
		eq("§5 a Super Admin can be added, with an id above the old sequence and the probe's", id, 11);
		ok("§5 ...and \"Admin\" is refused", /CHECK constraint failed/.test(attempt(file, "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ["admin_sample", "made-up-hash-a", "Admin"])));
		ok("§5 a child row naming a missing account is refused, foreign keys on", /FOREIGN KEY constraint failed/.test(attempt(file, "INSERT INTO onboarding_documents (user_id, doc_key, doc_name) VALUES (?, ?, ?)", [77, "w9", "W-9"])));
	});

	// ── §6 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§6 a failure at each rebuild step");
	section("§6", () => {
		if (L) {
			for (const name of L.STEPS) {
				const file = legacyWorld();
				const before = snapshot(file);
				const r = startLib(L, file, { hooks: failAt(name) });
				eq(`§6 a failure at "${name}": rolled back at that step`, [r.threw, r.result && r.result.state, r.result && r.result.step], [null, "rolled back", name]);
				eq(`§6 ...every table, the schema and the foreign keys as before (${name})`, snapshot(file), before);
				ok(`§6 ...foreign keys on, no transaction open, one line naming the step (${name})`,
					r.keys === 1 && r.open === false && r.lines.length === 1 && r.lines[0][0] === "error" && r.lines[0][1].includes(`failed at ${name} (`), r);
			}
		} else {
			ok("§6 lib/users-table-migrate.js exists, for the step hooks", false, LIB_FILE);
		}
		for (const [label, make, step] of [
			["a row the four roles refuse (an older table that lists \"Viewer\")", () => legacyWorld({ viewer: true }), "copy"],
			["a view that names users", () => legacyWorld({ after: [VIEW] }), "rename"],
		]) {
			const file = make();
			const before = snapshot(file);
			const s = start(file);
			ok(`§6 ${label}: rolled back at ${step}, one line, the start goes on`,
				s.threw === null && s.lines.length === 1 && s.lines[0][0] === "error" && s.lines[0][1].includes(`failed at ${step} (`), s);
			eq(`§6 ...every table, the schema and the foreign keys as before (${label})`, snapshot(file), before);
			eq(`§6 ...foreign keys on, no transaction open (${label})`, [s.keys, s.open], [1, false]);
		}
	});

	// ── §7 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§7 a table the rebuild can't carry");
	section("§7", () => {
		for (const [label, make, why] of [
			["an older table with a column the rebuild doesn't carry", () => legacyWorld({ extraColumn: true }), /it has 8 columns, not the 7 this rebuild carries/],
			["an older table beside a users_new table", () => legacyWorld({ after: ["CREATE TABLE users_new (id INTEGER)"] }), /a table named users_new exists/],
		]) {
			const file = make();
			const before = snapshot(file);
			const s = start(file);
			ok(`§7 ${label}: no rebuild, one line saying why, the start goes on`,
				s.threw === null && s.lines.length === 1 && s.lines[0][0] === "error" && why.test(s.lines[0][1]) && /no rebuild/.test(s.lines[0][1]), s);
			eq(`§7 ...every table, the schema and the foreign keys as before (${label})`, snapshot(file), before);
		}
	});

	console.log("§3-§7 the log lines");
	ok("§3-§7 no logged line carries row data (usernames, emails, hashes, session ids, child values, a trigger's text)",
		ALL_LINES.length > 0 && !ALL_LINES.some(([, l]) => /_sample|example\.test|made-up|sid-|Sample Bank|routing-sample|Casey|Jordan|Dana|Drew/.test(l)), ALL_LINES);

	// ── §8 ────────────────────────────────────────────────────────────────────────────────────────
	if (L) {
		console.log("§8 mutants");
		// What every mutant must fail: the shipped lib passes all of it.
		const battery = (Lx) => {
			const misses = [];
			const want = (label, cond) => { if (!cond) misses.push(label); };
			const quiet = (r) => r.threw === null && r.keys === 1 && r.open === false;
			try {
				{
					const f = todayWorld();
					const twin = todayWorld();
					const r = startLib(Lx, f);
					runProbeStatements(twin);
					want("a passing probe: admits, nothing logged", quiet(r) && r.result.state === "admits" && r.lines.length === 0);
					want("a passing probe: the database as the probe's two statements leave it", same(snapshot(f), snapshot(twin)));
				}
				for (const [label, make, opts, code] of [
					["another CHECK", () => sevenWorld({ hashCheck: true }), {}, "SQLITE_CONSTRAINT_CHECK"],
					["a UNIQUE refusal on a CHECK that admits KPI Viewer", () => todayWorld({ kpiViewer: true, uniqueEmail: true }), {}, "SQLITE_CONSTRAINT_UNIQUE"],
					["a busy older table", () => legacyWorld(), { busy: true }, "SQLITE_BUSY"],
					["a trigger refusing the insert on an older table", () => legacyWorld({ after: [INSERT_TRIGGER] }), {}, "SQLITE_CONSTRAINT_TRIGGER"],
					["the probe's DELETE refused", () => todayWorld({ after: [DELETE_TRIGGER] }), {}, "SQLITE_CONSTRAINT_TRIGGER"],
					["an older table with another column", () => legacyWorld({ extraColumn: true }), {}, "NOT_CARRIED"],
				]) {
					const f = make();
					const b = snapshot(f);
					const holder = opts.busy ? holdWriteLock(f) : null;
					let r;
					try { r = startLib(Lx, f, { timeout: 50 }); } finally { if (holder) { holder.exec("ROLLBACK"); holder.close(); } }
					want(`${label}: skipped with ${code}`, quiet(r) && r.result.state === "skipped" && r.result.code === code);
					want(`${label}: no probe row, everything as before`, probeRows(f) === 0 && same(snapshot(f), b));
				}
				{
					const f = legacyWorld();
					const b = snapshot(f);
					const r = startLib(Lx, f);
					const a = snapshot(f);
					want("an older table: rebuilt", quiet(r) && r.result.state === "rebuilt");
					want("an older table: the rows as before, Admin renamed", same(a.tables.users, asRenamed(b)));
					want("an older table: the four roles", same(rolesIn(f), FOUR));
					want("an older table: the child tables as before", CHILDREN.every((t) => same(entry(a, t), entry(b, t)) && same(a.keys[t], b.keys[t]) && same(a.tables[t], b.tables[t])));
					want("an older table: no violation", a.fk.length === 0);
					want("an older table: the sequence kept", seqOf(a) === 9);
					want("an older table: the index and trigger re-created", same(masterBut(a, "users"), masterBut(b, "users")));
					want("an older table: sessions cleared", a.tables.sessions.length === 0);
				}
				for (const [label, make, hooks, step] of [
					["a failure at verify", () => legacyWorld(), failAt("verify"), "verify"],
					["a violation added before the foreign-key check", () => legacyWorld(), dropParentAt("fkcheck"), "fkcheck"],
					["a copied value changed before the drop", () => legacyWorld(), changeCopyAt("drop"), "verify"],
					["a row the four roles refuse", () => legacyWorld({ viewer: true }), undefined, "copy"],
				]) {
					const f = make();
					const b = snapshot(f);
					const r = startLib(Lx, f, { hooks });
					want(`${label}: rolled back at ${step}`, quiet(r) && r.result.state === "rolled back" && r.result.step === step);
					want(`${label}: everything as before`, same(snapshot(f), b));
				}
			} catch (err) {
				misses.push(`threw: ${err.message}`);
			}
			return misses;
		};
		eq("§8 (control) the shipped lib passes the battery", battery(L), []);
		const MUTANTS = [
			["M1 a rebuild on any probe failure", [["if (!roleRefused(db, err)) {", "if (false) {"]]],
			["M2 the role list not read", [["return Array.isArray(roles) && !roles.includes(PROBE_ROLE);", "return true;"]]],
			["M3 the CHECK code not read", [["if (!err || err.code !== \"SQLITE_CONSTRAINT_CHECK\") return false;", "if (!err) return false;"]]],
			["M4 no transaction around the rebuild", [["enter(\"begin\");\n\t\tdb.exec(\"BEGIN IMMEDIATE\");", "enter(\"begin\");"]]],
			["M5 foreign keys left on for the rebuild", [[
				"db.pragma(\"foreign_keys = OFF\");\n\t\tif (db.pragma(\"foreign_keys\", { simple: true }) !== 0) throw failure(\"USERS_FOREIGN_KEYS_ON\", \"foreign keys could not be turned off\");",
				"",
			]]],
			["M6 foreign keys not turned back on", [
				["if (keysWereOn && !db.inTransaction) db.pragma(\"foreign_keys = ON\");", ""],
				["if (keysWereOn && db.pragma(\"foreign_keys\", { simple: true }) !== 1) throw new Error(", "if (false) throw new Error("],
			]],
			["M7 the foreign-key check skipped", [["const added = violations(db).filter((v) => !plan.violations.has(v)).length;", "const added = 0;"]]],
			["M8 the probe's statements without a transaction", [
				["\ttry {\n\t\tdb.exec(\"BEGIN IMMEDIATE\");\n\t} catch (err) {\n\t\treturn err;\n\t}\n", ""],
				["at(\"probe commit\");\n\t\tdb.exec(\"COMMIT\");", "at(\"probe commit\");"],
			]],
			["M9 the probe rolled back on success", [["at(\"probe commit\");\n\t\tdb.exec(\"COMMIT\");", "at(\"probe commit\");\n\t\tdb.exec(\"ROLLBACK\");"]]],
			["M10 the rename-first order", [[
				"\t\tenter(\"create\");\n\t\tdb.exec(CREATE_NEW);\n\t\tenter(\"copy\");\n\t\tconst copied = db.prepare(COPY).run().changes;\n\t\tif (copied !== plan.rows) throw failure(\"USERS_COPY_COUNT\", `copied ${copied} rows, not ${plan.rows}`);\n\t\tenter(\"drop\");\n\t\tdb.exec(`DROP TABLE ${TABLE}`);\n\t\tenter(\"rename\");\n\t\tdb.exec(`ALTER TABLE ${NEW_TABLE} RENAME TO ${TABLE}`);\n",
				"\t\tenter(\"create\");\n\t\tdb.exec(\"ALTER TABLE users RENAME TO users_old\");\n\t\tdb.exec(CREATE_NEW.replace(NEW_TABLE, TABLE));\n\t\tenter(\"copy\");\n\t\tdb.prepare(COPY.replace(`INSERT INTO ${NEW_TABLE}`, `INSERT INTO ${TABLE}`).replace(`FROM ${TABLE}`, \"FROM users_old\")).run();\n\t\tenter(\"drop\");\n\t\tdb.exec(\"DROP TABLE users_old\");\n\t\tenter(\"rename\");\n",
			]]],
			["M11 the sequence not carried", [["\t\tcarrySequence(db, plan.sequence);\n", ""]]],
			["M12 the indexes and triggers not re-created", [["\t\tfor (const entry of plan.attached) db.exec(entry.sql);\n", ""]]],
			["M13 the verify step skipped", [["const differ = differences(db, plan);", "const differ = [];"]]],
			["M14 sessions kept", [["\t\t\tdb.exec(\"DELETE FROM sessions\");\n", ""]]],
			["M15 the copy without the Admin rename", [["const ROLE_COPY = \"CASE role WHEN 'Admin' THEN 'Super Admin' ELSE role END\";", "const ROLE_COPY = \"role\";"]]],
			["M16 any set of columns carried", [["if (!sameNames(names, COLUMNS)) return", "if (false) return"]]],
		];
		for (const [label, swaps] of MUTANTS) {
			let src = LIB_SRC;
			let anchored = true;
			for (const [from, to] of swaps) {
				const n = src.split(from).length - 1;
				if (n !== 1) { anchored = false; break; }
				src = src.replace(from, () => to);
			}
			ok(`§8 ${label}: its anchor is found exactly once`, anchored);
			if (!anchored) continue;
			let misses;
			try { misses = battery(compileLib(src)); } catch (err) { misses = [`did not load: ${err.message}`]; }
			ok(`§8 ${label}: caught`, misses.length > 0);
			if (misses.length) console.log(`  ok    ${label}: ${misses[0]}`);
		}
	} else {
		ok("§8 lib/users-table-migrate.js exists, for the mutants", false, LIB_FILE);
	}
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
