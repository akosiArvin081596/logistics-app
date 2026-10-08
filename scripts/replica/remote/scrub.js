#!/usr/bin/env node
// replica:pull, on the server, step 2a: clear every stored token and session in
// the pull's TEMPORARY copy of the database (never the live one), before it is
// downloaded. Everything else stays exactly as production has it.
//
//   node scrub.js --app=<app dir> --db=/root/logisx-replica-tmp/<stamp>/app.db
//
// What is cleared, found by reading the copy's own schema (sqlite_master), so a
// column added later is caught without editing this file:
//   - sessions: every row (active sign-ins);
//   - any column whose name says it holds a credential (isCredentialColumn():
//     token, secret, nonce, otp, bearer, OAuth, API key, password reset, a
//     *_code or a *_hash, snake_case or camelCase). Today that is
//     investor_applications.access_token and investor_invites.token_sha256. A
//     NOT NULL column gets a fresh random value, which no link or caller holds;
//     any other is set to NULL. Two matches are kept on purpose (KEPT_COLUMNS);
//   - key/value rows (app_settings, server_state) whose key names a credential.
//
// Cleared means gone from the file, not just unlinked: the scrub runs with
// SQLite's secure_delete on (freed space is overwritten with zeros) and the copy
// is VACUUMed afterwards, so no page keeps an old value. Then the copy's bytes
// are searched for every value removed, and a single one still there fails the
// step, and with it the pull. The values are held in memory only, never printed
// or written: the summary has tables, columns and counts.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KEY_VALUE_TABLES = ["app_settings", "server_state"];
const SECRET_KEY_RE = /token|secret|oauth|api_?key|password|credential|bearer|nonce|otp/i;
// Columns the name rule matches that are not credentials, or are kept by design.
const KEPT_COLUMNS = Object.freeze({
	"users.password_hash": "kept by design: the accounts sign in as production's do (replica:login sets a local password on the working copy)",
	"expenses.receipt_hash": "kept: a fingerprint of a receipt image for duplicate detection, not a credential",
});
// A removed value shorter than this is not searched for: a short string occurs
// by chance in any large file. Counted and reported.
const MIN_SEARCH_LENGTH = 12;

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : undefined;
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;

// The column name as words: camelCase and snake_case alike.
function words(name) {
	return String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\W]+/).filter(Boolean);
}

function isCredentialColumn(name) {
	const w = words(name);
	const has = (x) => w.includes(x);
	const pair = (a, b) => w.some((x, i) => x === a && w[i + 1] === b);
	if (["token", "tokens", "secret", "secrets", "nonce", "otp", "bearer", "apikey"].some(has)) return true;
	if (w.some((x) => x.startsWith("oauth"))) return true;
	if (pair("api", "key") || pair("password", "reset")) return true;
	const last = w[w.length - 1];
	return w.length > 1 && (last === "hash" || last === "code");
}

function scrub(db) {
	const cleared = [];
	const removed = [];
	db.pragma("journal_mode = DELETE");
	db.pragma("secure_delete = ON");
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
	const tx = db.transaction(() => {
		if (tables.includes("sessions")) {
			for (const r of db.prepare("SELECT sid FROM sessions").all()) removed.push(r.sid);
			const n = db.prepare("DELETE FROM sessions").run().changes;
			cleared.push({ table: "sessions", column: "*", rows: n, how: "deleted" });
		}
		for (const t of tables) {
			if (t === "sessions") continue;
			for (const c of db.prepare(`PRAGMA table_info(${q(t)})`).all()) {
				if (!isCredentialColumn(c.name)) continue;
				const id = `${t}.${c.name}`;
				if (KEPT_COLUMNS[id]) { cleared.push({ table: t, column: c.name, rows: 0, how: KEPT_COLUMNS[id] }); continue; }
				const filled = db.prepare(`SELECT rowid AS id, ${q(c.name)} AS v FROM ${q(t)} WHERE ${q(c.name)} IS NOT NULL AND ${q(c.name)} != ''`).all();
				for (const r of filled) removed.push(r.v);
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
			const rows = db.prepare(`SELECT key, value FROM ${q(t)}`).all().filter((r) => SECRET_KEY_RE.test(String(r.key)));
			const del = db.prepare(`DELETE FROM ${q(t)} WHERE key = ?`);
			for (const r of rows) { removed.push(r.value); del.run(r.key); }
			cleared.push({ table: t, column: "key", rows: rows.length, how: "rows whose key names a credential deleted" });
		}
	});
	tx();
	// Rewrite the file: no free page or overflow page keeps a removed value.
	db.exec("VACUUM");
	return { cleared, removed };
}

// How many of `values` are still in the bytes of `files` (read in chunks, never
// whole). Values are compared as stored (UTF-8 text, or the bytes of a blob).
function residue(files, values) {
	const needles = [];
	let tooShort = 0;
	for (const v of new Set(values.filter((x) => x !== null && x !== undefined && x !== ""))) {
		const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), "utf8");
		if (b.length < MIN_SEARCH_LENGTH) tooShort++;
		else needles.push(b);
	}
	const found = new Set();
	const maxLen = needles.reduce((m, b) => Math.max(m, b.length), 0);
	for (const file of files) {
		if (!needles.length || !fs.existsSync(file)) continue;
		const fd = fs.openSync(file, "r");
		try {
			const chunk = Buffer.alloc(8 * 1024 * 1024);
			let carry = Buffer.alloc(0);
			for (;;) {
				const n = fs.readSync(fd, chunk, 0, chunk.length, null);
				if (n === 0) break;
				const hay = Buffer.concat([carry, chunk.subarray(0, n)]);
				needles.forEach((nd, i) => { if (!found.has(i) && hay.indexOf(nd) !== -1) found.add(i); });
				carry = hay.subarray(Math.max(0, hay.length - (maxLen - 1)));
			}
		} finally {
			fs.closeSync(fd);
		}
	}
	return { searched: needles.length, tooShortToSearch: tooShort, remaining: found.size };
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
		const { cleared, removed } = scrub(db);
		db.close();
		const dir = path.dirname(real);
		const files = fs.readdirSync(dir).filter((f) => f === "app.db" || f.startsWith("app.db-")).map((f) => path.join(dir, f));
		const check = { removedValues: removed.length, ...residue(files, removed) };
		console.log(JSON.stringify({ step: "scrub", cleared, check }));
		if (check.remaining) throw new Error(`${check.remaining} removed value(s) are still in the copy's bytes; the copy is not downloaded`);
	} catch (err) {
		console.error(`scrub: ${err.message}`);
		process.exit(1);
	}
}

module.exports = { scrub, residue, isCredentialColumn, words, KEPT_COLUMNS, SECRET_KEY_RE, MIN_SEARCH_LENGTH };
