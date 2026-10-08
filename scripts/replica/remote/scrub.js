#!/usr/bin/env node
// replica:pull, on the server, step 2a: clear every stored token and session in
// the pull's TEMPORARY copy of the database (never the live one), before it is
// downloaded. Everything else stays exactly as production has it.
//
//   node scrub.js --db=/root/logisx-replica-tmp/<stamp>/app.db
//
// What is cleared, found by reading the copy's own schema (sqlite_master), so a
// column added later is caught without editing this file:
//   - sessions: every row (active sign-ins);
//   - any column whose name says it holds a token, a secret or an OAuth/API
//     credential (TOKEN_COLUMN_RE): investor_applications.access_token (the old
//     onboarding link credential) and investor_invites.token_sha256 (the
//     payment-terms invite links) today. A NOT NULL column gets a fresh random
//     value of the same shape, which no link or caller holds; any other is
//     set to NULL;
//   - key/value rows (app_settings, server_state) whose key names a token,
//     secret or OAuth/API credential.
// Prints one JSON summary: what was cleared, by table and column, with row
// counts and never a value.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TOKEN_COLUMN_RE = /(^|_)(access_?token|refresh_?token|id_?token|auth_?token|bearer|token|token_sha256|reset_?token|invite_?token|setup_?token|api_?key|apikey|secret|client_secret|oauth\w*|otp\w*|password_reset\w*)(_|$)/i;
const KEY_VALUE_TABLES = ["app_settings", "server_state"];
const SECRET_KEY_RE = /token|secret|oauth|api_?key|password|credential|bearer/i;

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

function scrub(db) {
	const cleared = [];
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
	const tx = db.transaction(() => {
		if (tables.includes("sessions")) {
			const n = db.prepare("DELETE FROM sessions").run().changes;
			cleared.push({ table: "sessions", column: "*", rows: n, how: "deleted" });
		}
		for (const t of tables) {
			if (t === "sessions") continue;
			const cols = db.prepare(`PRAGMA table_info(${q(t)})`).all();
			for (const c of cols) {
				if (!TOKEN_COLUMN_RE.test(c.name)) continue;
				const filled = db.prepare(`SELECT rowid AS id FROM ${q(t)} WHERE ${q(c.name)} IS NOT NULL AND ${q(c.name)} != ''`).all();
				if (c.notnull) {
					// NOT NULL (and maybe UNIQUE): a fresh random value per row.
					const set = db.prepare(`UPDATE ${q(t)} SET ${q(c.name)} = ? WHERE rowid = ?`);
					for (const r of filled) set.run(crypto.randomBytes(32).toString("hex"), r.id);
					cleared.push({ table: t, column: c.name, rows: filled.length, how: "replaced with a random value" });
				} else {
					const n = db.prepare(`UPDATE ${q(t)} SET ${q(c.name)} = NULL WHERE ${q(c.name)} IS NOT NULL AND ${q(c.name)} != ''`).run().changes;
					cleared.push({ table: t, column: c.name, rows: n, how: "set to NULL" });
				}
			}
		}
		for (const t of KEY_VALUE_TABLES) {
			if (!tables.includes(t)) continue;
			const keys = db.prepare(`SELECT key FROM ${q(t)}`).all().map((r) => r.key).filter((k) => SECRET_KEY_RE.test(String(k)));
			const del = db.prepare(`DELETE FROM ${q(t)} WHERE key = ?`);
			for (const k of keys) del.run(k);
			cleared.push({ table: t, column: "key", rows: keys.length, how: "rows whose key names a credential deleted" });
		}
	});
	tx();
	return cleared;
}

if (require.main === module) {
	try {
		const file = arg("db");
		const appDir = arg("app");
		if (!file || !appDir) throw new Error("usage: scrub.js --app=<app dir> --db=<the pull's copy>");
		const real = fs.realpathSync(file);
		// Never the live database, by any name.
		const live = path.join(appDir, "app.db");
		if (fs.existsSync(live) && (real === fs.realpathSync(live) || fs.statSync(real).ino === fs.statSync(live).ino)) {
			throw new Error("refusing: that is the live database");
		}
		if (path.basename(real) !== "app.db" || real.startsWith(fs.realpathSync(appDir) + path.sep)) {
			throw new Error("refusing: scrub runs only on the pull's own copy (app.db outside the app directory)");
		}
		const Database = require(path.join(appDir, "node_modules", "better-sqlite3"));
		const db = new Database(real, { fileMustExist: true });
		const cleared = scrub(db);
		db.close();
		console.log(JSON.stringify({ step: "scrub", cleared }));
	} catch (err) {
		console.error(`scrub: ${err.message}`);
		process.exit(1);
	}
}

module.exports = { scrub, TOKEN_COLUMN_RE, SECRET_KEY_RE };
