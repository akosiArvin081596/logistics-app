#!/usr/bin/env node
/**
 * scripts/test-drug-test-guard.js — uploads/onboarding/ holds DRUG TEST RESULTS.
 *
 * Closes an access-control gap the repo's own audit recorded as open: the tree
 * was served by the authenticated /uploads static mount with NO guard, on the
 * argument that `drug-test-${userId}-${Date.now()}.<ext>` is unguessable. That
 * argument was only ever about the filename, and the comment making it named its
 * own escape condition — "a listing endpoint that hands the url to a Driver".
 * That condition was already met: GET /api/onboarding/:userId did SELECT * (which
 * carries drug_test_file_url) and fenced only the Driver role, so an Investor
 * could walk the id space and harvest every result URL without guessing anything.
 *
 * ⚠️ THIS GUARD IS THE ONE THAT DENIES THE OWNER. Every sibling guard lets a
 * driver read their own document; here that is the case to refuse, because
 * server.js states it as a legal requirement and the main driver payload already
 * strips the three drug_test_* columns.
 *
 * guardDrugTestFile is a hoisted declaration inside server.js, so it is LIFTED
 * from source and run against an in-memory SQLite — the same technique
 * scripts/test-db-export-guard.js uses for requireRole. Only the database is a
 * fixture; the decision under test is shipped code.
 *
 * DISCRIMINATION: every protective clause is also run against a mutant build with
 * that clause removed, and the matching assertion is required to flip. A guard
 * test that still passes against a defanged guard is worse than none.
 *
 * Run: node scripts/test-drug-test-guard.js
 */

"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const Database = require("better-sqlite3");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.error(`FAIL  ${name}`); }
};

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function liftFn(name) {
	const a = src.indexOf(`function ${name}(`);
	if (a < 0) { console.error(`FAIL  could not locate ${name} in server.js`); process.exit(1); }
	let depth = 0, seen = false;
	for (let i = src.indexOf("{", a); i < src.length; i++) {
		if (src[i] === "{") { depth++; seen = true; }
		else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}

const GUARD_SRC = liftFn("guardDrugTestFile");
ok("lifted guardDrugTestFile from server.js", GUARD_SRC.length > 200);

// ---- the fixture DB: one real row, one orphaned file ----------------------
const db = new Database(":memory:");
db.exec(`CREATE TABLE driver_onboarding (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL UNIQUE,
	drug_test_file_url TEXT DEFAULT ''
);`);
const OWNED = "/uploads/onboarding/drug-test-110-1788000000000.pdf";
db.prepare("INSERT INTO driver_onboarding (user_id, drug_test_file_url) VALUES (?, ?)").run(110, OWNED);

const build = (body) => new Function("db", "auditConfidentialRead", body + "\nreturn guardDrugTestFile;");
const audits = [];
const makeGuard = (body) => build(body)(db, (req, entity, id, label) => audits.push({ entity, id, label }));

/** Drive the guard and report what it decided. */
function decide(guard, role, url, userId = 1) {
	let status = null, nexted = false;
	const res = { status(c) { status = c; return this; }, end() { return this; } };
	const req = { session: { user: { role, id: userId, driverName: "Howard Reddie" } } };
	guard(req, res, () => { nexted = true; }, url, url.split("/").pop());
	return { status, nexted };
}

const guard = makeGuard(GUARD_SRC);

// ---- who may read --------------------------------------------------------
ok("Super Admin may read a real drug test", decide(guard, "Super Admin", OWNED).nexted === true);
ok("Dispatcher may read a real drug test", decide(guard, "Dispatcher", OWNED).nexted === true);

// The whole point of this guard, and the inversion of every sibling.
const ownerTry = decide(guard, "Driver", OWNED, 110);
ok("⚠️ the OWNING driver is REFUSED (legal requirement)", ownerTry.nexted === false && ownerTry.status === 404);
ok("another driver is refused", decide(guard, "Driver", OWNED, 999).nexted === false);
ok("an Investor is refused — the role that could harvest URLs", decide(guard, "Investor", OWNED, 42).nexted === false);

// ---- what it refuses -----------------------------------------------------
ok("an unknown file 404s (orphans fail closed)",
	decide(guard, "Super Admin", "/uploads/onboarding/drug-test-999-1.pdf").status === 404);
ok("refusal is 404, never 403 — a 403 confirms the test exists",
	decide(guard, "Driver", OWNED, 110).status === 404);
ok("a mixed-case filename finds no row and 404s",
	decide(guard, "Super Admin", OWNED.replace("drug-test", "DRUG-TEST")).status === 404);

// ---- the audit row -------------------------------------------------------
audits.length = 0;
decide(guard, "Super Admin", OWNED);
ok("a served read writes an audit row (super_admin is a SHARED login)",
	audits.length === 1 && audits[0].entity === "driver_onboarding" && audits[0].id === 110);
audits.length = 0;
decide(guard, "Driver", OWNED, 110);
ok("a REFUSED read writes no audit row", audits.length === 0);

// ---- wiring --------------------------------------------------------------
const listed = /\{\s*dir:\s*"\/onboarding\/",\s*guard:\s*guardDrugTestFile\s*\}/.test(src);
ok("registered in GUARDED_UPLOAD_DIRS", listed);
ok("⚠️ the trailing slash is present — without it the entry also swallows " +
	"/onboarding-signed/ and /onboarding-templates/",
	/dir:\s*"\/onboarding\/"/.test(src) && !/dir:\s*"\/onboarding"/.test(src));
ok("uses .all(), not .get() — drug_test_file_url has no unique index",
	/\.all\(/.test(GUARD_SRC) && !/\.get\(/.test(GUARD_SRC));

// ---- DISCRIMINATION: defang each clause, require the assertion to flip ----
const mutantOwnerAllowed = makeGuard(
	GUARD_SRC.replace('if (user.role === "Super Admin" || user.role === "Dispatcher") {',
		'if (true) {'));
ok("MUTANT: allowing everyone makes the owner-refused assertion fail",
	decide(mutantOwnerAllowed, "Driver", OWNED, 110).nexted === true);

const mutantNoRowCheck = makeGuard(GUARD_SRC.replace("if (!rows.length) return res.status(404).end();", ""));
// Defanged, the unknown-file case stops being a clean 404 — it either falls
// through to next() or throws on rows[0]. Either way the clause was load-bearing;
// asserting "not a clean 404" covers both without pinning which.
let mutantClean404 = false;
try {
	mutantClean404 = decide(mutantNoRowCheck, "Super Admin", "/uploads/onboarding/drug-test-999-1.pdf").status === 404;
} catch { mutantClean404 = false; }
ok("MUTANT: dropping the row check stops an unknown file being cleanly refused", mutantClean404 === false);

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
