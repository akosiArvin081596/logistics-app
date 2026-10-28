// scripts/reset-super-admin-password.js
//
// Resets ONE Super Admin account's password in the target SQLite db, ends that
// account's sessions only, and writes one system audit row (user 0,
// "system: reset-super-admin-password", action reset_password_script). The new
// password comes from the NEW_PASSWORD env var so it never lands in shell
// history or `ps` output, and nothing here prints it.
//
// Usage:
//   NEW_PASSWORD='...' node scripts/reset-super-admin-password.js [--id <n> | --username <u>] [/path/to/app.db]
//   node scripts/reset-super-admin-password.js --dry-run [--id <n> | --username <u>] [/path/to/app.db]
//
// With neither --id nor --username the target is the `super_admin` account. A
// target that is not a Super Admin is refused, and so is a database without an
// audit_trail table (the reset must leave its row). --dry-run opens the
// database read-only, needs no NEW_PASSWORD, writes nothing, and prints the
// account's id, role and the number of sessions a reset would end. The
// server's minute sweep closes the live-update sockets of the ended sessions.
// Exit 0 on success, 1 on a refusal.

"use strict";

const path = require("path");
const fs = require("fs");

const ACTOR = "system: reset-super-admin-password";
const ACTION = "reset_password_script";
const DEFAULT_USERNAME = "super_admin";
const MIN_LENGTH = 16;

function parseArgs(argv) {
	const out = { id: null, username: null, dryRun: false, dbPath: null, errors: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const value = (name) => {
			if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
			i++;
			return i < argv.length ? argv[i] : null;
		};
		if (a === "--dry-run") out.dryRun = true;
		else if (a === "--id" || a.startsWith("--id=")) out.id = value("id");
		else if (a === "--username" || a.startsWith("--username=")) out.username = value("username");
		else if (a.startsWith("--")) out.errors.push(`unknown option ${a}`);
		else if (out.dbPath === null) out.dbPath = a;
		else out.errors.push("more than one database path");
	}
	if ((argv.includes("--id") || argv.some((a) => a.startsWith("--id="))) && !out.id) out.errors.push("--id needs a value");
	if ((argv.includes("--username") || argv.some((a) => a.startsWith("--username="))) && !out.username) out.errors.push("--username needs a value");
	return out;
}

// The account a reset would change: { account: { id, username, role } } or
// { error }. scripts/shared-login-report.js asks the same question (check C6).
function resolveTarget(db, { id = null, username = null } = {}) {
	if (id !== null && username !== null) return { error: "give --id or --username, not both" };
	let row;
	if (id !== null) {
		const n = Number(id);
		if (!Number.isInteger(n) || n <= 0) return { error: "--id must be a positive whole number" };
		row = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(n);
		if (!row) return { error: `no account with id ${n}` };
	} else {
		const name = username === null ? DEFAULT_USERNAME : String(username);
		row = db.prepare("SELECT id, username, role FROM users WHERE username = ?").get(name);
		if (!row) return { error: username === null ? `no ${DEFAULT_USERNAME} account in this database` : "no account with that username" };
	}
	if (row.role !== "Super Admin") return { error: `account id ${row.id} is not a Super Admin; this script resets Super Admins only` };
	return { account: row };
}

function hasTable(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// The account's stored sessions (connect-style JSON, the key purgeUserSessions() uses).
function sessionCount(db, userId) {
	if (!hasTable(db, "sessions")) return 0;
	return db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(sess, '$.user.id') = ?").get(userId).n;
}

function fail(msg) {
	console.error(`ERROR: ${msg}`);
	process.exit(1);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.errors.length) fail(args.errors.join("; "));
	const dbPath = args.dbPath || path.join(__dirname, "..", "app.db");
	if (!fs.existsSync(dbPath)) fail(`database not found at ${dbPath}`);
	const Database = require("better-sqlite3");

	if (args.dryRun) {
		const db = new Database(dbPath, { readonly: true, fileMustExist: true });
		try {
			const target = resolveTarget(db, args);
			if (target.error) fail(target.error);
			console.log(`DRY RUN — nothing written to ${dbPath}`);
			console.log(`  user id=${target.account.id}, role=${target.account.role}`);
			console.log(`  sessions a reset would end: ${sessionCount(db, target.account.id)}`);
			if (!hasTable(db, "audit_trail")) console.log("  no audit_trail table: a reset would be refused");
		} finally {
			db.close();
		}
		return;
	}

	const newPassword = process.env.NEW_PASSWORD;
	if (!newPassword) fail("NEW_PASSWORD env var is required");
	if (newPassword.length < MIN_LENGTH) fail(`NEW_PASSWORD is only ${newPassword.length} chars — refusing to set a weak password`);

	const bcrypt = require("bcryptjs");
	const db = new Database(dbPath, { fileMustExist: true });
	try {
		const target = resolveTarget(db, args);
		if (target.error) fail(target.error);
		if (!hasTable(db, "audit_trail")) fail("no audit_trail table in this database: a reset must leave an audit row, so nothing was changed");
		const { id, role } = target.account;

		const hash = bcrypt.hashSync(newPassword, 10);
		// Verify the hash round-trips before writing, as defense in depth.
		if (!bcrypt.compareSync(newPassword, hash)) fail("generated hash failed self-verification — aborting");

		// One transaction: the password, this account's sessions and the audit row
		// land together or not at all.
		const ended = db.transaction(() => {
			const changed = db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'Super Admin'").run(hash, id).changes;
			if (changed !== 1) throw new Error(`expected 1 row to update, got ${changed}`);
			const n = hasTable(db, "sessions")
				? db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ?").run(id).changes
				: 0;
			db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, 'user', ?, ?)")
				.run(new Date().toISOString(), ACTOR, ACTION, String(id),
					`Password reset for account id ${id} by scripts/reset-super-admin-password.js; its sessions ended: ${n}`);
			return n;
		})();

		console.log(`Ended ${ended} session(s) of account id ${id}; other accounts stay signed in.`);
		console.log(`OK — password updated for account id ${id} in ${dbPath}`);
		console.log(`  user id=${id}, role=${role}`);
		console.log(`  hash length=${hash.length}, bcrypt rounds=10`);
		console.log(`  audit row: ${ACTION} (${ACTOR})`);
	} catch (err) {
		fail(err.message);
	} finally {
		if (db.open) db.close();
	}
}

if (require.main === module) main();

module.exports = { resolveTarget, sessionCount, parseArgs, ACTOR, ACTION };
