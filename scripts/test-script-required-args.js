#!/usr/bin/env node
/**
 * Scripts that used to carry a real person or a published password as a default
 * now refuse to run without being told (2026-10-08).
 *
 *   §1 scripts/seed-staging.js gives every seeded account the password in
 *      SEED_STAGING_PASSWORD. It used to hard-code one (a published password,
 *      refresh-env.js lists it); with the variable unset it now exits before
 *      opening any database. With it set, the accounts sign in with it.
 *   §2 scripts/return-driver-loads.js (was return-<a driver's name>-loads.js)
 *      takes the driver as a required argument with no default. Without one it
 *      exits before loading the Google client; with one, its dry run reads the
 *      sheet (a stub here) and writes nothing.
 *   §3 the docs driver-guide storyboard names no driver: it reads the loads of
 *      the account the capture signs in as, and the capture has no default
 *      account and no default demo loads.
 *   §4 the docs driver-video capture has no default account either: without
 *      --user it refuses before any request, and its sign-in beats type the
 *      account it signs in as, never a driver ID or password of their own.
 *
 * Hermetic: each script runs in a child process in a fresh mkdtemp directory;
 * the Google client is a stub preloaded into the child, so nothing reaches the
 * network.
 *   node scripts/test-script-required-args.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const failures = [];
function check(label, cond) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}`);
}

let Database, bcrypt;
try {
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
} catch (e) {
	console.error(`FAILED: a dependency did not load (${e.message}); run it under the .nvmrc Node`);
	process.exit(1);
}

// A script's source, or "" when the file is not there (its checks then fail).
function readSource(...parts) {
	try { return fs.readFileSync(path.join(ROOT, ...parts), "utf8"); } catch { return ""; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-required-args-"));
// The child's environment: this one's, without the variables under test.
function childEnv(extra = {}) {
	const env = { ...process.env, ...extra };
	if (!("SEED_STAGING_PASSWORD" in extra)) delete env.SEED_STAGING_PASSWORD;
	return env;
}
function run(script, args, { cwd = tmp, env = {} } = {}) {
	const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd, env: childEnv(env), encoding: "utf8", timeout: 30_000 });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

try {
	console.log("§1 scripts/seed-staging.js");
	{
		const dir = fs.mkdtempSync(path.join(tmp, "seed-unset-"));
		const r = run("scripts/seed-staging.js", [], { cwd: dir });
		check(`§1 SEED_STAGING_PASSWORD unset: refuses (exit ${r.code}), naming the variable`, r.code === 2 && /SEED_STAGING_PASSWORD/.test(r.out));
		check("§1 …before opening any database (no app.db written)", !fs.existsSync(path.join(dir, "app.db")));
		const blank = run("scripts/seed-staging.js", [], { cwd: dir, env: { SEED_STAGING_PASSWORD: "   " } });
		check(`§1 a blank SEED_STAGING_PASSWORD refuses too (exit ${blank.code})`, blank.code === 2 && !fs.existsSync(path.join(dir, "app.db")));
	}
	{
		const dir = fs.mkdtempSync(path.join(tmp, "seed-set-"));
		const db = new Database(path.join(dir, "app.db"));
		db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, role TEXT,
			driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT DEFAULT '')`);
		db.exec(`CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT, model TEXT, year INTEGER, vin TEXT,
			license_plate TEXT, status TEXT, assigned_driver TEXT, owner_id INTEGER, purchase_price REAL, title_status TEXT,
			maintenance_fund_monthly REAL, insurance_monthly REAL, eld_monthly REAL, hvut_annual REAL, irp_annual REAL,
			driver_pay_daily REAL, admin_fee_pct REAL)`);
		db.close();
		const password = `seed-${Math.random().toString(36).slice(2)}-${Date.now()}`;
		const r = run("scripts/seed-staging.js", [], { cwd: dir, env: { SEED_STAGING_PASSWORD: password } });
		check(`§1 with SEED_STAGING_PASSWORD set: seeds (exit ${r.code})`, r.code === 0);
		const after = new Database(path.join(dir, "app.db"), { readonly: true });
		const users = after.prepare("SELECT username, password_hash FROM users").all();
		after.close();
		check(`§1 …every seeded account signs in with that password (${users.length} accounts)`,
			users.length > 0 && users.every((u) => bcrypt.compareSync(password, u.password_hash)));
		check("§1 …and none with the password the script used to hard-code", users.every((u) => !bcrypt.compareSync("investor123", u.password_hash)));
		check("§1 …and the password is never printed", !r.out.includes(password));
	}
	{
		const src = readSource("scripts", "seed-staging.js");
		check("§1 the script hashes no password literal", !/hashSync\(\s*["'`]/.test(src) && !src.includes("investor123"));
	}

	console.log("§2 scripts/return-driver-loads.js");
	check("§2 the script is scripts/return-driver-loads.js; the old name is gone",
		fs.existsSync(path.join(ROOT, "scripts", "return-driver-loads.js")) &&
		!fs.readdirSync(path.join(ROOT, "scripts")).some((f) => /^return-(?!driver-loads\.js$).*-loads\.js$/.test(f)));
	// A stand-in for googleapis, preloaded into the child: a Job Tracking with one
	// Dispatched load for the named driver. Any write is recorded, never sent.
	const stub = path.join(tmp, "googleapis-stub.js");
	const writes = path.join(tmp, "sheet-writes.json");
	fs.writeFileSync(stub, `"use strict";
const Module = require("module");
const fs = require("fs");
const real = Module._load;
const google = {
	auth: { GoogleAuth: class { async getClient() { return {}; } } },
	sheets: () => ({ spreadsheets: { values: {
		get: async () => ({ data: { values: [["Load ID", "Driver", "Job Status", "Truck", "Owner ID"], ["L-1", "Quinn Testdriver", "Dispatched", "T-9", "7"]] } }),
		batchUpdate: async (req) => { fs.writeFileSync(${JSON.stringify(writes)}, JSON.stringify(req)); return {}; },
	} } }),
};
Module._load = function (request, ...rest) { return request === "googleapis" ? { google } : real.call(this, request, ...rest); };
`);
	const opsEnv = { NODE_OPTIONS: `--require ${JSON.stringify(stub)}` };
	for (const [label, args] of [["no arguments", []], ["only --apply", ["--apply"]], ["a blank name", ["  "]]]) {
		const r = run("scripts/return-driver-loads.js", args, { env: opsEnv });
		check(`§2 ${label}: refuses (exit ${r.code}), naming the missing driver`, r.code === 2 && /name the driver/.test(r.out) && !/Driver "/.test(r.out));
	}
	check("§2 …and writes nothing", !fs.existsSync(writes));
	{
		// The sheet is named too (it has no default; test-sheet-id-required.js).
		const r = run("scripts/return-driver-loads.js", ["Quinn Testdriver"], { env: { ...opsEnv, SPREADSHEET_ID: "sheet-under-test" } });
		check(`§2 a named driver: the dry run lists their Dispatched load and writes nothing (exit ${r.code})`,
			r.code === 0 && /L-1/.test(r.out) && /DRY RUN/.test(r.out) && !fs.existsSync(writes));
	}
	{
		const src = readSource("scripts", "return-driver-loads.js");
		check("§2 the driver has no default", /\|\|\s*""\)\.trim\(\)/.test(src) && !/\|\|\s*"[^"]+"\)\.trim\(\)/.test(src));
	}

	console.log("§3 the docs driver-guide storyboard");
	{
		const src = readSource("scripts", "docs", "driver-guide-storyboard.js");
		check("§3 the storyboard names no driver", !/DRIVER_NAME\s*=/.test(src));
		check("§3 …it reads the loads of the signed-in driver (ctx.driverName)", /async function findLoad\(\{ api, driverName \}/.test(src) && src.includes("encodeURIComponent(driverName)"));
		const runner = readSource("scripts", "docs", "capture-driver-guide.js");
		check("§3 the capture has no default account", /username:\s*arg\("user",\s*""\)/.test(runner));
		check("§3 …and hands each beat the signed-in driver's name", runner.includes("step.before({ api, adminApi, driverName: user.driverName })"));
		// Refused before any request: the base names a port nothing listens on.
		const noUser = run("scripts/docs/capture-driver-guide.js", ["--base=http://127.0.0.1:9"], { cwd: ROOT });
		check(`§3 run without --user: refuses (exit ${noUser.code})`, noUser.code === 1 && /--user=/.test(noUser.out));
		const noLoads = run("scripts/docs/capture-driver-guide.js", ["--base=http://127.0.0.1:9", "--user=qa-test-driver"], { cwd: ROOT });
		check(`§3 run without --load / --load2: refuses (exit ${noLoads.code})`, noLoads.code === 1 && /--load=/.test(noLoads.out));
	}

	console.log("§4 the docs driver-video storyboard");
	{
		const runner = readSource("scripts", "docs", "capture-driver-video.js");
		check("§4 the capture has no default account", /username:\s*arg\("user",\s*""\)/.test(runner));
		const src = readSource("scripts", "docs", "driver-video-storyboard.js");
		check("§4 the storyboard types the signed-in account, no driver ID or password of its own",
			src.includes("h.account.username") && src.includes("h.account.password") && !/LogisX-\d{4}/.test(src) && !/Password123!/.test(src));
		// Refused before any request: the base names a port nothing listens on.
		const outDirs = ["clips", ".raw", "captions"].map((d) => path.join(ROOT, "docs", "driver-video", d));
		const existed = outDirs.filter((d) => fs.existsSync(d));
		const noUser = run("scripts/docs/capture-driver-video.js", ["--base=http://127.0.0.1:9"], { cwd: ROOT });
		check(`§4 run without --user: refuses (exit ${noUser.code})`, noUser.code === 1 && /--user=/.test(noUser.out));
		check("§4 …before writing anything: no output folder created", outDirs.filter((d) => fs.existsSync(d)).length === existed.length);
	}
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
