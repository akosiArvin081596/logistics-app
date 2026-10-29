#!/usr/bin/env node
// The recovery when no Super Admin is enabled: enables one disabled Super Admin, a dry run unless
// --apply, one system audit row, ids only in its output. Exit 0 done or planned, 1 error, 2 refused.
// Usage: node scripts/enable-account.js --db=<path to app.db> --id=<account id> [--apply | --dry-run]
"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { parseArgs } = require("./lib/ledger-world");
const { ENABLED_SQL, isDisabledRow } = require("../lib/account-disable");

const ROOT = path.join(__dirname, "..");
const ACTOR = "system: enable-account";
const appRequire = createRequire(path.join(ROOT, "server.js"));

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// Why account `id` may not be enabled by this script, or null with its row.
function judge(db, id) {
	const row = db.prepare("SELECT id, role, disabled_at, disabled_by FROM users WHERE id = ?").get(id);
	if (!row) return { why: `no account #${id} in this database` };
	if (row.role !== "Super Admin") return { why: `account #${id} is a ${row.role}, not a Super Admin` };
	if (!isDisabledRow(row)) return { why: `account #${id} is not disabled` };
	const enabled = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'Super Admin' AND ${ENABLED_SQL}`).get().n;
	if (enabled > 0) return { why: `${enabled} Super Admin account(s) are enabled: enable #${id} on the Users page instead` };
	return { row };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const dbPath = typeof args.db === "string" ? args.db.trim() : "";
	if (!dbPath) refuse("--db is required");
	const idText = typeof args.id === "string" ? args.id.trim() : "";
	if (!/^[1-9][0-9]{0,8}$/.test(idText)) refuse("--id must be one account id (a positive whole number)");
	const id = Number(idText);
	if (args.apply === true && args["dry-run"] === true) refuse("--apply and --dry-run together");
	const apply = args.apply === true;
	if (!fs.existsSync(dbPath)) refuse(`no database at ${dbPath}`);

	const Database = appRequire("better-sqlite3");
	const db = new Database(dbPath, { fileMustExist: true, readonly: !apply });
	try {
		db.pragma("busy_timeout = 10000");
		const cols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
		if (!cols.has("disabled_at")) refuse("this database has no disabled_at column, so no account in it is disabled");
		const first = judge(db, id);
		if (first.why) refuse(first.why);
		const was = `disabled at ${first.row.disabled_at} by account #${Number(first.row.disabled_by) || "unknown"}`;
		if (!apply) {
			console.log(`DRY RUN: would enable Super Admin account #${id} (${was}); no Super Admin is enabled now. Nothing written; --apply writes it.`);
			return;
		}
		// Judged again inside the write, so nothing changes between the check and the UPDATE.
		const outcome = db.transaction(() => {
			const again = judge(db, id);
			if (again.why) return again;
			const changed = db.prepare(`UPDATE users SET disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL WHERE id = ? AND NOT (${ENABLED_SQL})`).run(id).changes;
			if (changed !== 1) return { why: `expected to enable 1 account, changed ${changed}` };
			db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', 'enable_user', 'user', ?, ?)")
				.run(new Date().toISOString(), ACTOR, String(id), `Enabled Super Admin account #${id}: no Super Admin was enabled; it was ${was}`);
			return { changed };
		})();
		if (outcome.why) refuse(outcome.why);
		console.log(`OK: enabled Super Admin account #${id} (${was}); one audit row written. It signs in with its current password.`);
	} finally {
		db.close();
	}
}

try {
	main();
} catch (err) {
	console.error(`ERROR: ${err.message}`);
	process.exit(1);
}
