#!/usr/bin/env node
// Scratch-DB setup for the browser E2E harness.
//
//   node scripts/e2e/setup-db.cjs <dest.db> [--force]
//
// <dest.db> must be inside the work dir (E2E_WORK_DIR, default $TMPDIR/logisx-e2e):
// the copy is the source database, unsanitized, PII and all.
//
// 1. Takes a PRIVATE copy of SOURCE_DB with SQLite's online backup API, the
//    source opened READ-ONLY (never cp a WAL database).
// 2. Resets the super_admin password on the COPY via the repo's own script
//    (scripts/reset-super-admin-password.js, which also clears the copy's sessions).
// 3. Picks a Driver user whose driver_name matches (case-insensitive) the
//    assigned_driver of exactly one truck with an image photo, who is fully
//    onboarded (so the Kit tab renders) and whose application has an IMAGE
//    cdl_front, and gives that user a random password on the COPY
//    (must_change_password = 0).
// 4. Gives the lowest-id Investor a random password the same way (on the COPY).
// 5. Gives the lowest-id Dispatcher a random password the same way (on the COPY);
//    the E2E's sign-out section (ONLY=signout) signs in as them.
// 6. Writes the logins to CREDS_FILE (chmod 600). Passwords are never printed.
//    An existing creds file's passwords (and driver, when it still qualifies) are
//    reused, so one creds file serves every copy.
//
// Env:
//   SOURCE_DB     source database, opened read-only (default: <main checkout>/app.db)
//   CREDS_FILE    where to write the logins (default: <work dir>/creds.json)
//   E2E_WORK_DIR  the work dir (default: $TMPDIR/logisx-e2e)
//   APP_DIR       checkout whose node_modules + scripts/ are used (see paths.cjs)
"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const paths = require("./paths.cjs");

function fail(msg, code = 2) {
	console.error(`setup-db: ${msg}`);
	process.exit(code);
}

const args = process.argv.slice(2);
const dest = args.find((a) => !a.startsWith("--"));
const force = args.includes("--force");
if (!dest) fail("usage: node scripts/e2e/setup-db.cjs <dest.db> [--force]  (dest inside the work dir)");

paths.warnNodeVersion("setup-db");
let WORK, destAbs, SRC_DB, Database, bcrypt;
try {
	WORK = paths.workDir();
	destAbs = paths.workFile(dest, { mustExist: false });
	SRC_DB = fs.realpathSync(process.env.SOURCE_DB || path.join(paths.mainCheckout(), "app.db"));
	Database = paths.appRequire("better-sqlite3");
	bcrypt = paths.appRequire("bcryptjs");
} catch (e) {
	fail(e.message);
}
const APP_DIR = paths.appDir();
const CREDS_FILE = process.env.CREDS_FILE || path.join(WORK, "creds.json");
if (SRC_DB === destAbs) fail("refusing: the destination is the source database");
console.log(`work dir: ${WORK}`);

function randomPassword() {
	// 24 url-safe chars, >= 16 as the reset script requires.
	return crypto.randomBytes(18).toString("base64url");
}

// Reuse the logins of an existing creds file, so one file serves every scratch
// copy. Passwords are never printed.
let previous = null;
try {
	previous = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8"));
} catch { /* first run */ }

(async () => {
	for (const suffix of ["", "-wal", "-shm"]) {
		const f = destAbs + suffix;
		if (fs.existsSync(f)) {
			if (!force) fail(`refusing: ${f} exists (pass --force to replace it)`);
			fs.unlinkSync(f);
		}
	}

	// ---- 1. backup, source read-only ----
	const src = new Database(SRC_DB, { readonly: true, fileMustExist: true });
	await src.backup(destAbs);
	src.close();
	fs.chmodSync(destAbs, 0o600);
	console.log(`backup: ok (source opened read-only) -> ${destAbs}`);

	// ---- 2. super_admin password via the repo script (on the COPY) ----
	const superPassword = previous?.superAdmin?.password || randomPassword();
	const out = execFileSync(process.execPath, [path.join(APP_DIR, "scripts", "reset-super-admin-password.js"), destAbs], {
		env: { ...process.env, NEW_PASSWORD: superPassword },
		encoding: "utf8",
	});
	console.log("reset-super-admin-password: " + out.split("\n").filter((l) => /^OK|user id=/.test(l.trim())).map((l) => l.trim()).join(" | "));

	const db = new Database(destAbs, { fileMustExist: true });
	const sa = db.prepare("SELECT id, must_change_password FROM users WHERE username = 'super_admin'").get();
	if (sa && sa.must_change_password) {
		db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(sa.id);
		console.log(`super_admin (id ${sa.id}): must_change_password was 1 -> set 0 on the copy`);
	}

	// ---- 3. choose the driver ----
	const candidates = db.prepare(`
		SELECT u.id AS user_id, u.username, u.driver_name, t.id AS truck_id,
		       d.application_id, d.status AS onboarding_status,
		       substr(ja.cdl_front, 1, 30) AS cdl_head,
		       (SELECT COUNT(*) FROM trucks t2 WHERE LOWER(t2.assigned_driver) = LOWER(u.driver_name)) AS trucks_for_name,
		       substr(t.photo, 1, 30) AS photo_head
		FROM users u
		JOIN trucks t ON LOWER(t.assigned_driver) = LOWER(u.driver_name) AND COALESCE(t.photo, '') != ''
		JOIN driver_onboarding d ON d.user_id = u.id AND COALESCE(d.application_id, 0) != 0
		JOIN job_applications ja ON ja.id = d.application_id AND COALESCE(ja.cdl_front, '') != ''
		WHERE u.role = 'Driver' AND COALESCE(u.driver_name, '') != ''
		ORDER BY u.id
	`).all();
	const good = candidates.filter((c) =>
		(!c.onboarding_status || c.onboarding_status === "fully_onboarded") &&
		/^data:image\//.test(c.cdl_head || "") &&
		/^data:image\//.test(c.photo_head || "") &&
		c.trucks_for_name === 1);
	console.log(`candidates: ${candidates.length} joined, ${good.length} fully usable ` +
		`(ids: ${candidates.map((c) => `user ${c.user_id}/truck ${c.truck_id}/app ${c.application_id}/${c.onboarding_status || "no-status"}/${(c.cdl_head || "").slice(5, 15)}`).join("; ")})`);
	if (!good.length) {
		db.close();
		fail("no single driver satisfies every criterion — pick two by hand", 3);
	}
	// Keep the same driver across copies when they still qualify.
	const pick = good.find((c) => c.user_id === previous?.driver?.userId) || good[0];

	// ---- 4. driver password (on the COPY) ----
	const driverPassword = (previous?.driver?.userId === pick.user_id && previous?.driver?.password) || randomPassword();
	const hash = bcrypt.hashSync(driverPassword, 10);
	if (!bcrypt.compareSync(driverPassword, hash)) throw new Error("bcrypt self-check failed");
	const r = db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ? AND role = 'Driver'").run(hash, pick.user_id);
	if (r.changes !== 1) throw new Error(`expected to update 1 driver row, got ${r.changes}`);

	// ---- 5. investor login (on the COPY) ----
	// The Investor with the lowest id. Same treatment as the driver: a bcryptjs
	// hash of a random password and must_change_password = 0, on the copy only.
	// No Investor at all → creds.investor is omitted and the E2E's R8 SKIPs.
	const inv = db.prepare("SELECT id, username FROM users WHERE role = 'Investor' ORDER BY id LIMIT 1").get();
	let investor = null;
	if (!inv) {
		console.log("investor: no user with role 'Investor' — creds.investor omitted (R8 will SKIP)");
	} else {
		const invPassword = (previous?.investor?.userId === inv.id && previous?.investor?.password) || randomPassword();
		const invHash = bcrypt.hashSync(invPassword, 10);
		if (!bcrypt.compareSync(invPassword, invHash)) throw new Error("bcrypt self-check failed (investor)");
		const ri = db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ? AND role = 'Investor'").run(invHash, inv.id);
		if (ri.changes !== 1) throw new Error(`expected to update 1 investor row, got ${ri.changes}`);
		investor = { username: inv.username, password: invPassword, userId: inv.id };
	}

	// ---- 6. dispatcher login (on the COPY) ----
	// The Dispatcher with the lowest id, treated exactly like the Investor: a
	// bcryptjs hash of a random password and must_change_password = 0, on the copy
	// only. No Dispatcher → creds.dispatcher is omitted and the sign-out section's
	// Dispatcher steps (S2a, S3) SKIP.
	const disp = db.prepare("SELECT id, username FROM users WHERE role = 'Dispatcher' ORDER BY id LIMIT 1").get();
	let dispatcher = null;
	if (!disp) {
		console.log("dispatcher: no user with role 'Dispatcher' — creds.dispatcher omitted (S2a and S3 will SKIP)");
	} else {
		const dispPassword = (previous?.dispatcher?.userId === disp.id && previous?.dispatcher?.password) || randomPassword();
		const dispHash = bcrypt.hashSync(dispPassword, 10);
		if (!bcrypt.compareSync(dispPassword, dispHash)) throw new Error("bcrypt self-check failed (dispatcher)");
		const rd = db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ? AND role = 'Dispatcher'").run(dispHash, disp.id);
		if (rd.changes !== 1) throw new Error(`expected to update 1 dispatcher row, got ${rd.changes}`);
		dispatcher = { username: disp.username, password: dispPassword, userId: disp.id };
	}
	db.close();

	const creds = {
		createdAt: new Date().toISOString(),
		dbs: [...new Set([...(previous?.dbs || (previous?.db ? [previous.db] : [])), destAbs])],
		superAdmin: { username: "super_admin", password: superPassword, userId: sa ? sa.id : null },
		driver: {
			username: pick.username,
			password: driverPassword,
			userId: pick.user_id,
			truckId: pick.truck_id,
			applicationId: pick.application_id,
		},
		...(investor ? { investor } : {}),
		...(dispatcher ? { dispatcher } : {}),
	};
	fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
	fs.chmodSync(CREDS_FILE, 0o600);
	console.log(`driver chosen: user id ${pick.user_id}, truck id ${pick.truck_id}, application id ${pick.application_id}`);
	if (investor) console.log(`investor chosen: user id ${investor.userId} (lowest-id Investor)`);
	if (dispatcher) console.log(`dispatcher chosen: user id ${dispatcher.userId} (lowest-id Dispatcher)`);
	console.log(`creds written (0600): ${CREDS_FILE}`);
})().catch((err) => {
	console.error("setup-db: setup failed:", err.message);
	process.exit(1);
});
