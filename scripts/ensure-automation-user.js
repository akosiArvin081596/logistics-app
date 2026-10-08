#!/usr/bin/env node
// scripts/ensure-automation-user.js — makes sure a non-production deployment has
// its browser-automation login (a Super Admin used by Playwright checks), run on
// the server with no login. The password arrives on stdin, piped from the
// operator's macOS Keychain, so it is never typed, printed, or written to a file:
//
//   security find-generic-password -s logisx-staging -w \
//     | ssh <vps> 'cd /var/www/logisx-staging && /opt/node22/bin/node scripts/ensure-automation-user.js --db=app.db --username=e2e_playwright'
//
// - Refuses on production: an app whose .env names no SPREADSHEET_ID, or names
//   the production sheet (lib/sheet-id.js), writes to production's books,
//   and an automation Super Admin must never exist there. The .env is the one
//   of the app directory --db is in; a database anywhere else is refused (a
//   copy under the temp directory, for tests, may name its .env with
//   --env-file).
// - Refuses when stdin is a terminal or empty (a password is piped, never typed).
// - The account exists (any case or spacing of the name): changes nothing — not
//   its password, not its role — and says so; a role other than Super Admin is
//   reported and refused.
// - Otherwise creates it as a Super Admin with no forced password change, hashed
//   as POST /api/users hashes, and writes an audit row naming this script as the
//   actor. Prints the account's id, name and role; never the password.
//
// Usage: node scripts/ensure-automation-user.js --db=app.db --username=<name> [--env-file=<file>]
// Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { parseArgs, envFor } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:ensure-automation-user";
const appRequire = createRequire(path.join(ROOT, "server.js"));

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function productionSheetId() {
	return require("../lib/sheet-id").PRODUCTION_SPREADSHEET_ID;
}

function readStdin() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		process.stdin.on("data", (c) => chunks.push(c));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		process.stdin.on("error", reject);
	});
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db || args.db === true) refuse("--db is required");
	const username = typeof args.username === "string" ? args.username.trim() : "";
	if (!username) refuse("--username is required");

	// The .env of the app whose database this is (a database outside this app
	// directory is refused, so another deployment's can never pass this check).
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath: args.db, envFile: typeof args["env-file"] === "string" ? args["env-file"] : null }));
	} catch (err) {
		refuse(err.message);
	}
	if (!env.SPREADSHEET_ID || env.SPREADSHEET_ID === productionSheetId()) {
		refuse("this app writes to the production sheet (its .env names no other SPREADSHEET_ID); automation accounts are for staging and local only");
	}

	if (process.stdin.isTTY) refuse("pipe the password on stdin (from the Keychain); it is never typed");
	const password = (await readStdin()).replace(/\r?\n$/, "");
	if (!password) refuse("no password on stdin");

	const Database = appRequire("better-sqlite3");
	const db = new Database(dbFile, { fileMustExist: true });
	db.pragma("busy_timeout = 10000");
	const find = () => db.prepare("SELECT id, username, role FROM users WHERE LOWER(TRIM(username)) = LOWER(?)").get(username);
	const existing = find();
	if (existing) {
		db.close();
		if (existing.role !== "Super Admin") refuse(`${existing.username} (user ${existing.id}) exists with role ${existing.role}; nothing changed`);
		console.log(JSON.stringify({ id: existing.id, username: existing.username, role: existing.role, created: false, note: "exists; password and role left as they are" }));
		return;
	}

	const hash = await appRequire("bcryptjs").hash(password, 10);
	const created = db.transaction(() => {
		if (find()) return null;
		const id = Number(db.prepare(
			"INSERT INTO users (username, password_hash, role, driver_name, email, full_name, must_change_password) VALUES (?, ?, 'Super Admin', '', '', 'Browser automation', 0)",
		).run(username, hash).lastInsertRowid);
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'script', 'automation_user_created', 'user', ?, ?)")
			.run(new Date().toISOString(), ACTOR, String(id), `created ${username} (Super Admin) for browser automation; password piped from the operator's Keychain`);
		return id;
	})();
	db.close();
	if (created === null) refuse(`${username} was created by someone else meanwhile; nothing changed`);
	console.log(JSON.stringify({ id: created, username, role: "Super Admin", created: true }));
}

main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exit(1); });
