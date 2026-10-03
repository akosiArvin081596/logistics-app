#!/usr/bin/env node
// scripts/test-refresh-automation-account.js — the browser-automation login
// survives a refresh of the copy it lives on, with its password unchanged.
//
// e2e_playwright (scripts/ensure-automation-user.js) exists only on staging;
// the refresh rebuilds staging from a production snapshot, which never has it.
// refresh-env.js's one-pass install (refresh-staging.sh's) carries it over from
// the database it replaces:
//
//   §1 carried: same password hash byte for byte (so the Keychain password
//      still signs in), Super Admin, no forced password change; every other
//      account still accepts nothing known; the copy verifies clean; neither
//      the password nor the hash is printed.
//   §2 not carried when the snapshot has an account of that name (it keeps
//      the refresh's random password), or when it is not a Super Admin in the
//      database being replaced; each is said.
//   §3 a first refresh (no database to replace) installs as before.
//
// Hermetic: a mkdtemp sandbox and the real refresh-env.js. No network.
// Usage: node scripts/test-refresh-automation-account.js [--keep]
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REFRESH = path.join(__dirname, "refresh-env.js");
const KEEP = process.argv.includes("--keep");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-automation-refresh.")));
const STAGING_SHEET = "1Ny1q0nY-sYxgjH_4KqzEdWXUNp8etfW7M-G7h_MNA9Y";
const NAME = "e2e_playwright";

const BASE_ENV = { ...process.env };
delete BASE_ENV.REFRESH_OPERATOR_PASSWORD;
delete BASE_ENV.REFRESH_OPERATOR_USER;
delete BASE_ENV.NODE_ENV;
delete BASE_ENV.SPREADSHEET_ID;

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? "[ok]  " : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function finish() {
	console.log(`\n${pass + fail} assertions · ${fail} failed`);
	if (KEEP) console.log(`scratch kept at ${ROOT}`);
	else fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(fail === 0 ? 0 : 1);
}

const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const priorHash = (u) => "$2a$10$" + ("prior" + u).replace(/[^a-z]/g, "").padEnd(53, "0").slice(0, 53);
const SCHEMA = `
	CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
		role TEXT NOT NULL, email TEXT DEFAULT '', full_name TEXT NOT NULL DEFAULT '', must_change_password INTEGER DEFAULT 0);
	CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
`;
function makeDb(dbPath, accounts) {
	const db = new Database(dbPath);
	db.pragma("journal_mode = DELETE");
	db.exec(SCHEMA);
	const ins = db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?)");
	for (const [id, u, role, hash, mc] of accounts) ins.run(id, u, hash, role, mc || 0);
	db.close();
}
function row(dbPath, username) {
	const db = new Database(dbPath, { readonly: true });
	try { return db.prepare("SELECT * FROM users WHERE username = ?").get(username) || null; } finally { db.close(); }
}
function accepting(dbPath, pw) {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db.prepare("SELECT username, password_hash AS h FROM users ORDER BY id").all()
			.filter((r) => { try { return bcrypt.compareSync(pw, r.h); } catch { return false; } })
			.map((r) => r.username);
	} finally { db.close(); }
}
function refresh(dir, snapshot) {
	const r = spawnSync(process.execPath, [REFRESH, "--from", snapshot, "--to", path.join(dir, "app.db"), "--yes-non-prod"],
		{ encoding: "utf8", env: BASE_ENV });
	return { code: r.status === null ? 1 : r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function target(name, previous) {
	const dir = path.join(ROOT, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, ".env"), `PORT=3912\nSPREADSHEET_ID=${STAGING_SHEET}\nNODE_ENV=development\n`);
	if (previous) makeDb(path.join(dir, "app.db"), previous);
	return dir;
}

// Production's snapshot: no automation account.
const PROD = [
	[1, "admin.one", "Super Admin", priorHash("admin.one")],
	[2, "inv.one", "Investor", priorHash("inv.one")],
	[3, "drv.one", "Driver", priorHash("drv.one")],
];
const snapshot = path.join(ROOT, "snapshot.db");
makeDb(snapshot, PROD);

// The automation password, as the operator's Keychain holds it.
const PW = crypto.randomBytes(18).toString("base64url");
const HASH = bcrypt.hashSync(PW, 4);

console.log("§1 carried over, password unchanged");
{
	const dir = target("carry", [[1, "admin.one", "Super Admin", priorHash("staging-old")], [588, NAME, "Super Admin", HASH, 0]]);
	const r = refresh(dir, snapshot);
	const db = path.join(dir, "app.db");
	const got = r.code === 0 ? row(db, NAME) : null;
	check("the refresh installs", r.code === 0, r.code === 0 ? "" : r.out.split("\n").filter((l) => /REFUS|WARN/.test(l)).join(" | ").slice(0, 300));
	check(`${NAME} is there with the same password hash, as a Super Admin, with no forced change`,
		!!got && got.password_hash === HASH && got.role === "Super Admin" && got.must_change_password === 0, JSON.stringify(got && { role: got.role, same: got.password_hash === HASH }));
	check("…so the Keychain password signs in, and no other account accepts it",
		r.code === 0 && JSON.stringify(accepting(db, PW)) === JSON.stringify([NAME]), r.code === 0 ? JSON.stringify(accepting(db, PW)) : "");
	check("every account from the snapshot still has a new random password",
		r.code === 0 && PROD.every(([, u]) => { const x = row(db, u); return x && x.password_hash !== priorHash(u); }));
	check("the refresh says it carried the account over", /carried over/.test(r.out) && r.out.includes(NAME), "");
	check("…and prints neither the password nor the hash", !r.out.includes(PW) && !r.out.includes(HASH), "");
	const verify = spawnSync(process.execPath, [REFRESH, "--verify", db], { encoding: "utf8", env: BASE_ENV });
	check("the refreshed copy verifies clean", verify.status === 0, `${verify.stdout || ""}${verify.stderr || ""}`.split("\n").filter((l) => /REFUS|leak|survived/i.test(l)).join(" | ").slice(0, 300));
}

console.log("§2 not carried");
{
	const prodWithName = path.join(ROOT, "snapshot-with-name.db");
	makeDb(prodWithName, [...PROD, [9, NAME, "Super Admin", priorHash("prodname")]]);
	const dir = target("snapshot-has-it", [[588, NAME, "Super Admin", HASH, 0]]);
	const r = refresh(dir, prodWithName);
	const got = r.code === 0 ? row(path.join(dir, "app.db"), NAME) : null;
	check("when the snapshot has an account of that name, it keeps the refresh's random password, and the refresh says so",
		r.code === 0 && !!got && got.password_hash !== HASH && got.password_hash !== priorHash("prodname") && /WARNING: .*e2e_playwright/.test(r.out),
		r.code === 0 ? "" : r.out.slice(-300));

	const prodWithVariant = path.join(ROOT, "snapshot-with-variant.db");
	makeDb(prodWithVariant, [...PROD, [9, " E2E_Playwright", "Super Admin", priorHash("prodvariant")]]);
	const dirV = target("snapshot-has-variant", [[588, NAME, "Super Admin", HASH, 0]]);
	const rV = refresh(dirV, prodWithVariant);
	check("…in any case or spacing (sign-in matches the name that way)",
		rV.code === 0 && row(path.join(dirV, "app.db"), NAME) === null && /WARNING: .*e2e_playwright/.test(rV.out), rV.code === 0 ? "" : rV.out.slice(-300));

	const dir2 = target("not-admin", [[588, NAME, "Driver", HASH, 0]]);
	const r2 = refresh(dir2, snapshot);
	check("when it is not a Super Admin in the database being replaced, it is not carried, and the refresh says so",
		r2.code === 0 && row(path.join(dir2, "app.db"), NAME) === null && /WARNING: .*e2e_playwright.*Driver/.test(r2.out),
		r2.code === 0 ? "" : r2.out.slice(-300));
}

console.log("§3 a first refresh");
{
	const dir = target("first", null);
	const r = refresh(dir, snapshot);
	check("with no database to replace, the refresh installs as before (no automation account)",
		r.code === 0 && row(path.join(dir, "app.db"), NAME) === null, r.code === 0 ? "" : r.out.slice(-300));
}

finish();
