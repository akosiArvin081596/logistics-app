// Check that the creds file's logins match the password hashes in a scratch DB.
// Prints booleans and ids only — never a password.
//   node scripts/e2e/verify-creds.cjs <scratch-db> [<scratch-db> ...]
// Every DB must be inside the work dir. CREDS_FILE defaults to <work dir>/creds.json.
"use strict";
const path = require("path");
const fs = require("fs");
const paths = require("./paths.cjs");

paths.warnNodeVersion("verify-creds");
let Database, bcrypt, CREDS_FILE;
try {
	Database = paths.appRequire("better-sqlite3");
	bcrypt = paths.appRequire("bcryptjs");
	CREDS_FILE = process.env.CREDS_FILE || path.join(paths.workDir(), "creds.json");
} catch (e) {
	console.error(`verify-creds: ${e.message}`);
	process.exit(2);
}
if (!process.argv[2]) {
	console.error("usage: node scripts/e2e/verify-creds.cjs <scratch-db> [<scratch-db> ...]");
	process.exit(2);
}
const creds = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
// The investor, investor2 and dispatcher logins are optional (none of that role in the DB → none in the creds file).
const logins = [
	["superAdmin", creds.superAdmin],
	["driver", creds.driver],
	...(creds.investor ? [["investor", creds.investor]] : []),
	...(creds.investor2 ? [["investor2", creds.investor2]] : []),
	...(creds.dispatcher ? [["dispatcher", creds.dispatcher]] : []),
];
if (!creds.investor) console.log("(the creds file has no investor login — R8 will SKIP)");
if (!creds.investor2) console.log("(the creds file has no second investor login — M1 will SKIP)");
if (!creds.dispatcher) console.log("(the creds file has no dispatcher login — S2a, S3, S5b, S7 and D1-D3 will SKIP)");
let ok = true;
for (const arg of process.argv.slice(2)) {
	let dbPath;
	try { dbPath = paths.workFile(arg); } catch (e) { console.error(`skip: ${e.message}`); ok = false; continue; }
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	for (const [who, c] of logins) {
		const u = db.prepare("SELECT id, role, password_hash, must_change_password FROM users WHERE username = ?").get(c.username);
		const match = !!u && bcrypt.compareSync(c.password, u.password_hash || "");
		console.log(`${path.basename(dbPath)} ${who}: user id ${u ? u.id : "-"} role ${u ? u.role : "-"} password matches=${match} must_change_password=${u ? u.must_change_password : "-"}`);
		if (!match || (u && u.must_change_password)) ok = false;
	}
	db.close();
}
process.exit(ok ? 0 : 1);
