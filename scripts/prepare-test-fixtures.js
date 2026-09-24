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

// The suite's own default (test-suite.js ADMIN_PASS / INVESTOR_PASS) — matching it
// means the caller only has to override usernames, not passwords.
// ⚠️ LOCAL ONLY. This value is published in this repository, so it may only ever
// exist on a database nobody else can reach — which is what the refusals below
// enforce. A refreshed copy never carries it: refresh-env.js gives every account
// its own random secret, and refuses a database on which any account accepts it.
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
// SAFETY. This script writes a password published in this repository. It must
// never touch a deployed database, and those are ALSO called app.db — production's
// at /var/www/logistics-app/app.db, staging's at /var/www/logisx-staging/app.db —
// so the filename proves nothing. Hence an explicit opt-in flag, a refusal on
// NODE_ENV=production, and a refusal on anything under /var/www, judged THREE
// ways, because a path is only one of the names a file has:
//   1. the path as given, resolved lexically — before anything is opened;
//   2. the path with every symlink resolved — a link, or a linked directory,
//      from somewhere innocent into /var/www is the same deployed file;
//   3. the file itself (device + inode) against each deployed database —
//      /var/www/<app>/app.db and any DATABASE_PATH its .env names. A hardlink
//      or a bind mount has no path in /var/www for (2) to find.
// What none of this can see: a copy this script prepares that a server is LATER
// pointed at. Never serve a database this script has touched from anywhere
// reachable.
// ---------------------------------------------------------------------------
const DEPLOYED_ROOT = "/var/www";
const refuse = (...lines) => {
	console.error(`REFUSING: ${lines[0]}`);
	for (const l of lines.slice(1)) console.error(`  ${l}`);
	process.exit(1);
};

// /var/www itself may be a symlink on some hosts, so its resolved form counts too.
const deployedRoots = (() => {
	const roots = [DEPLOYED_ROOT];
	try { const r = fs.realpathSync(DEPLOYED_ROOT); if (!roots.includes(r)) roots.push(r); } catch {}
	return roots;
})();
const isDeployedPath = (p) => deployedRoots.some((root) => p === root || p.startsWith(root + path.sep));

// The one variable of a deployed .env this script cares about. Deliberately
// minimal: it only has to find DATABASE_PATH, never to load anything.
function envDatabasePath(envFile) {
	let text = "";
	try { text = fs.readFileSync(envFile, "utf8"); } catch { return ""; }
	for (const raw of text.split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?DATABASE_PATH\s*=\s*(.*?)\s*$/.exec(raw);
		if (m) return m[1].replace(/^["']|["']$/g, "");
	}
	return "";
}

// Returns the deployed database `p` is the same file as, or null.
function deployedTwin(p) {
	let target;
	try { target = fs.statSync(p); } catch { return null; }
	let apps = [];
	try { apps = fs.readdirSync(DEPLOYED_ROOT); } catch { return null; }   // no /var/www: a dev machine
	for (const app of apps) {
		const dir = path.join(DEPLOYED_ROOT, app);
		const candidates = [path.join(dir, "app.db")];
		const configured = envDatabasePath(path.join(dir, ".env"));
		if (configured) candidates.push(path.resolve(dir, configured));
		for (const c of candidates) {
			try {
				const s = fs.statSync(c);
				if (s.dev === target.dev && s.ino === target.ino) return c;
			} catch {}
		}
	}
	return null;
}

if (isDeployedPath(dbPath)) {
	refuse(`${dbPath} is a deployed path. This script only touches local dev databases.`);
}
if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
	refuse("NODE_ENV=production.");
}
if (!confirmed) {
	refuse("pass --yes-local-db to confirm this is a throwaway local database.", `target would have been: ${dbPath}`);
}
if (!fs.existsSync(dbPath)) {
	console.error(`No database at ${dbPath}`);
	process.exit(1);
}
let realPath;
try { realPath = fs.realpathSync(dbPath); } catch (e) { refuse(`cannot resolve ${dbPath}: ${e.code || e.message}`); }
if (isDeployedPath(realPath)) {
	refuse(`${dbPath} resolves to ${realPath}, a deployed path. This script only touches local dev databases.`);
}
const twin = deployedTwin(realPath);
if (twin) {
	refuse(`${dbPath} is the same file as the deployed database ${twin}. This script only touches local dev databases.`);
}

// Open the RESOLVED path: the file that was judged is the file that is written.
const db = require("better-sqlite3")(realPath);
console.log(`  database: ${realPath}`);

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
const env = Object.entries(chosen).map(([k, v]) => `${k}='${v}'`);
// test-suite.js defaults the admin and investor passwords to this value but has
// NO default for the dispatcher's (test 129 skips without one), so it is spelled
// out here — this is the local database this script just wrote it to.
if (chosen.TEST_DISPATCHER_USER) env.push(`TEST_DISPATCHER_PASS='${PASSWORD}'`);
console.log(`    ${env.join(" \\\n    ")} \\\n    node test-suite.js\n`);
console.log("  The admin and investor passwords are the suite's own default; the dispatcher's is passed above.");
console.log("  Loads come from Google Sheets, so Sheets-dependent tests still need a reachable sheet.");
