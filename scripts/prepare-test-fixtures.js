// scripts/prepare-test-fixtures.js
//
// Makes a LOCAL app.db runnable by test-suite.js, by setting a KNOWN password on the
// accounts that already own the test data.
//
// WHY NOT A TRUNCATE-AND-SEED SCRIPT (which the docs used to promise):
//
//   Loads do not live in app.db. They live in Google Sheets — getJobTrackingCached()
//   reads the live "Job Tracking" range with no fallback, and /api/dashboard,
//   /api/data, /api/investor and the completed-loads export all depend on it.
//
//   So a freshly-seeded investor owns NO loads: their earnings compute to 0,
//   monthlyEarnings comes back empty, and the reconciliation identity the suite
//   asserts (paid + processing + owed + accruing === earned + adjustments +
//   carriedLoss) cannot hold against the payout rows already in the DB. Wiping the DB
//   destroys the very fixture chain the suite needs and cannot rebuild it, because
//   half of that chain is in a spreadsheet.
//
//   The accounts below already have trucks -> drivers -> Sheets loads -> payout rows,
//   wired and reconciled from a production capture. Reusing that chain is the only
//   approach that actually works. All this script does is make them log-in-able.
//
// Usage:
//   node scripts/prepare-test-fixtures.js --yes-local-db
//   node scripts/prepare-test-fixtures.js --yes-local-db /path/to/app.db
//
// It prints the exact command to run the suite with when it finishes.

"use strict";

const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");

// The suite's own default (test-suite.js:64) — matching it means the caller only has
// to override usernames, not passwords.
const PASSWORD = "Password123!";

// Roles the suite needs a session for. Picked by ROLE from whatever the DB actually
// has, rather than hardcoding usernames — this DB is a production capture and the
// cast differs between machines.
const WANTED = [
	{ role: "Super Admin", env: "TEST_ADMIN_USER", prefer: ["super_admin", "ford_seeman"] },
	// johnny.rocks.spirits.llc is the data-rich investor: paid / finalized-unpaid /
	// settled / pending payout rows, which between them cover most of the
	// data-shape skips (tests 55-62, 105-106, 113-117).
	{ role: "Investor", env: "TEST_INVESTOR_USER", prefer: ["johnny.rocks.spirits.llc"] },
	{ role: "Dispatcher", env: "TEST_DISPATCHER_USER", prefer: ["amir_serrano"] },
];

const args = process.argv.slice(2);
const confirmed = args.includes("--yes-local-db");
const dbPath = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(__dirname, "..", "app.db"));

// ---------------------------------------------------------------------------
// SAFETY. This script overwrites password hashes. It must never run against
// production, and the production DB is ALSO called app.db at
// /var/www/logistics-app/app.db — so the filename proves nothing. Hence an explicit
// opt-in flag plus a refusal on the production path and on NODE_ENV=production.
// ---------------------------------------------------------------------------
if (/^\/var\/www\//.test(dbPath)) {
	console.error(`REFUSING: ${dbPath} is a deployed path. This script only touches local dev databases.`);
	process.exit(1);
}
if (process.env.NODE_ENV === "production") {
	console.error("REFUSING: NODE_ENV=production.");
	process.exit(1);
}
if (!confirmed) {
	console.error("REFUSING: pass --yes-local-db to confirm this is a throwaway local database.");
	console.error(`  target would have been: ${dbPath}`);
	process.exit(1);
}
if (!fs.existsSync(dbPath)) {
	console.error(`No database at ${dbPath}`);
	process.exit(1);
}

const db = require("better-sqlite3")(dbPath);
console.log(`  database: ${dbPath}`);

const hash = bcrypt.hashSync(PASSWORD, 10);
const setPw = db.prepare("UPDATE users SET password_hash = ? WHERE id = ?");
const chosen = {};

for (const want of WANTED) {
	const rows = db.prepare("SELECT id, username FROM users WHERE role = ? ORDER BY id").all(want.role);
	if (!rows.length) {
		console.log(`  ${want.role.padEnd(12)} — none in this database, skipping`);
		continue;
	}
	// Prefer a named account (the one with the data), else fall back to the first.
	const pick = want.prefer.map((u) => rows.find((r) => r.username === u)).find(Boolean) || rows[0];
	setPw.run(hash, pick.id);
	chosen[want.env] = pick.username;
	console.log(`  ${want.role.padEnd(12)} -> ${pick.username}  (password set)`);
}

// demo_viewer was removed from production on 2026-08-04: role literally "Super Admin",
// password published in the public repo, gated only by an HTTP-method check. A local
// copy is the same account with the same hole, so clear it out here too.
const demo = db.prepare("SELECT id FROM users WHERE username = 'demo_viewer'").get();
if (demo) {
	db.prepare("DELETE FROM sessions WHERE sess LIKE '%demo_viewer%'").run();
	db.prepare("DELETE FROM users WHERE id = ?").run(demo.id);
	console.log("  demo_viewer  -> deleted (removed from production 2026-08-04)");
}

// The duplicate-detection block (tests 107-110) writes expenses for drivers "test"
// and "test2" on every run. Those rows accumulate — 25 of them had built up here —
// and while the suite's vendor string is now run-unique so they can no longer cause
// a false failure, there is no reason to keep growing the table. Clear them out.
try {
	const n = db.prepare("DELETE FROM expenses WHERE driver IN ('test', 'test2')").run().changes;
	if (n) console.log(`  purged ${n} leftover test-expense row(s)`);
} catch {}

// Sessions cache the user row; stale ones would authenticate against the old hash.
try { db.prepare("DELETE FROM sessions").run(); console.log("  sessions cleared"); } catch {}

console.log("\n  Run the suite with:\n");
const env = Object.entries(chosen).map(([k, v]) => `${k}='${v}'`).join(" \\\n    ");
console.log(`    ${env} \\\n    node test-suite.js\n`);
console.log("  Passwords are all the suite's own default, so only usernames need overriding.");
console.log("  Loads come from Google Sheets, so Sheets-dependent tests still need a reachable sheet.");
