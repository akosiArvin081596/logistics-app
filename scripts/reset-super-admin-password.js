// scripts/reset-super-admin-password.js
//
// Resets the super_admin user's password_hash in the target SQLite db.
// Takes the plaintext password from the NEW_PASSWORD env var so it
// doesn't land in shell history or `ps` output.
//
// Usage:
//   NEW_PASSWORD='...' node scripts/reset-super-admin-password.js
//   NEW_PASSWORD='...' node scripts/reset-super-admin-password.js /path/to/app.db

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const newPassword = process.env.NEW_PASSWORD;
if (!newPassword) {
	console.error("ERROR: NEW_PASSWORD env var is required");
	process.exit(1);
}
if (newPassword.length < 16) {
	console.error(`ERROR: NEW_PASSWORD is only ${newPassword.length} chars — refusing to set a weak password`);
	process.exit(1);
}

const dbPath = process.argv[2] || path.join(__dirname, "..", "app.db");
if (!fs.existsSync(dbPath)) {
	console.error(`ERROR: database not found at ${dbPath}`);
	process.exit(1);
}

const db = new Database(dbPath);

// Sanity check: super_admin user must exist.
const existing = db.prepare("SELECT id, username, role FROM users WHERE username = 'super_admin'").get();
if (!existing) {
	console.error("ERROR: no super_admin user found in this database");
	db.close();
	process.exit(1);
}

const hash = bcrypt.hashSync(newPassword, 10);

// Verify the hash round-trips before writing, as defense in depth.
if (!bcrypt.compareSync(newPassword, hash)) {
	console.error("ERROR: generated hash failed self-verification — aborting");
	db.close();
	process.exit(1);
}

const result = db.prepare("UPDATE users SET password_hash = ? WHERE username = 'super_admin'").run(hash);
if (result.changes !== 1) {
	console.error(`ERROR: expected 1 row to update, got ${result.changes}`);
	db.close();
	process.exit(1);
}

// Also clear any active sessions so the old password's cookies stop working.
try {
	const cleared = db.prepare("DELETE FROM sessions").run();
	console.log(`Cleared ${cleared.changes} active session(s).`);
} catch { /* sessions table may not exist */ }

db.close();

console.log(`OK — super_admin password updated in ${dbPath}`);
console.log(`  user id=${existing.id}, role=${existing.role}`);
console.log(`  hash length=${hash.length}, bcrypt rounds=10`);
