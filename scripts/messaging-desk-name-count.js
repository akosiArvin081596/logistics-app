#!/usr/bin/env node
// scripts/messaging-desk-name-count.js — the read-only count that gates the
// staff-only messaging change (decision 30, 2026-10-21). Counts only: it prints
// no name, username or id, and writes nothing (the database is opened
// read-only).
//
// From the merge on, a staff desk's name ("dispatch", "admin") and "investor"
// are no account's, and a chat recipient is matched by an account's name. This
// says whether any account already in the database would break either:
//   (a) accounts of any role whose username or driver name is a desk's name or
//       "investor" (trimmed, any case, internal spaces folded);
//   (b) name collisions between accounts: a username that is another account's
//       driver name, two accounts sharing a driver name, two usernames equal
//       but for case or spacing;
//   (c) Driver accounts with no driver name (they can no longer send a message).
// The change merges only when (a) and (b) are 0. (c) is reported for the
// decision on Drivers with no driver name.
//
// Usage:
//   node scripts/messaging-desk-name-count.js --db=<app.db> [--json]
// Exit: 0 when (a) and (b) are 0, 1 when either is not, 2 on a usage error.

"use strict";

const fs = require("fs");
const path = require("path");

// The names no account may take: CHAT_DESK_NAMES' keys and "investor", as
// findDriverNameClashes() reserves them in server.js.
const RESERVED = Object.freeze(["dispatch", "admin", "investor"]);

// normalizeDriverName() in server.js: trimmed, lower-cased, whitespace runs
// folded to one space.
const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");

// The counts for `rows` ({ id, role, username, driver_name } per account).
function countDeskNames(rows) {
	const accounts = rows.map((r) => ({ id: r.id, role: String(r.role || ""), user: norm(r.username), driver: norm(r.driver_name) }));
	const a = accounts.filter((u) => RESERVED.includes(u.user) || RESERVED.includes(u.driver)).length;
	let usernameIsOthersDriverName = 0;
	let sharedDriverName = 0;
	let sameUsername = 0;
	for (let i = 0; i < accounts.length; i++) {
		for (let j = 0; j < accounts.length; j++) {
			if (i === j) continue;
			const x = accounts[i], y = accounts[j];
			if (x.user && y.driver && x.user === y.driver) usernameIsOthersDriverName++;
			if (i < j && x.driver && x.driver === y.driver) sharedDriverName++;
			if (i < j && x.user && x.user === y.user) sameUsername++;
		}
	}
	const c = accounts.filter((u) => u.role === "Driver" && !u.driver).length;
	const b = usernameIsOthersDriverName + sharedDriverName + sameUsername;
	return {
		a_desk_named_accounts: a,
		b_name_collisions: b,
		b1_username_is_another_accounts_driver_name: usernameIsOthersDriverName,
		b2_accounts_sharing_a_driver_name: sharedDriverName,
		b3_usernames_equal_but_for_case_or_spacing: sameUsername,
		c_driver_accounts_without_a_driver_name: c,
		accounts: accounts.length,
		gate: a === 0 && b === 0 ? "PASS" : "STOP",
	};
}

function parseArgs(argv) {
	const out = {};
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue;
		const eq = arg.indexOf("=");
		if (eq === -1) out[arg.slice(2)] = true;
		else out[arg.slice(2, eq)] = arg.slice(eq + 1);
	}
	return out;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.db !== "string" || !args.db.trim()) {
		console.error("usage: node scripts/messaging-desk-name-count.js --db=<app.db> [--json]");
		process.exit(2);
	}
	const dbFile = path.resolve(args.db);
	if (!fs.existsSync(dbFile) || !fs.statSync(dbFile).isFile()) {
		console.error(`--db=${args.db}: there is no such database file`);
		process.exit(2);
	}
	const Database = require("better-sqlite3");
	const db = new Database(dbFile, { readonly: true, fileMustExist: true });
	if (!db.readonly) {
		console.error("refusing: the database handle is not read-only");
		process.exit(2);
	}
	let counts;
	try {
		counts = countDeskNames(db.prepare("SELECT id, role, username, driver_name FROM users").all());
	} finally {
		db.close();
	}
	if (args.json) {
		console.log(JSON.stringify(counts));
	} else {
		console.log(`(a) accounts named like a staff desk or "investor": ${counts.a_desk_named_accounts}`);
		console.log(`(b) name collisions between accounts: ${counts.b_name_collisions}`);
		console.log(`    a username that is another account's driver name: ${counts.b1_username_is_another_accounts_driver_name}`);
		console.log(`    two accounts sharing a driver name: ${counts.b2_accounts_sharing_a_driver_name}`);
		console.log(`    two usernames equal but for case or spacing: ${counts.b3_usernames_equal_but_for_case_or_spacing}`);
		console.log(`(c) Driver accounts without a driver name: ${counts.c_driver_accounts_without_a_driver_name}`);
		console.log(`accounts read: ${counts.accounts}`);
		console.log(`GATE: ${counts.gate}${counts.gate === "PASS" ? " ((a) and (b) are 0)" : " ((a) or (b) is not 0: do not merge; report to Arvin)"}`);
	}
	process.exit(counts.gate === "PASS" ? 0 : 1);
}

if (require.main === module) main();

module.exports = { countDeskNames, RESERVED };
