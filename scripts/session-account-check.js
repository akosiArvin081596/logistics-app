#!/usr/bin/env node
// Read-only, on a local copy: which stored sessions would the per-request account check sign out?
// Counts by role and reason only. Exit 0 none would be, 1 some would be, 2 refused.
// Usage: node scripts/session-account-check.js --db=<path to a copy of app.db>
// (Its rule is lib/account-disable.js sessionEndReason(), the one signOutEndedAccount() follows.)
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { parseArgs } = require("./lib/ledger-world");
const { sessionAccountId, sessionEndReason } = require("../lib/account-disable");

const appRequire = createRequire(path.join(__dirname, "..", "server.js"));

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const dbPath = typeof args.db === "string" ? args.db.trim() : "";
	if (!dbPath) refuse("--db is required");
	if (!fs.existsSync(dbPath)) refuse(`no database at ${dbPath}`);
	const Database = appRequire("better-sqlite3");
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const hasTable = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
		if (!hasTable("sessions") || !hasTable("users")) refuse("this database has no sessions or no users table");
		const cols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
		const readRow = db.prepare(`SELECT role${cols.has("disabled_at") ? ", disabled_at" : ""} FROM users WHERE id = ?`);
		const now = Date.now();
		let read = 0;
		let unexpired = 0;
		let unreadable = 0;
		let withoutUser = 0;
		const kept = new Map();
		const ended = new Map();
		const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
		for (const s of db.prepare("SELECT sess, expire FROM sessions").all()) {
			read++;
			if (Date.parse(s.expire) > now) unexpired++;
			let sess;
			try { sess = JSON.parse(s.sess); } catch { unreadable++; continue; }
			const user = sess && sess.user;
			if (!user) { withoutUser++; continue; }
			const role = typeof user.role === "string" && user.role ? user.role : "(no role)";
			const id = sessionAccountId(user);
			const reason = sessionEndReason(user, id === null ? null : readRow.get(id) || null);
			if (reason) bump(ended, `${role}: ${reason}`);
			else bump(kept, role);
		}
		const list = (map) => [...map.entries()].sort().map(([k, n]) => `${k} ${n}`).join(", ") || "none";
		const total = (map) => [...map.values()].reduce((a, b) => a + b, 0);
		console.log(`sessions read: ${read} (${unexpired} unexpired now; ${withoutUser} signed out already; ${unreadable} unreadable)`);
		console.log(`would stay signed in: ${total(kept)} (${list(kept)})`);
		console.log(`would be signed out: ${total(ended)} (${list(ended)})`);
		if (total(ended) > 0) process.exitCode = 1;
	} finally {
		db.close();
	}
}

try {
	main();
} catch (err) {
	console.error(`ERROR: ${err.message}`);
	process.exit(2);
}
