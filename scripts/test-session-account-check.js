#!/usr/bin/env node
/**
 * scripts/session-account-check.js, the read-only count of live sessions the
 * per-request account check would sign out.
 *
 * WHAT IS ASSERTED:
 *   §1 no live session (none at all, or only expired and signed-out ones):
 *      exit 2 and "no evidence", never a pass; no --db is refused (exit 2)
 *   §2 every live session survives: exit 0, counted by role; an expired
 *      session that would be signed out is not counted
 *   §3 some would be signed out (a non-numeric account id, a missing account
 *      row, a changed role, a disabled account): exit 1, each counted by role
 *      and reason
 *   §4 a users table with no disabled_at column (the schema before account
 *      disable ships) is read too
 *   §5 its output holds no session id, cookie value, username or account id
 *   §6 the database is opened read-only: the file's bytes and mtime are
 *      unchanged, also while a writer holds it open in WAL mode
 *
 * Hermetic: made-up databases in a fresh temp directory; the script runs in a
 * child process.
 *   node scripts/test-session-account-check.js    # exits 1 on failure
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
function eq(label, actual, expected) {
	ok(label, actual === expected, { actual, expected });
}

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-session-account-check-"));
const STAMP = "2026-10-20T14:00:00.000Z";
const LATER = new Date(Date.now() + 86400000).toISOString();
const EARLIER = new Date(Date.now() - 86400000).toISOString();

function check(args) {
	const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "session-account-check.js"), ...args], {
		encoding: "utf8", cwd: tmp,
	});
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

// The users table as server.js creates it, with the CHECK scripts/migrate-users-kpi-viewer-role.js widens,
// and the sessions table as better-sqlite3-session-store does.
function makeDb(name, { disableColumn = true } = {}) {
	const file = path.join(tmp, `${name}.db`);
	const db = new Database(file);
	db.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL DEFAULT 'x',
			role TEXT NOT NULL CHECK(role IN ('Super Admin', 'Dispatcher', 'Driver', 'Investor', 'KPI Viewer')),
			driver_name TEXT DEFAULT '',
			email TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			${disableColumn ? ", disabled_at TEXT DEFAULT NULL" : ""}
		);
		CREATE TABLE sessions (sid TEXT NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TEXT NOT NULL);
	`);
	const addUser = (id, username, role, disabledAt = null) => {
		if (disableColumn) db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (?, ?, ?, ?)").run(id, username, role, disabledAt);
		else db.prepare("INSERT INTO users (id, username, role) VALUES (?, ?, ?)").run(id, username, role);
	};
	const addSession = (sid, user, expire = LATER) => {
		const cookie = { originalMaxAge: 86400000, expires: expire, secure: true, httpOnly: true, path: "/", sameSite: "lax" };
		db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)").run(sid, JSON.stringify(user ? { cookie, user } : { cookie }), expire);
	};
	return { file, db, addUser, addSession };
}
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mtime = (file) => fs.statSync(file).mtimeMs;

try {
	// ── §1 ──────────────────────────────────────────────────────────────────
	{
		const noDb = check([]);
		ok("§1 no --db: refused (exit 2)", noDb.code === 2 && /--db/.test(noDb.out), noDb);

		const empty = makeDb("empty");
		empty.addUser(7, "owner_sample", "Super Admin");
		empty.db.close();
		const e = check([`--db=${empty.file}`]);
		eq("§1 no session at all: exit 2", e.code, 2);
		ok("§1 ...says \"no evidence: 0 live sessions\" and gives no verdict line",
			/no evidence: 0 live sessions/.test(e.out) && !/would (stay|be)/.test(e.out), e.out);

		const stale = makeDb("stale");
		stale.addUser(7, "owner_sample", "Super Admin");
		stale.addSession("sid-stale-expired-0001", { id: 99, username: "ghost_sample", role: "Dispatcher" }, EARLIER);
		stale.addSession("sid-stale-signedout-0002", null);
		stale.db.close();
		const s = check([`--db=${stale.file}`]);
		eq("§1 only an expired and a signed-out session: exit 2 (not 1 for the expired one)", s.code, 2);
		ok("§1 ...counts them as not counted, and says no evidence",
			/live: 0; not counted: 1 expired, 1 signed out, 0 unreadable/.test(s.out) && /no evidence: 0 live sessions/.test(s.out), s.out);
	}

	// ── §2 ──────────────────────────────────────────────────────────────────
	{
		const fine = makeDb("fine");
		fine.addUser(7, "owner_sample", "Super Admin");
		fine.addUser(20, "desk_sample", "Dispatcher");
		fine.addUser(21, "desk_sample_two", "Dispatcher");
		fine.addUser(30, "dana_sample", "Driver");
		fine.addUser(40, "ivan_sample", "Investor");
		fine.addUser(50, "kay_sample", "KPI Viewer");
		fine.addSession("sid-fine-0001", { id: 7, username: "owner_sample", role: "Super Admin" });
		fine.addSession("sid-fine-0002", { id: 20, username: "desk_sample", role: "Dispatcher" });
		fine.addSession("sid-fine-0003", { id: 21, username: "desk_sample_two", role: "Dispatcher" });
		fine.addSession("sid-fine-0004", { id: 30, username: "dana_sample", role: "Driver" });
		fine.addSession("sid-fine-0005", { id: 40, username: "ivan_sample", role: "Investor" });
		fine.addSession("sid-fine-0007", { id: 50, username: "kay_sample", role: "KPI Viewer" });
		// Expired, and it would be signed out (no such account): not counted.
		fine.addSession("sid-fine-0006", { id: 99, username: "ghost_sample", role: "Dispatcher" }, EARLIER);
		fine.db.close();
		const f = check([`--db=${fine.file}`]);
		eq("§2 every live session survives: exit 0", f.code, 0);
		ok("§2 ...counted by role (a KPI Viewer's too, its role matching its row), the expired one left out",
			/sessions read: 7 \(live: 6; not counted: 1 expired, 0 signed out, 0 unreadable\)/.test(f.out) &&
			/would stay signed in: 6 \(Dispatcher 2, Driver 1, Investor 1, KPI Viewer 1, Super Admin 1\)/.test(f.out) &&
			/would be signed out: 0 \(none\)/.test(f.out), f.out);
	}

	// ── §3 ──────────────────────────────────────────────────────────────────
	{
		const mixed = makeDb("mixed");
		mixed.addUser(7, "owner_sample", "Super Admin");
		mixed.addUser(8, "second_sample", "Super Admin", STAMP);
		mixed.addUser(20, "desk_sample", "Dispatcher");
		mixed.addUser(30, "dana_sample", "Driver");
		mixed.addSession("sid-mixed-0001", { id: 7, username: "owner_sample", role: "Super Admin" });
		mixed.addSession("sid-mixed-0002", { id: 30, username: "dana_sample", role: "Driver" });
		mixed.addSession("sid-mixed-0003", { id: "20", username: "desk_sample", role: "Dispatcher" });
		mixed.addSession("sid-mixed-0004", { id: "abc", username: "desk_sample", role: "Dispatcher" });
		mixed.addSession("sid-mixed-0005", { id: 99, username: "ghost_sample", role: "Dispatcher" });
		mixed.addSession("sid-mixed-0006", { id: 20, username: "desk_sample", role: "Super Admin" });
		mixed.addSession("sid-mixed-0007", { id: 8, username: "second_sample", role: "Super Admin" });
		mixed.addSession("sid-mixed-0008", null);
		mixed.db.prepare("INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)").run("sid-mixed-0009", "{not json", LATER);
		mixed.addSession("sid-mixed-0010", { id: 20, username: "desk_sample", role: "Super Admin" }, EARLIER);
		mixed.db.close();
		const m = check([`--db=${mixed.file}`]);
		eq("§3 some would be signed out: exit 1", m.code, 1);
		ok("§3 ...live sessions only, split into kept and ended",
			/sessions read: 10 \(live: 7; not counted: 1 expired, 1 signed out, 1 unreadable\)/.test(m.out) &&
			/would stay signed in: 2 \(Driver 1, Super Admin 1\)/.test(m.out), m.out);
		ok("§3 ...each reason counted by role (a non-numeric id, a missing row, a changed role, a disabled account)",
			/would be signed out: 5 \(Dispatcher: account not found 1, Dispatcher: no account id 2, Super Admin: disabled 1, Super Admin: role changed 1\)/.test(m.out), m.out);

		const solo = makeDb("solo");
		solo.addUser(20, "desk_sample", "Dispatcher");
		solo.addSession("sid-solo-0001", { id: 20, username: "desk_sample", role: "Super Admin" });
		solo.db.close();
		const r = check([`--db=${solo.file}`]);
		ok("§3 a single changed role is enough for exit 1",
			r.code === 1 && /would be signed out: 1 \(Super Admin: role changed 1\)/.test(r.out), r);
	}

	// ── §4 ──────────────────────────────────────────────────────────────────
	{
		const old = makeDb("before-disable", { disableColumn: false });
		old.addUser(7, "owner_sample", "Super Admin");
		old.addUser(20, "desk_sample", "Dispatcher");
		old.addSession("sid-old-0001", { id: 7, username: "owner_sample", role: "Super Admin" });
		old.addSession("sid-old-0002", { id: 20, username: "desk_sample", role: "Dispatcher" });
		old.db.close();
		const o = check([`--db=${old.file}`]);
		ok("§4 no disabled_at column: read, exit 0, counted by role",
			o.code === 0 && /would stay signed in: 2 \(Dispatcher 1, Super Admin 1\)/.test(o.out), o);
		const oldMissing = makeDb("before-disable-missing", { disableColumn: false });
		oldMissing.addUser(7, "owner_sample", "Super Admin");
		oldMissing.addSession("sid-old-0003", { id: 99, username: "ghost_sample", role: "Driver" });
		oldMissing.db.close();
		const o2 = check([`--db=${oldMissing.file}`]);
		ok("§4 ...and a missing row there still gives exit 1",
			o2.code === 1 && /would be signed out: 1 \(Driver: account not found 1\)/.test(o2.out), o2);
	}

	// ── §5 and §6 ───────────────────────────────────────────────────────────
	{
		const secretSid = "sid-madeup-Qx7Lw2Pz9Rk4Vb8N";
		const priv = makeDb("private");
		priv.addUser(7, "owner_sample", "Super Admin");
		priv.addUser(20, "desk_sample", "Dispatcher");
		priv.addSession(secretSid, { id: 7, username: "owner_sample", role: "Super Admin" });
		priv.addSession("sid-madeup-Hn3Tc6Ys1Md5Jf0G", { id: 20, username: "desk_sample", role: "Super Admin" });
		priv.addSession("sid-madeup-Wp8Ke2Lr7Ub4Az9X", { id: 99, username: "ghost_sample", role: "Dispatcher" });
		priv.db.close();
		const hash = sha(priv.file);
		const stamp = mtime(priv.file);
		const p = check([`--db=${priv.file}`]);
		eq("§5 the run itself: exit 1", p.code, 1);
		ok("§5 no session id in its output", !/sid-madeup|Qx7Lw2Pz9Rk4Vb8N|Hn3Tc6Ys1Md5Jf0G|Wp8Ke2Lr7Ub4Az9X/.test(p.out), p.out);
		ok("§5 no cookie value or cookie field in its output", !/s:sid|s%3A|httpOnly|originalMaxAge|sameSite|cookie/i.test(p.out), p.out);
		ok("§5 no username or account id in its output", !/owner_sample|desk_sample|ghost_sample|#\d|\b99\b|\b20\b/.test(p.out), p.out);
		eq("§6 the database file's bytes are unchanged", sha(priv.file), hash);
		eq("§6 ...and its mtime", mtime(priv.file), stamp);

		// As on production: the server holds the file open in WAL mode while the check runs.
		const wal = makeDb("wal");
		wal.db.pragma("journal_mode = WAL");
		wal.addUser(7, "owner_sample", "Super Admin");
		wal.db.pragma("wal_checkpoint(TRUNCATE)");
		const walHash = sha(wal.file);
		const walStamp = mtime(wal.file);
		wal.addSession("sid-wal-0001", { id: 7, username: "owner_sample", role: "Super Admin" });
		const w = check([`--db=${wal.file}`]);
		ok("§6 WAL mode with a writer open: the session still in the WAL is read (exit 0)",
			w.code === 0 && /would stay signed in: 1 \(Super Admin 1\)/.test(w.out), w);
		eq("§6 ...and the main file's bytes are unchanged", sha(wal.file), walHash);
		eq("§6 ...and its mtime", mtime(wal.file), walStamp);
		wal.db.close();
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
