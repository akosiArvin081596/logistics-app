#!/usr/bin/env node
/**
 * scripts/test-users-role-migration.js: the users-table rebuild that lets the role CHECK admit
 * "KPI Viewer" (lib/users-role-migration.js, scripts/migrate-users-kpi-viewer-role.js), and the start-up
 * check beside the users DDL in server.js.
 *
 * Each case starts from a scratch database at server.js's users schema (its CREATE and every ALTER,
 * lifted), in WAL mode as the app runs, with made-up accounts, made-up rows in the four child tables, a
 * deleted top account and two start-up probes (so the sequence, 11, sits above the highest id, 5),
 * made-up sessions and an audit table.
 *
 *   §1 the base: 15 columns, four child tables name users, and the CREATE refuses the role
 *   §2 the dry run (the script, in a child): exit 0, read-only, nothing written; the structure, the counts,
 *      the CREATE it would run, the fingerprint and the baseline; no row data in its output; the flag as
 *      on or off, never its value; without --db, the path scripts/lib/app-database.js resolves
 *   §3 refusals, each exit 2 with nothing written: --apply with the flag off, without or with a malformed
 *      --expect or --expect-fk, with a fingerprint or baseline that doesn't match, an unknown option,
 *      --apply with --dry-run, LOCAL_REPLICA without --db
 *   §4 --apply: exit 0; the row count, every column of every row and every id unchanged; the columns by
 *      PRAGMA table_info unchanged although the CREATE text changed; the sequence kept and the next
 *      account a new id; the four child tables' sqlite_master entries and rows unchanged;
 *      foreign_key_check empty and an INSERT into each child table works; the CHECK admits 'KPI Viewer'
 *      and refuses a typo; sessions untouched; one system audit row
 *   §5 a second run: "nothing to do", nothing written
 *   §6 a sign-in, a sign-out, the session sweep and a start-up probe between the dry run and the apply
 *      leave the fingerprint as it was; a structural change refuses the apply; an index is re-created
 *   §7 a foreign-key violation already there is listed and doesn't block; one the rebuild would add rolls
 *      it back at the foreign-key check
 *   §8 a forced failure at each step: exit 3, everything as it was
 *   §9 after-facts made to differ after the commit: exit 4, naming the WAL restore; distinct exits
 *   §10 the flag as the app reads it: the environment wins, else the settings file
 *   §11 the start-up check in server.js (lifted): off reads nothing; on reports an unmigrated table once,
 *      naming the script, and the role stays closed; on and migrated says yes
 *   §12 mutants of the lib, each caught by the battery the shipped lib passes
 *
 * Fails on origin/main (no migration, and its CHECK refuses the role): SERVER_ROOT=<a base checkout>
 * reads server.js, lib/ and the script from there.
 *
 * Hermetic: made-up data in a fresh temp folder; the script runs in children and in this process.
 *   node scripts/test-users-role-migration.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { spawnSync } = require("child_process");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const BASE = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : ROOT;
const LIB_FILE = path.join(BASE, "lib", "users-role-migration.js");
const SCRIPT_FILE = path.join(BASE, "scripts", "migrate-users-kpi-viewer-role.js");

let pass = 0;
const failures = [];
function ok(label, cond, detail) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (label, actual, expected) => ok(label, same(actual, expected), { actual, expected });

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}

// ── what server.js builds ─────────────────────────────────────────────────────────────────────────
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
// The probe row server.js inserts and deletes at every start (one id used per start).
const PROBE_INSERT = (/db\.prepare\("(INSERT INTO users \(username, password_hash, role\) VALUES \('__test_sa__'[^"]*)"\)/.exec(SRC) || [])[1];
const PROBE_DELETE = (/db\.prepare\("(DELETE FROM users WHERE username = '__test_sa__')"\)/.exec(SRC) || [])[1];
ok("(fixture) server.js has the start-up probe", !!PROBE_INSERT && !!PROBE_DELETE);
// better-sqlite3-session-store's table and its expiry sweep (src/index.js).
const SESSIONS_DDL = "CREATE TABLE IF NOT EXISTS sessions (sid TEXT NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TEXT NOT NULL)";
const SESSION_SWEEP = "DELETE FROM sessions WHERE datetime('now') > datetime(expire)";

// ── made-up worlds ────────────────────────────────────────────────────────────────────────────────
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-users-role-migration-")));
const STAMP = "2026-10-20T14:00:00.000Z";
const LATER = new Date(Date.now() + 86400000).toISOString();
const EARLIER = new Date(Date.now() - 86400000).toISOString();
const USERS = [
	{ id: 1, username: "owner_sample", password_hash: "made-up-hash-1", role: "Super Admin", email: "owner@example.test", full_name: "Olive Sample", last_login_at: STAMP },
	{ id: 2, username: "desk_sample", password_hash: "made-up-hash-2", role: "Dispatcher", email: "desk@example.test", must_change_password: 1, disabled_at: STAMP, disabled_by: 1, disabled_reason: "made-up reason" },
	{ id: 3, username: "dana_sample", password_hash: "made-up-hash-3", role: "Driver", driver_name: "Dana Sample", email: "dana.o'neil@example.test", rating: 4.5 },
	{ id: 4, username: "drew_sample", password_hash: "made-up-hash-4", role: "Driver", driver_name: "Drew Sample", full_name: "Drew Ünal Sample" },
	{ id: 5, username: "ivan_sample", password_hash: "made-up-hash-5", role: "Investor", company_name: "Sample Haulers LLC" },
];
const sessJson = (u, expire) => JSON.stringify({ cookie: { originalMaxAge: 86400000, expires: expire, httpOnly: true, path: "/" }, user: { id: u.id, username: u.username, role: u.role } });
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
function insert(db, table, row) {
	const keys = Object.keys(row);
	return db.prepare(`INSERT INTO ${q(table)} (${keys.map(q).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
}

let worlds = 0;
function makeWorld({ violation = false, extraIndex = false } = {}) {
	const dir = path.join(tmp, `w${++worlds}`);
	fs.mkdirSync(dir);
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.pragma("journal_mode = WAL");
	db.exec(USERS_DDL);
	for (const sql of USERS_ALTERS) db.exec(sql);
	// A stand-in parent for driver_onboarding.application_id.
	db.exec("CREATE TABLE job_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL DEFAULT '')");
	for (const sql of CHILD_DDL) db.exec(sql);
	db.exec(AUDIT_DDL);
	db.exec(SESSIONS_DDL);
	for (const u of USERS) insert(db, "users", { ...u, created_at: "2026-10-01 12:00:00" });
	// A deleted top account and two starts' probes: the sequence ends at 11, above the highest id.
	insert(db, "users", { id: 9, username: "gone_sample", password_hash: "made-up-hash-9", role: "Dispatcher" });
	db.prepare("DELETE FROM users WHERE id = ?").run(9);
	for (let i = 0; i < 2; i++) { db.prepare(PROBE_INSERT).run(); db.prepare(PROBE_DELETE).run(); }
	insert(db, "job_applications", { id: 1, full_name: "Dana Sample" });
	insert(db, "job_applications", { id: 2, full_name: "Drew Sample" });
	insert(db, "driver_onboarding", { user_id: 3, application_id: 1, driver_name: "Dana Sample", status: "documents_signed" });
	insert(db, "driver_onboarding", { user_id: 4, application_id: 2, driver_name: "Drew Sample" });
	insert(db, "onboarding_documents", { user_id: 3, doc_key: "w9", doc_name: "W-9", signed: 1 });
	insert(db, "onboarding_documents", { user_id: 3, doc_key: "lease", doc_name: "Lease" });
	insert(db, "onboarding_documents", { user_id: 4, doc_key: "w9", doc_name: "W-9" });
	insert(db, "driver_payment_info", { user_id: 3, payment_method: "ach", bank_name: "Sample Bank", bank_routing: "routing-sample", bank_account: "account-sample" });
	for (const [position, name] of [[1, "Casey Sample"], [2, "Jordan Sample"]]) {
		insert(db, "driver_emergency_contacts", { user_id: 3, position, contact_name: name, relationship: "Sibling", contact_phone: `555-010${position}`, created_at: STAMP, updated_at: STAMP });
	}
	insert(db, "sessions", { sid: "sid-made-up-0001", sess: sessJson(USERS[0], LATER), expire: LATER });
	insert(db, "sessions", { sid: "sid-made-up-0002", sess: sessJson(USERS[2], LATER), expire: LATER });
	insert(db, "sessions", { sid: "sid-made-up-0003", sess: sessJson(USERS[1], EARLIER), expire: EARLIER });
	insert(db, "audit_trail", { timestamp: STAMP, user_id: 1, username: "owner_sample", role: "Super Admin", action: "create_user", entity: "user", entity_id: "5", details: "made-up row" });
	if (violation) {
		// A child row that names the deleted account, as an older delete could leave.
		db.pragma("foreign_keys = OFF");
		insert(db, "onboarding_documents", { user_id: 9, doc_key: "w9", doc_name: "W-9" });
		db.pragma("foreign_keys = ON");
	}
	if (extraIndex) db.exec("CREATE INDEX idx_users_email_sample ON users(email)");
	db.close();
	return { dir, file };
}

// Every table's rows (each value with its storage class), sqlite_master, the users columns and the
// foreign-key check.
function snapshot(file) {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const master = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
		const tables = {};
		for (const t of master.filter((m) => m.type === "table")) {
			const cols = db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").pluck().all(t.name);
			tables[t.name] = db.prepare(`SELECT ${cols.map((c) => `quote(${q(c)})`).join(", ")} FROM ${q(t.name)} ORDER BY rowid`).raw().all();
		}
		return {
			master,
			tables,
			columns: db.prepare("SELECT * FROM pragma_table_info(?) ORDER BY cid").all("users"),
			fk: db.prepare("SELECT * FROM pragma_foreign_key_check()").all(),
		};
	} finally {
		db.close();
	}
}
const entry = (snap, name) => snap.master.find((m) => m.name === name) || null;
const masterBut = (snap, name) => snap.master.filter((m) => m.name !== name);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function seqIn(file) {
	const db = new Database(file, { readonly: true });
	try { return (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get("users") || {}).seq; } finally { db.close(); }
}
function attempt(file, sql, args) {
	const db = new Database(file);
	try { db.prepare(sql).run(...args); return "ok"; } catch (err) { return err.message; } finally { db.close(); }
}

// Between a dry run and its apply: a sign-in (a session and last_login_at), a sign-out, the session
// store's sweep and a start-up probe. Counts move; the structure doesn't.
function moveCounts(file) {
	const db = new Database(file);
	try {
		insert(db, "sessions", { sid: "sid-made-up-0004", sess: sessJson(USERS[4], LATER), expire: LATER });
		db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run("2026-10-30T15:00:00.000Z", 5);
		db.prepare("DELETE FROM sessions WHERE sid = ?").run("sid-made-up-0002");
		db.prepare(SESSION_SWEEP).run();
		db.prepare(PROBE_INSERT).run();
		db.prepare(PROBE_DELETE).run();
	} finally {
		db.close();
	}
}

// ── the script and the lib ────────────────────────────────────────────────────────────────────────
const ON = { KPI_VIEWER_ENABLED: "true" };
function runScript(args, env = {}) {
	const r = spawnSync(process.execPath, [SCRIPT_FILE, ...args], { cwd: tmp, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 60000 });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const fpOf = (out) => (/Structural fingerprint: ([0-9a-f]{16})/.exec(out) || [])[1];
const fkOf = (out) => (/Foreign-key baseline: (fk-\S+)/.exec(out) || [])[1];
const applyArgs = (file, fp, fk) => [`--db=${file}`, "--apply", `--expect=${fp}`, `--expect-fk=${fk}`];

// A copy of the lib compiled from source text, so a mutant runs under the same requires.
function compileLib(src) {
	const m = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", src)(m, m.exports, Module.createRequire(LIB_FILE), LIB_FILE, path.dirname(LIB_FILE));
	return m.exports;
}
const LIB_SRC = fs.existsSync(LIB_FILE) ? fs.readFileSync(LIB_FILE, "utf8") : null;
const L = LIB_SRC ? compileLib(LIB_SRC) : null;
const S = fs.existsSync(SCRIPT_FILE) ? require(SCRIPT_FILE) : null;

// The lib's dry run and apply in this process; `between(file)` runs after the dry run.
function libApply(Lx, file, { hooks, between, expect, expectFk } = {}) {
	const ro = new Database(file, { readonly: true, fileMustExist: true });
	let dry;
	try { dry = Lx.dryRunReport(ro, { Database }); } finally { ro.close(); }
	if (between) between(file);
	const db = new Database(file, { fileMustExist: true });
	try {
		return Lx.applyRebuild(db, { expect: expect || dry.fingerprint, expectFk: expectFk || dry.baseline, Database, hooks });
	} finally {
		db.close();
	}
}
const failAt = (name) => ({ beforeStep: (step) => { if (step === name) throw new Error(`made-up failure at ${step}`); } });
// Removes the parent of a driver_onboarding row just before the foreign-key check.
const dropParentAt = (name) => ({ beforeStep: (step, db) => { if (step === name) db.prepare("DELETE FROM job_applications WHERE id = ?").run(2); } });
const changeEmailAfterCommit = { afterCommit: (db) => db.prepare("UPDATE users SET email = ? WHERE id = ?").run("changed@example.test", 3) };
function capture() {
	const lines = [];
	return { lines, log: { log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) } };
}

try {
	// ── §1 ────────────────────────────────────────────────────────────────────────────────────────
	console.log("§1 the base");
	{
		const w = makeWorld();
		const db = new Database(w.file, { readonly: true });
		eq("(fixture) users at server.js's CREATE and its 8 ALTERs has 15 columns",
			[USERS_ALTERS.length, db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info(?)").get("users").n], [8, 15]);
		eq("(fixture) the four child tables hold a foreign key to users",
			db.prepare("SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND f.\"table\" = ? ORDER BY m.name").pluck().all("users"), CHILDREN);
		eq("(fixture) the sequence (11) sits above the highest id (5)", [db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get("users").seq, db.prepare("SELECT MAX(id) AS id FROM users").get().id], [11, 5]);
		db.close();
		const mem = new Database(":memory:");
		mem.exec(USERS_DDL);
		let refused = "";
		try { insert(mem, "users", { username: "kay_sample", password_hash: "made-up-hash-k", role: "KPI Viewer" }); } catch (err) { refused = err.message; }
		mem.close();
		ok("server.js's users CREATE refuses 'KPI Viewer': the role enters only through the migration", /CHECK constraint failed/.test(refused), refused);
	}
	ok("lib/users-role-migration.js exists", !!L, LIB_FILE);
	ok("scripts/migrate-users-kpi-viewer-role.js exists", !!S, SCRIPT_FILE);

	if (!L || !S) {
		const w = makeWorld();
		const r = fs.existsSync(SCRIPT_FILE) ? runScript(applyArgs(w.file, "0".repeat(16), "fk-none"), ON) : { code: null, out: "" };
		ok("§4 the migration runs (exit 0)", r.code === 0, r.out || "no script");
		ok("§4 ...and the users CHECK admits 'KPI Viewer'", attempt(w.file, "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ["kay_sample", "made-up-hash-k", "KPI Viewer"]) === "ok");
	} else {
		// ── §2 ────────────────────────────────────────────────────────────────────────────────────
		console.log("§2 the dry run");
		{
			const w = makeWorld();
			const before = snapshot(w.file);
			const bytes = sha(w.file);
			const r = runScript([`--db=${w.file}`], ON);
			eq("§2 the dry run exits 0", r.code, 0);
			ok("§2 ...opens the database read-only", r.out.includes(`Database: ${w.file} (a copy), opened read-only`), r.out);
			ok("§2 ...writes nothing: the file's bytes and every table read the same", sha(w.file) === bytes && same(snapshot(w.file), before));
			ok("§2 ...prints the live CREATE, the 15 columns from PRAGMA table_info and the role list",
				/users CREATE \(live\): CREATE TABLE users \(/.test(r.out) && /columns \(PRAGMA table_info\): 15/.test(r.out) && /14 disabled_reason TEXT DEFAULT NULL/.test(r.out)
				&& /role CHECK: 'Super Admin', 'Dispatcher', 'Driver', 'Investor'; admits KPI Viewer: no/.test(r.out), r.out);
			ok("§2 ...the four child tables' foreign keys to users", CHILDREN.every((t) => r.out.includes(`${t}(user_id) -> users(id)`)), r.out);
			ok("§2 ...the counts, kept out of the fingerprint", /rows 5; highest id 5; sqlite_sequence 11; sessions 3/.test(r.out) && /violations already there: none/.test(r.out), r.out);
			ok("§2 ...the CREATE it would run, with KPI Viewer in the list", /Would create/.test(r.out) && /CHECK \("role" IN \('Super Admin', 'Dispatcher', 'Driver', 'Investor', 'KPI Viewer'\)\)/.test(r.out), r.out);
			ok("§2 ...a structural fingerprint and the baseline fk-none", !!fpOf(r.out) && fkOf(r.out) === "fk-none", r.out);
			ok("§2 ...and the apply line naming both", r.out.includes(`--apply --expect=${fpOf(r.out)} --expect-fk=fk-none --db ${w.file}`), r.out);
			ok("§2 ...KPI_VIEWER_ENABLED: on", /KPI_VIEWER_ENABLED: on\n/.test(r.out), r.out);
			ok("§2 ...no row data in its output (usernames, emails, hashes, session ids, child values)",
				!/owner_sample|desk_sample|dana_sample|example\.test|made-up-hash|sid-made-up|Sample Bank|routing-sample|Casey Sample|made-up reason/.test(r.out), r.out);
			const odd = runScript([`--db=${w.file}`], { KPI_VIEWER_ENABLED: "yes-sample-value" });
			ok("§2 a flag value other than \"true\" reads off, and the value is never printed",
				odd.code === 0 && /KPI_VIEWER_ENABLED: off \(an --apply is refused while it is off\)/.test(odd.out) && !odd.out.includes("yes-sample-value"), odd.out);
			eq("§2 ...and the fingerprint doesn't depend on the flag", fpOf(odd.out), fpOf(r.out));
			const own = runScript([], { ...ON, DATABASE_PATH: w.file });
			ok("§2 without --db: the app's own database as scripts/lib/app-database.js resolves it (DATABASE_PATH here)",
				own.code === 0 && own.out.includes(`Database: ${w.file} (the app's own), opened read-only`) && fpOf(own.out) === fpOf(r.out), own.out);
			ok("§2 ...still nothing written", same(snapshot(w.file), before));
		}

		// ── §3 ────────────────────────────────────────────────────────────────────────────────────
		console.log("§3 refusals");
		{
			const w = makeWorld();
			const dry = runScript([`--db=${w.file}`], ON);
			const fp = fpOf(dry.out);
			const before = snapshot(w.file);
			const db = `--db=${w.file}`;
			const cases = [
				["--apply with KPI_VIEWER_ENABLED blank", applyArgs(w.file, fp, "fk-none"), { KPI_VIEWER_ENABLED: "" }, /KPI_VIEWER_ENABLED is off/],
				...["false", "TRUE", "1", "on"].map((v) => [`--apply with KPI_VIEWER_ENABLED=${v}`, applyArgs(w.file, fp, "fk-none"), { KPI_VIEWER_ENABLED: v }, /KPI_VIEWER_ENABLED is off/]),
				["--apply without --expect", [db, "--apply", "--expect-fk=fk-none"], ON, /--apply needs --expect=/],
				["--apply with a malformed --expect", [db, "--apply", "--expect=not-a-fingerprint", "--expect-fk=fk-none"], ON, /--apply needs --expect=/],
				["--apply without --expect-fk", [db, "--apply", `--expect=${fp}`], ON, /--apply needs --expect-fk=/],
				["--apply with a malformed --expect-fk", [db, "--apply", `--expect=${fp}`, "--expect-fk=fk-zz"], ON, /--apply needs --expect-fk=/],
				["--apply with a fingerprint that doesn't match", applyArgs(w.file, "0123456789abcdef", "fk-none"), ON, /structural fingerprint is [0-9a-f]{16}, not 0123456789abcdef/],
				["--apply with a baseline that doesn't match", applyArgs(w.file, fp, "fk-0123456789ab"), ON, /foreign-key baseline is fk-none, not fk-0123456789ab/],
				["--expect without --apply", [db, `--expect=${fp}`], ON, /go with --apply/],
				["--apply with --dry-run", [...applyArgs(w.file, fp, "fk-none"), "--dry-run"], ON, /--apply and --dry-run together/],
				["an unknown option", [db, "--force"], ON, /unknown option --force/],
				["LOCAL_REPLICA set and no --db", ["--apply", `--expect=${fp}`, "--expect-fk=fk-none"], { ...ON, LOCAL_REPLICA: "1", DATABASE_PATH: w.file }, /LOCAL_REPLICA/],
				["--apply with KPI_VIEWER_ENABLED=yes-sample-value", applyArgs(w.file, fp, "fk-none"), { KPI_VIEWER_ENABLED: "yes-sample-value" }, /KPI_VIEWER_ENABLED is off/],
			];
			for (const [label, args, env, why] of cases) {
				const r = runScript(args, env);
				ok(`§3 ${label}: exit 2, saying why, nothing written`, r.code === 2 && why.test(r.out) && /Nothing written/.test(r.out) && same(snapshot(w.file), before), r);
			}
			ok("§3 the flag's value is never printed", !runScript(applyArgs(w.file, fp, "fk-none"), { KPI_VIEWER_ENABLED: "yes-sample-value" }).out.includes("yes-sample-value"));
			// A table this script can't rebuild without dropping something: the dry run and the apply refuse.
			const FOUR = "CHECK(role IN ('Super Admin', 'Dispatcher', 'Driver', 'Investor'))";
			for (const [label, sqls, why] of [
				["a COLLATE clause", [`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL ${FOUR})`], /a COLLATE clause/],
				["a second CHECK", [`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL ${FOUR}, rating REAL CHECK(rating >= 0))`], /2 CHECK constraints/],
				["a users_new table left over", [USERS_DDL, "CREATE TABLE users_new (id INTEGER)"], /a table named users_new already exists/],
				["a view naming users", [USERS_DDL, "CREATE VIEW v_users_sample AS SELECT id FROM users"], /view\(s\) or trigger\(s\) on other tables name users/],
			]) {
				const dir = path.join(tmp, `w${++worlds}`);
				fs.mkdirSync(dir);
				const file = path.join(dir, "app.db");
				const odd = new Database(file);
				for (const sql of [...sqls, AUDIT_DDL, SESSIONS_DDL]) odd.exec(sql);
				odd.close();
				const oddBefore = snapshot(file);
				const d = runScript([`--db=${file}`], ON);
				const a = runScript(applyArgs(file, "0123456789abcdef", "fk-none"), ON);
				ok(`§3 a users table with ${label}: the dry run and the apply refuse (exit 2), saying why, nothing written`,
					d.code === 2 && a.code === 2 && why.test(d.out) && why.test(a.out) && /can't rebuild/.test(d.out) && same(snapshot(file), oddBefore), { d: d.out, a: a.out });
			}
		}

		// ── §4 and §5 ─────────────────────────────────────────────────────────────────────────────
		console.log("§4 --apply");
		{
			const w = makeWorld();
			const before = snapshot(w.file);
			const dry = runScript([`--db=${w.file}`], ON);
			const r = runScript(applyArgs(w.file, fpOf(dry.out), fkOf(dry.out)), ON);
			eq("§4 --apply exits 0", r.code, 0);
			ok("§4 ...and says APPLIED, naming rows, highest id and sequence", /APPLIED: users rebuilt so its role CHECK admits "KPI Viewer": rows 5 → 5; highest id 5 → 5; sequence 11 → 11; sessions 3; one audit row\./.test(r.out), r.out);
			const after = snapshot(w.file);
			eq("§4 the row count, every column of every row (each value's storage class too) and every id are unchanged", after.tables.users, before.tables.users);
			eq("§4 the columns by PRAGMA table_info are unchanged", after.columns, before.columns);
			ok("§4 ...while the stored CREATE text changed, and the run still took exit 0, not 4",
				entry(after, "users").sql !== entry(before, "users").sql && r.code === 0, entry(after, "users").sql);
			eq("§4 the sequence keeps its old value (11), above the highest id", seqIn(w.file), 11);
			for (const t of CHILDREN) {
				eq(`§4 ${t}: its sqlite_master entry is unchanged`, entry(after, t), entry(before, t));
				ok(`§4 ...still REFERENCES users(id) (${t})`, /REFERENCES users\(id\)/.test((entry(after, t) || {}).sql || ""));
				eq(`§4 ...and its rows are unchanged (${t})`, after.tables[t], before.tables[t]);
			}
			eq("§4 foreign_key_check is empty", after.fk, []);
			eq("§4 sessions are untouched: every sid, sess and expire, and the count", after.tables.sessions, before.tables.sessions);
			const others = (snap) => Object.keys(snap.tables).filter((t) => !["users", "audit_trail", "sqlite_sequence", ...CHILDREN].includes(t)).map((t) => [t, snap.tables[t]]);
			eq("§4 every other table is unchanged", others(after), others(before));
			// sqlite_sequence by table: the rebuild re-adds the users row, so its place in the table moves.
			const seqs = (snap, bump = {}) => Object.fromEntries(snap.tables.sqlite_sequence.map(([name, seq]) => [name, bump[name] ? String(Number(seq) + bump[name]) : seq]).sort());
			eq("§4 sqlite_sequence: users at 11 (an integer) as before, audit_trail one up, the rest as before",
				seqs(after), seqs(before, { "'audit_trail'": 1 }));
			eq("§4 sqlite_master: only the users CREATE changed (its auto-index is back under its name; no users_new)", masterBut(after, "users"), masterBut(before, "users"));
			eq("§4 audit_trail: the earlier row unchanged and one row added", after.tables.audit_trail.slice(0, -1), before.tables.audit_trail);
			const audit = new Database(w.file, { readonly: true });
			const row = audit.prepare("SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail ORDER BY id DESC LIMIT 1").get();
			audit.close();
			eq("§4 ...a system change: user 0, the script's name, role system, the users table",
				[row.user_id, row.username, row.role, row.action, row.entity, row.entity_id], [0, "system: users role migration", "system", "migrate_users_role_check", "users", ""]);
			eq("§4 ...naming the rows, the highest id and the sequence before and after", row.details,
				'users rebuilt so its role CHECK admits "KPI Viewer": rows 5 → 5; highest id 5 → 5; sequence 11 → 11');

			console.log("§5 a second run");
			const again = runScript(applyArgs(w.file, fpOf(dry.out), fkOf(dry.out)), ON);
			ok("§5 the same --apply again says nothing to do (exit 0)", again.code === 0 && /NOTHING TO DO/.test(again.out), again.out);
			const dry2 = runScript([`--db=${w.file}`], ON);
			ok("§5 ...a dry run says nothing to do too (exit 0), the CHECK listing KPI Viewer",
				dry2.code === 0 && /NOTHING TO DO/.test(dry2.out) && /'Investor', 'KPI Viewer'; admits KPI Viewer: yes/.test(dry2.out), dry2.out);
			eq("§5 ...and neither wrote anything", snapshot(w.file), after);

			// Writes on the rebuilt table (after the snapshots above).
			const next = new Database(w.file);
			const id = Number(insert(next, "users", { username: "next_sample", password_hash: "made-up-hash-n", role: "Dispatcher" }).lastInsertRowid);
			next.close();
			eq("§4 the next account gets id 12, after the old sequence, never a deleted account's (6-11)", id, 12);
			let n = 0;
			const role = (r2) => attempt(w.file, "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", [`role_sample_${++n}`, "made-up-hash-r", r2]);
			eq("§4 the CHECK admits 'KPI Viewer'", role("KPI Viewer"), "ok");
			for (const typo of ["KPI viewer", "KPI Viewers", "KPI_Viewer", " KPI Viewer", "Viewer"]) ok(`§4 ...and refuses ${JSON.stringify(typo)}`, /CHECK constraint failed/.test(role(typo)));
			eq("§4 ...and still admits the four roles", ["Super Admin", "Dispatcher", "Driver", "Investor"].map(role), ["ok", "ok", "ok", "ok"]);
			ok("§4 username is still UNIQUE", /UNIQUE constraint failed/.test(attempt(w.file, "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ["owner_sample", "made-up-hash-x", "Driver"])));
			const childInserts = [
				["driver_onboarding", { user_id: 5, application_id: 1, driver_name: "Ivan Sample" }],
				["onboarding_documents", { user_id: 4, doc_key: "lease", doc_name: "Lease" }],
				["driver_payment_info", { user_id: 4, payment_method: "check" }],
				["driver_emergency_contacts", { user_id: 4, position: 1, contact_name: "Morgan Sample", relationship: "Parent", contact_phone: "555-0102", created_at: STAMP, updated_at: STAMP }],
			];
			for (const [t, row2] of childInserts) {
				const keys = Object.keys(row2);
				eq(`§4 an INSERT into ${t} works, foreign keys on`, attempt(w.file, `INSERT INTO ${t} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, keys.map((k) => row2[k])), "ok");
			}
			ok("§4 ...and one naming a missing account is refused", /FOREIGN KEY constraint failed/.test(attempt(w.file, "INSERT INTO onboarding_documents (user_id, doc_key, doc_name) VALUES (?, ?, ?)", [77, "w9", "W-9"])));
			eq("§4 ...foreign_key_check still empty", snapshot(w.file).fk, []);
		}

		// ── §6 ────────────────────────────────────────────────────────────────────────────────────
		console.log("§6 counts move, structure doesn't");
		{
			const w = makeWorld();
			const d1 = runScript([`--db=${w.file}`], ON);
			moveCounts(w.file);
			const d2 = runScript([`--db=${w.file}`], ON);
			ok("§6 a sign-in, a sign-out, the session sweep and a start-up probe moved the counts",
				/sqlite_sequence 11; sessions 3/.test(d1.out) && /sqlite_sequence 12; sessions 2/.test(d2.out), d2.out);
			eq("§6 ...and left the structural fingerprint as it was", fpOf(d2.out), fpOf(d1.out));
			const r = runScript(applyArgs(w.file, fpOf(d1.out), fkOf(d1.out)), ON);
			eq("§6 ...so the apply with the first dry run's values runs (exit 0)", r.code, 0);
			for (const [label, sql] of [
				["an index added on users", "CREATE INDEX idx_users_name_sample ON users(full_name)"],
				["a column added to users", "ALTER TABLE users ADD COLUMN note_sample TEXT DEFAULT ''"],
				["a child table re-created without its foreign key", "DROP TABLE driver_payment_info; CREATE TABLE driver_payment_info (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE)"],
			]) {
				const w2 = makeWorld();
				const d = runScript([`--db=${w2.file}`], ON);
				const db = new Database(w2.file);
				db.exec(sql);
				db.close();
				const before = snapshot(w2.file);
				const a = runScript(applyArgs(w2.file, fpOf(d.out), fkOf(d.out)), ON);
				ok(`§6 ${label} after the dry run: the apply is refused (exit 2), naming the fingerprint, nothing written`,
					a.code === 2 && /structural fingerprint is/.test(a.out) && same(snapshot(w2.file), before), a.out);
			}
			const w3 = makeWorld({ extraIndex: true });
			const before3 = snapshot(w3.file);
			const d3 = runScript([`--db=${w3.file}`], ON);
			const a3 = runScript(applyArgs(w3.file, fpOf(d3.out), fkOf(d3.out)), ON);
			ok("§6 an index on users is re-created after the rename: exit 0 and its sqlite_master entry as before",
				a3.code === 0 && same(entry(snapshot(w3.file), "idx_users_email_sample"), entry(before3, "idx_users_email_sample")) && !!entry(before3, "idx_users_email_sample"), a3.out);
		}

		// ── §7 ────────────────────────────────────────────────────────────────────────────────────
		console.log("§7 foreign-key violations");
		{
			const w = makeWorld({ violation: true });
			const before = snapshot(w.file);
			const d = runScript([`--db=${w.file}`], ON);
			ok("§7 a violation already there is listed by table and count", /violations already there: onboarding_documents 1\n/.test(d.out), d.out);
			ok("§7 ...and the baseline names it", /^fk-[0-9a-f]{12}$/.test(fkOf(d.out) || ""), d.out);
			const refused = runScript(applyArgs(w.file, fpOf(d.out), "fk-none"), ON);
			ok("§7 ...an apply expecting none is refused (exit 2), nothing written", refused.code === 2 && /foreign-key baseline is fk-/.test(refused.out) && same(snapshot(w.file), before), refused.out);
			const a = runScript(applyArgs(w.file, fpOf(d.out), fkOf(d.out)), ON);
			eq("§7 ...with the baseline, it doesn't block the apply (exit 0)", a.code, 0);
			eq("§7 ...and it is still the one violation", snapshot(w.file).fk, before.fk);
			const w2 = makeWorld();
			const before2 = snapshot(w2.file);
			const r = libApply(L, w2.file, { hooks: dropParentAt("fkcheck") });
			eq("§7 a violation the rebuild would add rolls it back at the foreign-key check (exit 3)", [r.exit, r.state, r.step], [3, "rolled back", "fkcheck"]);
			ok("§7 ...and everything reads as before", same(snapshot(w2.file), before2));
		}

		// ── §8 ────────────────────────────────────────────────────────────────────────────────────
		console.log("§8 a forced failure at each step");
		{
			eq("§8 the steps", L.STEPS, ["read", "create", "copy", "drop", "rename", "recreate", "sequence", "fkcheck", "verify", "audit", "commit"]);
			for (const name of L.STEPS) {
				const w = makeWorld({ extraIndex: true });
				const before = snapshot(w.file);
				const r = libApply(L, w.file, { hooks: failAt(name) });
				eq(`§8 a failure at "${name}": exit 3, rolled back at that step`, [r.exit, r.state, r.step], [3, "rolled back", name]);
				ok(`§8 ...the table, its rows, the sequence, the sessions and every other table as they were (${name})`, same(snapshot(w.file), before));
			}
			const w = makeWorld();
			const before = snapshot(w.file);
			const c = capture();
			const dry = capture();
			S.main([`--db=${w.file}`], { env: ON, log: dry.log });
			const out = dry.lines.join("\n");
			const code = S.main(applyArgs(w.file, fpOf(out), fkOf(out)), { env: ON, log: c.log, hooks: failAt("drop") });
			ok("§8 through the script: exit 3 and ROLLED BACK, nothing written", code === 3 && c.lines.some((l) => /^ROLLED BACK: at step drop/.test(l)) && same(snapshot(w.file), before), c.lines);
		}

		// ── §9 ────────────────────────────────────────────────────────────────────────────────────
		console.log("§9 committed but differs");
		{
			const w = makeWorld();
			const r = libApply(L, w.file, { hooks: changeEmailAfterCommit });
			eq("§9 a value changed after the commit: exit 4, committed but differs", [r.exit, r.state], [4, "committed but differs"]);
			ok("§9 ...named by the full-row fingerprint", r.reasons.some((x) => /full-row fingerprint/.test(x)), r.reasons);
			const w2 = makeWorld();
			const r2 = libApply(L, w2.file, { hooks: { afterCommit: (db) => db.prepare("DELETE FROM sessions WHERE sid = ?").run("sid-made-up-0001") } });
			ok("§9 a session lost after the commit: exit 4, naming the sessions", r2.exit === 4 && r2.reasons.some((x) => /^sessions 3 became 2$/.test(x)), r2.reasons);
			const w3 = makeWorld();
			const dry = capture();
			S.main([`--db=${w3.file}`], { env: ON, log: dry.log });
			const out = dry.lines.join("\n");
			const c = capture();
			const code = S.main(applyArgs(w3.file, fpOf(out), fkOf(out)), { env: ON, log: c.log, hooks: changeEmailAfterCommit });
			const text = c.lines.join("\n");
			ok("§9 through the script: exit 4, and the WAL-safe restore named with this file",
				code === 4 && /COMMITTED BUT DIFFERS/.test(text) && text.includes(`move ${w3.file}-wal and ${w3.file}-shm aside`) && /unzip and verify the backup/.test(text), text);
			const w4 = makeWorld();
			const applied = libApply(L, w4.file);
			const refusedR = libApply(L, makeWorld().file, { expect: "0123456789abcdef" });
			const rolled = libApply(L, makeWorld().file, { hooks: failAt("rename") });
			eq("§9 the exits are distinct: applied 0, refused 2, rolled back 3, committed but differs 4",
				[applied.exit, refusedR.exit, rolled.exit, r.exit], [0, 2, 3, 4]);
			ok("§9 the script's usage says any other exit is handled like 4", /any other: treat like 4/.test(S.USAGE));
		}

		// ── §10 ───────────────────────────────────────────────────────────────────────────────────
		console.log("§10 the flag as the app reads it");
		{
			const run = (env, settings) => {
				const w = makeWorld();
				const dry = capture();
				S.main([`--db=${w.file}`], { env: ON, log: dry.log });
				const out = dry.lines.join("\n");
				let read = 0;
				const c = capture();
				const code = S.main(applyArgs(w.file, fpOf(out), fkOf(out)), { env, log: c.log, readSettings: () => { read++; return settings; } });
				return { code, read, text: c.lines.join("\n") };
			};
			const fromFile = run({}, { KPI_VIEWER_ENABLED: "true" });
			ok("§10 not in the environment: the app directory's settings decide (\"true\" applies)", fromFile.code === 0 && fromFile.read === 1, fromFile);
			const noneInFile = run({}, {});
			ok("§10 ...unset there too: refused (exit 2)", noneInFile.code === 2 && /KPI_VIEWER_ENABLED is off/.test(noneInFile.text), noneInFile);
			const odd = run({}, { KPI_VIEWER_ENABLED: "yes-sample-value" });
			ok("§10 ...another value there: refused, the value never printed", odd.code === 2 && !odd.text.includes("yes-sample-value"), odd);
			const envWins = run({ KPI_VIEWER_ENABLED: "false" }, { KPI_VIEWER_ENABLED: "true" });
			ok("§10 in the environment it wins, as dotenv leaves it: \"false\" refuses whatever the file says, unread", envWins.code === 2 && envWins.read === 0, envWins);
			const envOn = run({ KPI_VIEWER_ENABLED: "true" }, {});
			ok("§10 ...and \"true\" there applies, the file unread", envOn.code === 0 && envOn.read === 0, envOn);
		}
	}

	// ── §11 ───────────────────────────────────────────────────────────────────────────────────────
	console.log("§11 the start-up check in server.js");
	{
		const HEAD = 'const usersRoleMigration = require("./lib/users-role-migration");';
		const at = SRC.indexOf(HEAD);
		const readyAt = at > -1 ? SRC.indexOf("const KPI_VIEWER_SCHEMA_READY = ", at) : -1;
		ok("§11 server.js wires the start-up check", at > -1 && readyAt > -1);
		ok("§11 ...beside the users DDL: below the users CREATE and its first ALTERs, above the next table",
			at > SRC.indexOf("ALTER TABLE users ADD COLUMN company_name") && at < SRC.indexOf("CREATE TABLE IF NOT EXISTS expenses ("));
		const routeHead = 'app.post("/api/users", requireRole("Super Admin")';
		const addUser = SRC.slice(SRC.indexOf(routeHead), SRC.indexOf("\n});", SRC.indexOf(routeHead)));
		ok("§11 Add User still takes only the four roles, and no route lists KPI Viewer or serves /api/kpis/viewer",
			addUser.includes('if (!["Super Admin", "Dispatcher", "Driver", "Investor"].includes(role)) {') && !/requireRole\([^)]*"KPI Viewer"/.test(SRC) && !SRC.includes("/api/kpis/viewer"));
		if (at > -1 && readyAt > -1 && L) {
			const text = SRC.slice(at, SRC.indexOf("\n", readyAt));
			const boot = (env, db) => {
				const lines = [];
				const con = { log: (...a) => lines.push(["log", a.join(" ")]), error: (...a) => lines.push(["error", a.join(" ")]), warn: (...a) => lines.push(["warn", a.join(" ")]) };
				const out = new Function("require", "db", "process", "console", `${text}\nreturn { KPI_VIEWER_ENABLED, KPI_VIEWER_SCHEMA_READY };`)(
					Module.createRequire(path.join(BASE, "server.js")), db, { env }, con);
				return { ...out, lines };
			};
			const touched = [];
			const untouchable = new Proxy({}, { get: (_, k) => { touched.push(String(k)); return () => { throw new Error("the database was read"); }; } });
			const off = boot({}, untouchable);
			eq("§11 flag off: not ready, nothing read, one off line", [off.KPI_VIEWER_ENABLED, off.KPI_VIEWER_SCHEMA_READY, touched, off.lines],
				[false, false, [], [["log", "[kpi-viewer] off (KPI_VIEWER_ENABLED)"]]]);
			for (const v of ["TRUE", "1", "yes", " true"]) {
				const b = boot({ KPI_VIEWER_ENABLED: v }, untouchable);
				eq(`§11 KPI_VIEWER_ENABLED=${JSON.stringify(v)} is off`, [b.KPI_VIEWER_ENABLED, b.KPI_VIEWER_SCHEMA_READY, touched.length], [false, false, 0]);
			}
			const w = makeWorld();
			const db = new Database(w.file, { readonly: true });
			const un = boot(ON, db);
			db.close();
			ok("§11 flag on, table not migrated: not ready, and exactly one error, naming the script",
				un.KPI_VIEWER_ENABLED === true && un.KPI_VIEWER_SCHEMA_READY === false && un.lines.length === 1 && un.lines[0][0] === "error"
				&& un.lines[0][1].includes("users CHECK admits KPI Viewer: no") && un.lines[0][1].includes("scripts/migrate-users-kpi-viewer-role.js"), un.lines);
			ok("§11 ...and the role stays closed: the table refuses a KPI Viewer row",
				/CHECK constraint failed/.test(attempt(w.file, "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ["kay_sample", "made-up-hash-k", "KPI Viewer"])));
			if (S) {
				const w2 = makeWorld();
				const d = runScript([`--db=${w2.file}`], ON);
				runScript(applyArgs(w2.file, fpOf(d.out), fkOf(d.out)), ON);
				const db2 = new Database(w2.file, { readonly: true });
				const mig = boot(ON, db2);
				db2.close();
				eq("§11 flag on, table migrated: ready, one yes line, no error", [mig.KPI_VIEWER_SCHEMA_READY, mig.lines], [true, [["log", "[kpi-viewer] on; users CHECK admits KPI Viewer: yes"]]]);
			}
		}
	}

	// ── §12 ───────────────────────────────────────────────────────────────────────────────────────
	if (L) {
		console.log("§12 mutants");
		// What every mutant must fail: the shipped lib passes all of it.
		const battery = (Lx) => {
			const misses = [];
			const want = (label, cond) => { if (!cond) misses.push(label); };
			try {
				const w = makeWorld();
				const before = snapshot(w.file);
				const r = libApply(Lx, w.file);
				const after = snapshot(w.file);
				want("a correct run exits 0", r.exit === 0);
				want("the rows are as before", same(after.tables.users, before.tables.users));
				want("the columns are as before", same(after.columns, before.columns));
				want("the sequence is kept", seqIn(w.file) === 11);
				want("the child tables are as before", CHILDREN.every((t) => same(entry(after, t), entry(before, t)) && same(after.tables[t], before.tables[t])));
				want("the sessions are as before", same(after.tables.sessions, before.tables.sessions));
				want("no violation", after.fk.length === 0);
				want("counts moving between the dry run and the apply don't refuse it", libApply(Lx, makeWorld().file, { between: moveCounts }).exit === 0);
				want("a violation already there doesn't block", libApply(Lx, makeWorld({ violation: true }).file).exit === 0);
				const added = libApply(Lx, makeWorld().file, { hooks: dropParentAt("fkcheck") });
				want("an added violation rolls back at the foreign-key check", added.exit === 3 && added.step === "fkcheck");
				want("a failure inside exits 3", libApply(Lx, makeWorld().file, { hooks: failAt("drop") }).exit === 3);
				want("a commit made to differ exits 4", libApply(Lx, makeWorld().file, { hooks: changeEmailAfterCommit }).exit === 4);
			} catch (err) {
				misses.push(`threw: ${err.message}`);
			}
			return misses;
		};
		eq("§12 (control) the shipped lib passes the battery", battery(L), []);
		const ORIGINAL_SEVEN = JSON.stringify([
			{ cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
			{ cid: 1, name: "username", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 2, name: "password_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 3, name: "role", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 4, name: "driver_name", type: "TEXT", notnull: 0, dflt_value: "''", pk: 0 },
			{ cid: 5, name: "email", type: "TEXT", notnull: 0, dflt_value: "''", pk: 0 },
			{ cid: 6, name: "created_at", type: "DATETIME", notnull: 0, dflt_value: "CURRENT_TIMESTAMP", pk: 0 },
		]);
		const MUTANTS = [
			["M1 the old rename-first order", [[
				"\t\tat(\"create\");\n\t\tdb.exec(plan.createNewSql);\n\t\tif (!same(columnsOf(db, NEW_TABLE), pre.structure.columns) || !same(constraintIndexes(db, NEW_TABLE), constraintIndexes(db, TABLE))) {\n\t\t\tthrow new Error(`${NEW_TABLE} doesn't have the columns and UNIQUE indexes of users`);\n\t\t}\n\t\tat(\"copy\");\n\t\tconst copied = db.prepare(plan.copySql).run().changes;\n\t\tif (copied !== pre.counts.rows) throw new Error(`copied ${copied} rows, not ${pre.counts.rows}`);\n\t\tat(\"drop\");\n\t\tdb.exec(`DROP TABLE ${ident(TABLE)}`);\n\t\tat(\"rename\");\n\t\tdb.exec(`ALTER TABLE ${ident(NEW_TABLE)} RENAME TO ${ident(TABLE)}`);\n",
				"\t\tat(\"create\");\n\t\tdb.exec('ALTER TABLE \"users\" RENAME TO \"users_old\"');\n\t\tdb.exec(plan.createNewSql.replace('CREATE TABLE \"users_new\"', 'CREATE TABLE \"users\"'));\n\t\tat(\"copy\");\n\t\tdb.prepare(plan.copySql.replace('INSERT INTO \"users_new\"', 'INSERT INTO \"users\"').replace('FROM \"users\"', 'FROM \"users_old\"')).run();\n\t\tat(\"drop\");\n\t\tdb.exec('DROP TABLE \"users_old\"');\n\t\tat(\"rename\");\n",
			]]],
			["M2 foreign keys turned off inside the transaction", [
				["\t\tforeignKeysOff(db);\n", ""],
				["\t\tdb.exec(\"BEGIN IMMEDIATE\");\n", "\t\tdb.exec(\"BEGIN IMMEDIATE\");\n\t\tdb.pragma(\"foreign_keys = OFF\");\n"],
			]],
			["M3 a hard-coded column list", [["const live = structure.columns;", `const live = ${ORIGINAL_SEVEN};`]]],
			["M4 the sequence not carried", [["\t\tcarrySequence(db, pre.counts.sequence);\n", ""]]],
			["M5 the foreign-key check skipped", [["const added = addedViolations(db, pre.violations);", "const added = [];"]]],
			["M6 sessions cleared, as the old rebuild did", [["\t\tat(\"recreate\");\n", "\t\tdb.exec(\"DELETE FROM sessions\");\n\t\tat(\"recreate\");\n"]]],
			["M7 the after-check comparing the CREATE text", [[
				"if (!same(post.structure.columns, pre.structure.columns)) out.push(\"the columns (PRAGMA table_info) differ\");",
				"if (post.structure.ddl !== pre.structure.ddl) out.push(\"the CREATE text differs\");",
			]]],
			["M8 the foreign-key check failing on violations already there", [["return foreignKeyViolations(db).filter((v) => !known.has(violationKey(v)));", "return foreignKeyViolations(db);"]]],
			["M9 counts inside the fingerprint", [[
				"attached: ddl ? attachedTo(db, TABLE) : [],",
				"attached: ddl ? attachedTo(db, TABLE) : [], sessions: hasTable(db, \"sessions\") ? db.prepare(\"SELECT COUNT(*) AS n FROM sessions\").get().n : null, sequence: (db.prepare(\"SELECT seq FROM sqlite_sequence WHERE name = 'users'\").get() || {}).seq,",
			]]],
			["M10 one exit code for rolled back and committed but differs", [["ROLLED_BACK: 3, DIFFERS: 4 }", "ROLLED_BACK: 3, DIFFERS: 3 }"]]],
			["M11 the sequence carried as a REAL", [["SET seq = MAX(CAST(? AS INTEGER), seq)", "SET seq = MAX(?, seq)"]]],
		];
		for (const [label, swaps] of MUTANTS) {
			let src = LIB_SRC;
			let anchored = true;
			for (const [from, to] of swaps) {
				const n = src.split(from).length - 1;
				if (n !== 1) { anchored = false; break; }
				src = src.replace(from, () => to);
			}
			ok(`§12 ${label}: its anchor is found exactly once`, anchored);
			if (!anchored) continue;
			let misses;
			try { misses = battery(compileLib(src)); } catch (err) { misses = [`did not load: ${err.message}`]; }
			ok(`§12 ${label}: caught`, misses.length > 0);
			if (misses.length) console.log(`  ok    ${label}: ${misses[0]}`);
		}
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
