// scripts/create-demo-user.js
//
// Seeds or updates a read-only demo user with Super Admin role.
// The server.js middleware blocks all non-GET requests for username
// 'demo_viewer', so this account can view the entire app but cannot
// mutate any data.
//
// Usage:
//   node scripts/create-demo-user.js
//   node scripts/create-demo-user.js /path/to/app.db
//
// Password is hardcoded here because it's a public demo credential —
// not a production secret. Anyone who knows the URL gets it.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const USERNAME = "demo_viewer";
const PASSWORD = "DemoViewer2026!";
const ROLE = "Super Admin";
const EMAIL = "demo@logisx.com";
const FULL_NAME = "Demo Viewer";

const dbPath = process.argv[2] || path.join(__dirname, "..", "app.db");
if (!fs.existsSync(dbPath)) {
	console.error(`ERROR: database not found at ${dbPath}`);
	process.exit(1);
}

const db = new Database(dbPath);
const hash = bcrypt.hashSync(PASSWORD, 10);

const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(USERNAME);
if (existing) {
	db.prepare("UPDATE users SET password_hash = ?, role = ?, email = ?, full_name = ? WHERE username = ?").run(
		hash, ROLE, EMAIL, FULL_NAME, USERNAME
	);
	console.log(`Updated existing demo user (id=${existing.id})`);
} else {
	const result = db.prepare(
		"INSERT INTO users (username, password_hash, role, email, full_name) VALUES (?, ?, ?, ?, ?)"
	).run(USERNAME, hash, ROLE, EMAIL, FULL_NAME);
	console.log(`Created demo user (id=${result.lastInsertRowid})`);
}

// Clear any existing demo sessions so the new password takes effect immediately.
try {
	db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run("%demo_viewer%");
} catch {
	// sessions table may not be queryable this way — safe to skip
}

db.close();

console.log("");
console.log("Demo credentials:");
console.log(`  Username: ${USERNAME}`);
console.log(`  Password: ${PASSWORD}`);
console.log(`  Role:     ${ROLE} (with read-only middleware lockdown)`);
