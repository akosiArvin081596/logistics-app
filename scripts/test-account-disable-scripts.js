#!/usr/bin/env node
/**
 * The scripts around account disable.
 *
 * WHAT IS ASSERTED:
 *   §1 scripts/enable-account.js, the recovery when no Super Admin is enabled:
 *      a dry run by default that writes nothing; --apply enables the one
 *      account and writes one system audit row; a replay refuses; it refuses a
 *      non-Super Admin, an account that is not disabled, and any run while a
 *      Super Admin is enabled; its output names ids, never usernames
 *   §2 scripts/session-account-check.js, the read-only check: every live
 *      (unexpired, signed-in) session the per-request check would sign out,
 *      counted by role and reason only; exit 1 when any would be, 0 when none,
 *      2 when it reads no live session (no evidence, never a pass); expired
 *      rows not counted; the file untouched
 *   §3 scripts/prepare-test-fixtures.js skips a disabled account
 *   §4 scripts/reset-super-admin-password.js says a reset does not enable a
 *      disabled account, and leaves it disabled
 *   §5 source pins for the scripts that need a replica, the Keychain or a
 *      deployed app to run: replica login, the e2e setup and payout parity
 *      (super_admin enabled on the copy only, other logins enabled only), the
 *      automation account, refresh-env.js's operator account
 *
 * Hermetic: made-up databases in a fresh temp directory; each script runs in a
 * child process.
 *   node scripts/test-account-disable-scripts.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const failures = [];
function ok(label, cond, detail) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-account-disable-scripts-"));
const STAMP = "2026-10-20T14:00:00.000Z";

function run(script, args, env = null) {
	const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
		encoding: "utf8", cwd: tmp, ...(env ? { env } : {}),
	});
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const source = (...parts) => { try { return fs.readFileSync(path.join(ROOT, ...parts), "utf8"); } catch { return ""; } };

function makeDb(name, { disableColumns = true } = {}) {
	const file = path.join(tmp, `${name}.db`);
	const db = new Database(file);
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL DEFAULT 'x',
			role TEXT NOT NULL, must_change_password INTEGER DEFAULT 0, last_login_at TEXT DEFAULT ''
			${disableColumns ? ", disabled_at TEXT DEFAULT NULL, disabled_by INTEGER DEFAULT NULL, disabled_reason TEXT DEFAULT NULL" : ""});
		CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL,
			username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '');
		CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire TEXT NOT NULL);
	`);
	return { file, db };
}
const fingerprint = (db) => JSON.stringify([db.prepare("SELECT * FROM users ORDER BY id").all(), db.prepare("SELECT * FROM audit_trail ORDER BY id").all()]);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

try {
	// ── §1 ──────────────────────────────────────────────────────────────────
	{
		const missing = run("enable-account.js", []);
		ok("§1 no --db: refused (exit 2)", missing.code === 2 && /--db/.test(missing.out), missing);
		const { file, db } = makeDb("recovery");
		const ins = db.prepare("INSERT INTO users (id, username, role, disabled_at, disabled_by) VALUES (?, ?, ?, ?, ?)");
		ins.run(1, "root_admin", "Super Admin", STAMP, 7);
		ins.run(7, "owner_named", "Super Admin", STAMP, 1);
		ins.run(20, "desk_one", "Dispatcher", STAMP, 1);
		ins.run(30, "dana_driver", "Driver", null, null);
		db.close();
		const look = () => { const d = new Database(file, { readonly: true }); try { return fingerprint(d); } finally { d.close(); } };
		const before = look();
		const noId = run("enable-account.js", [`--db=${file}`]);
		ok("§1 no --id: refused (exit 2)", noId.code === 2 && /--id/.test(noId.out), noId);
		const dry = run("enable-account.js", [`--db=${file}`, "--id=1"]);
		ok("§1 a dry run by default: exit 0, says what it would do, writes nothing",
			dry.code === 0 && /DRY RUN/.test(dry.out) && /#1/.test(dry.out) && look() === before, dry);
		const both = run("enable-account.js", [`--db=${file}`, "--id=1", "--apply", "--dry-run"]);
		ok("§1 --apply with --dry-run: refused", both.code === 2 && look() === before, both);
		const desk = run("enable-account.js", [`--db=${file}`, "--id=20", "--apply"]);
		ok("§1 a Dispatcher: refused, nothing written", desk.code === 2 && /not a Super Admin/.test(desk.out) && look() === before, desk);
		const none = run("enable-account.js", [`--db=${file}`, "--id=99", "--apply"]);
		ok("§1 an unknown account: refused, nothing written", none.code === 2 && look() === before, none);
		const enabledDriver = run("enable-account.js", [`--db=${file}`, "--id=30", "--apply"]);
		ok("§1 a Driver: refused", enabledDriver.code === 2 && look() === before, enabledDriver);
		const applied = run("enable-account.js", [`--db=${file}`, "--id=1", "--apply"]);
		const d = new Database(file, { readonly: true });
		const u1 = d.prepare("SELECT disabled_at, disabled_by, disabled_reason FROM users WHERE id = 1").get();
		const rows = d.prepare("SELECT * FROM audit_trail").all();
		const others = d.prepare("SELECT id, disabled_at FROM users WHERE id <> 1 ORDER BY id").all();
		d.close();
		ok("§1 --apply: exit 0, account #1 enabled (its three columns cleared)",
			applied.code === 0 && /OK/.test(applied.out) && u1.disabled_at === null && u1.disabled_by === null && u1.disabled_reason === null, [applied, u1]);
		ok("§1 ...and no other account touched", JSON.stringify(others) === JSON.stringify([{ id: 7, disabled_at: STAMP }, { id: 20, disabled_at: STAMP }, { id: 30, disabled_at: null }]), others);
		ok("§1 ...one audit row as a system change",
			rows.length === 1 && rows[0].user_id === 0 && rows[0].username === "system: enable-account" && rows[0].role === "system" &&
			rows[0].action === "enable_user" && rows[0].entity === "user" && rows[0].entity_id === "1", rows);
		const after = look();
		const replay = run("enable-account.js", [`--db=${file}`, "--id=1", "--apply"]);
		ok("§1 a replay refuses and writes nothing (it is idempotent)", replay.code === 2 && /not disabled/.test(replay.out) && look() === after, replay);
		const second = run("enable-account.js", [`--db=${file}`, "--id=7", "--apply"]);
		ok("§1 with a Super Admin enabled it refuses: the Users page enables the rest", second.code === 2 && /enabled/.test(second.out) && look() === after, second);
		const all = [missing, noId, dry, both, desk, none, enabledDriver, applied, replay, second].map((r) => r.out).join("\n");
		ok("§1 its output names ids, never usernames", !/root_admin|owner_named|desk_one|dana_driver/.test(all));
		const { file: old } = makeDb("older", { disableColumns: false });
		const oldRun = run("enable-account.js", [`--db=${old}`, "--id=1", "--apply"]);
		ok("§1 a database with no disabled_at column: refused", oldRun.code === 2, oldRun);
	}

	// ── §2 ──────────────────────────────────────────────────────────────────
	{
		const { file, db } = makeDb("sessions");
		const ins = db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (?, ?, ?, ?)");
		ins.run(7, "owner_named", "Super Admin", null);
		ins.run(8, "arvin_named", "Super Admin", STAMP);
		ins.run(20, "desk_one", "Dispatcher", null);
		const later = new Date(Date.now() + 86400000).toISOString();
		const sess = db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)");
		const user = (u) => JSON.stringify({ cookie: {}, user: u });
		sess.run("s1", user({ id: 7, username: "owner_named", role: "Super Admin" }), later);
		sess.run("s2", user({ id: 8, username: "arvin_named", role: "Super Admin" }), later);
		sess.run("s3", user({ id: 99, username: "ghost_user", role: "Dispatcher" }), later);
		sess.run("s4", user({ id: 20, username: "desk_one", role: "Super Admin" }), later);
		sess.run("s5", user({ username: "desk_one", role: "Dispatcher" }), later);
		sess.run("s6", JSON.stringify({ cookie: {} }), later);
		sess.run("s7", "{not json", later);
		// Expired rows are not counted, whatever they hold.
		const earlier = new Date(Date.now() - 86400000).toISOString();
		sess.run("s8", user({ id: 20, username: "desk_one", role: "Super Admin" }), earlier);
		sess.run("s9", user({ id: 7, username: "owner_named", role: "Super Admin" }), earlier);
		db.close();
		const hash = sha(file);
		const r = run("session-account-check.js", [`--db=${file}`]);
		ok("§2 some would be signed out: exit 1", r.code === 1, r);
		ok("§2 the counts, by role and reason, of live sessions only",
			/sessions read: 9 \(live: 5; not counted: 2 expired, 1 signed out, 1 unreadable\)/.test(r.out) &&
			/would stay signed in: 1 \(Super Admin 1\)/.test(r.out) &&
			/would be signed out: 4 \(Dispatcher: account not found 1, Dispatcher: no account id 1, Super Admin: disabled 1, Super Admin: role changed 1\)/.test(r.out), r.out);
		ok("§2 no usernames and no account ids in its output", !/owner_named|arvin_named|ghost_user|desk_one|#\d|\b99\b/.test(r.out), r.out);
		ok("§2 the database is opened read-only (the file is unchanged)", sha(file) === hash);
		const fine = makeDb("fine");
		fine.db.prepare("INSERT INTO users (id, username, role) VALUES (7, 'owner_named', 'Super Admin')").run();
		fine.db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES ('s1', ?, ?)").run(user({ id: 7, username: "owner_named", role: "Super Admin" }), later);
		fine.db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES ('s2', ?, ?)").run(user({ id: 99, username: "ghost_user", role: "Dispatcher" }), earlier);
		fine.db.close();
		const f = run("session-account-check.js", [`--db=${fine.file}`]);
		ok("§2 every live session survives (an expired one that would not is left out): exit 0",
			f.code === 0 && /would be signed out: 0 \(none\)/.test(f.out), f);
		// A copy made by replica:pull or a refresh holds no session: that is no evidence, never a pass.
		const empty = makeDb("empty");
		empty.db.prepare("INSERT INTO users (id, username, role) VALUES (7, 'owner_named', 'Super Admin')").run();
		empty.db.close();
		const e = run("session-account-check.js", [`--db=${empty.file}`]);
		ok("§2 no session at all: exit 2, \"no evidence: 0 live sessions\", and no verdict line",
			e.code === 2 && /no evidence: 0 live sessions/.test(e.out) && !/would (stay|be)/.test(e.out), e);
		const stale = makeDb("stale");
		stale.db.prepare("INSERT INTO users (id, username, role) VALUES (7, 'owner_named', 'Super Admin')").run();
		stale.db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES ('s1', ?, ?)").run(user({ id: 99, username: "ghost_user", role: "Dispatcher" }), earlier);
		stale.db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES ('s2', ?, ?)").run(JSON.stringify({ cookie: {} }), later);
		stale.db.close();
		const s = run("session-account-check.js", [`--db=${stale.file}`]);
		ok("§2 only expired or signed-out sessions: exit 2, no evidence (not 1 for the expired one)",
			s.code === 2 && /no evidence: 0 live sessions/.test(s.out) && /live: 0; not counted: 1 expired, 1 signed out, 0 unreadable/.test(s.out), s);
		const noDb = run("session-account-check.js", []);
		ok("§2 no --db: refused (exit 2)", noDb.code === 2, noDb);
	}

	// ── §3 ──────────────────────────────────────────────────────────────────
	{
		const { file, db } = makeDb("fixtures");
		const ins = db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (?, ?, ?, ?)");
		ins.run(1, "super_admin", "Super Admin", STAMP);
		ins.run(2, "second_admin", "Super Admin", null);
		db.close();
		const r = run("prepare-test-fixtures.js", ["--yes-local-db", file]);
		ok("§3 a disabled Super Admin is skipped, an enabled one is chosen",
			r.code === 0 && /1 disabled account\(s\) skipped/.test(r.out) && /TEST_ADMIN_USER='second_admin'/.test(r.out) && !/TEST_ADMIN_USER='super_admin'/.test(r.out), r.out);
	}

	// ── §4 ──────────────────────────────────────────────────────────────────
	{
		const { file, db } = makeDb("reset");
		db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (1, 'super_admin', 'Super Admin', ?)").run(STAMP);
		db.close();
		const r = run("reset-super-admin-password.js", [file], { NEW_PASSWORD: "Made-Up-Reset-Pass-123" });
		const d = new Database(file, { readonly: true });
		const u = d.prepare("SELECT disabled_at FROM users WHERE id = 1").get();
		d.close();
		ok("§4 a reset of a disabled account says it stays disabled, and it does",
			r.code === 0 && /NOTE: this account is disabled, and a password reset does not enable it/.test(r.out) && u.disabled_at === STAMP, r.out);
		ok("§4 ...and never prints the password", !/Made-Up-Reset-Pass-123/.test(r.out));
	}

	// ── §5 ──────────────────────────────────────────────────────────────────
	{
		const login = source("scripts", "replica", "login.mjs");
		const disabledAt = login.indexOf("is disabled in this copy");
		ok("§5 replica login: a disabled account is named before any password is set on it",
			disabledAt > 0 && disabledAt < login.indexOf("UPDATE users SET password_hash"));
		const setup = source("scripts", "e2e", "setup-db.cjs");
		ok("§5 e2e setup (copy mode): super_admin is enabled on the copy, the driver, investor and dispatcher logins are picked from enabled accounts",
			/disabled in the source -> enabled on the copy/.test(setup) && /COALESCE\(u\.disabled_at, ''\) = ''/.test(setup) &&
			/role = 'Investor'\$\{enabled\}/.test(setup) && /role = 'Dispatcher'\$\{enabled\}/.test(setup));
		const parity = source("scripts", "e2e", "payout-parity.mjs");
		ok("§5 payout parity: a disabled super_admin is enabled on its copies only", /enabled on the copies only/.test(parity) && /disabled_at = NULL/.test(parity));
		const auto = source("scripts", "ensure-automation-user.js");
		const autoAt = auto.indexOf("is disabled; nothing changed");
		ok("§5 ensure-automation-user.js: a disabled automation account stops it before anything is written, and it never enables one",
			autoAt > 0 && autoAt < auto.indexOf("INSERT INTO users") && !/disabled_at\s*=\s*NULL/.test(auto));
		const refresh = source("scripts", "refresh-env.js");
		const grant = refresh.indexOf("function grantOperatorAccess(db) {");
		const body = grant > 0 ? refresh.slice(grant, refresh.indexOf("\n}\n", grant)) : "";
		ok("§5 refresh-env.js: a disabled operator account is refused before its password is set",
			body.indexOf("is disabled in this database") > 0 && body.indexOf("is disabled in this database") < body.indexOf("UPDATE users SET password_hash"));
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
