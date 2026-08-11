#!/usr/bin/env node
// scripts/test-sanitize-before-transfer.js — prove the sanitize-then-transfer
// flow, offline, against a scratch database of obviously-fake PII.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
//   refresh-local.sh used to copy the production snapshot to a laptop and
//   sanitize it there. The sanitizer was correct; it simply ran after the
//   egress. The fix moves it onto the VPS — and the only honest way to show a
//   redaction happened before a transfer is to run the whole sequence and then
//   look at the bytes that would have crossed the network.
//
//   So this seeds a database with invented SSNs, EINs, routing and account
//   numbers and routable addresses, runs the real script in the real modes, and
//   asserts the emitted artifact holds none of them — by grepping the raw file,
//   which is a check that cannot be satisfied by a bug in the assertions.
//
//   It touches nothing outside its scratch directory. No network, no VPS, no
//   production snapshot, no app.db.
//
// Usage:  node scripts/test-sanitize-before-transfer.js [--keep]
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const SCRIPT = path.join(__dirname, "refresh-env.js");
const KEEP = process.argv.includes("--keep");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-sanitize-test."));

// The node_modules directory this run will use — RESOLVED, never composed.
//
// This was `path.join(__dirname, "..", "node_modules")` at the symlink site,
// which asserts a layout instead of asking Node where its modules actually come
// from. That assertion is false in the ordinary case of a **git worktree**,
// which has no node_modules of its own because dependencies live in the parent
// checkout — so realpathSync threw ENOENT, a bare `catch {}` swallowed it, no
// symlink was made, and the operator met the failure five lines later as
// refresh-env.js's "better-sqlite3 not available — run this from the
// application directory so node_modules resolves" (refresh-env.js:316). That
// message names the wrong cause: the working directory was already correct.
//
// require.resolve() performs the same upward node_modules walk that the shipped
// copy's own `require("better-sqlite3")` will perform, so what gets symlinked is
// the tree that would genuinely have satisfied it. It probes better-sqlite3
// specifically because that is the module refresh-env.js fails on first, and the
// whole DIRECTORY is symlinked rather than the single package because bcryptjs
// (refresh-env.js:322) is required immediately afterwards and has to resolve
// from the same tree.
//
// ⚠️ In a nested git worktree this resolves the PARENT checkout's node_modules,
// including its compiled better-sqlite3 binary. That is what makes this suite
// runnable from a worktree at all, and it is correct while both checkouts want
// the same version — but it does mean the suite can exercise a native build that
// does not correspond to THIS worktree's package.json if the two ever diverge.
// Re-run from the main checkout before trusting a result that hinges on it.
const NODE_MODULES = (() => {
	try { return path.resolve(path.dirname(require.resolve("better-sqlite3/package.json")), ".."); }
	catch { return null; }
})();

// ---------------------------------------------------------------------------
// Invented values. Every one is a documentation/reserved-range placeholder or a
// deliberate impossibility — nothing here corresponds to a real person, account
// or tax id, and nothing was copied from production.
//   555-01xx  NANP reserved fictional
//   .test / .example  RFC 2606 reserved
//   999999999 is not a valid ABA routing number (checksum fails)
// ---------------------------------------------------------------------------
const FAKE = {
	ssnA: "123-45-6789",
	ssnB: "987-65-4321",
	einA: "12-3456789",
	einB: "98-7654321",
	routing: "999999999",
	accountA: "1234567890123",
	accountB: "9876543210987",
	licence: "TX-DL-00998877",
	mailA: "sam.driver@example-carrier.test",
	mailB: "pat.investor@example-fund.test",
	mailC: "chris.applicant@example-mail.test",
	mailD: "outreach.target@example-list.test",
	mailE: "broker.desk@example-broker.test",
	phone: "512-555-0143",
};
const MUST_NOT_SURVIVE = [
	FAKE.ssnA, FAKE.ssnB, FAKE.einA, FAKE.einB, FAKE.routing,
	FAKE.accountA, FAKE.accountB, FAKE.licence,
	FAKE.mailA, FAKE.mailB, FAKE.mailC, FAKE.mailD,
];

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? "[ok]  " : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(n) { console.log(`\n${n}`); }

// One exit path, so an early bail reports exactly like a full run. Sections 4-7
// all read the emitted artifact, so without this a section-3 failure surfaces as
// a raw ENOENT stack trace that buries the [FAIL] lines explaining why.
function finish() {
	console.log("\n" + "-".repeat(74));
	console.log(`${pass + fail} assertions · ${fail} failed`);
	console.log(fail === 0 ? "=== ALL CHECKS PASSED ===" : "=== FAILURES ABOVE ===");
	if (KEEP) console.log(`\nscratch kept at ${ROOT}`);
	else fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(fail === 0 ? 0 : 1);
}

// Runs the real script. Returns {code, out} instead of throwing, because half
// these cases are asserting that it REFUSES.
function run(args, env = {}) {
	try {
		const out = execFileSync(process.execPath, [SCRIPT, ...args], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});
		return { code: 0, out };
	} catch (e) {
		return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
	}
}

// ---------------------------------------------------------------------------
function seedDatabase(dbPath) {
	const Database = require("better-sqlite3");
	const db = new Database(dbPath);
	db.pragma("journal_mode = DELETE");
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, must_change_password INTEGER DEFAULT 0, role TEXT, driver_name TEXT, full_name TEXT);
		CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY, driver_name TEXT, email TEXT, phone TEXT, cell TEXT, address TEXT);
		CREATE TABLE investors (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, ein_ssn TEXT, address TEXT, application_id INTEGER DEFAULT 0);
		CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, email TEXT, phone TEXT, ein_ssn TEXT, address TEXT, access_token TEXT, status TEXT);
		CREATE TABLE investor_outreach_log (id INTEGER PRIMARY KEY, email TEXT, sent_at TEXT);
		CREATE TABLE job_applications (id INTEGER PRIMARY KEY, email TEXT, phone TEXT, cell TEXT, ssn TEXT, dob TEXT, drivers_license TEXT, address TEXT, signature TEXT, deleted_at TEXT);
		CREATE TABLE sheet_job_tracking (id INTEGER PRIMARY KEY, load_id TEXT, email TEXT, phone_number TEXT);
		CREATE TABLE investor_payment_info (id INTEGER PRIMARY KEY, investor_id INTEGER, routing_number TEXT, account_number TEXT, account_name TEXT, bank_name TEXT);
		CREATE TABLE driver_payment_info (id INTEGER PRIMARY KEY, driver TEXT, bank_routing TEXT, bank_account TEXT, bank_acct_name TEXT, bank_name TEXT, bank_address TEXT, bank_phone TEXT, check_name TEXT);
		CREATE TABLE onboarding_documents (id INTEGER PRIMARY KEY, signature_text TEXT);
		CREATE TABLE investor_onboarding_documents (id INTEGER PRIMARY KEY, signature_text TEXT, signature_image TEXT);
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY, driver_name TEXT, latitude REAL, longitude REAL, recorded_at TEXT);
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY, routemate_vehicle_id TEXT, latitude REAL, longitude REAL, speed REAL, dropped_reason TEXT DEFAULT '', geocoded_location TEXT, fetched_at TEXT);
		CREATE TABLE messages (id INTEGER PRIMARY KEY, sender TEXT, body TEXT, created_at TEXT);
		CREATE TABLE audit_trail (id INTEGER PRIMARY KEY, action TEXT, details TEXT, created_at TEXT);
	`);

	db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,?)")
		.run(1, "super_admin", FAKE.mailA, "$2a$10$productionhashthatmustnotsurvive000000000000000000000", "Super Admin");
	db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,?)")
		.run(2, "demo_viewer", FAKE.mailB, "$2a$10$anotherproductionhash0000000000000000000000000000000", "Super Admin");
	db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,?)")
		.run(3, "sam.driver", FAKE.mailC, "$2a$10$thirdproductionhash00000000000000000000000000000000000", "Driver");

	db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("sid-live-1", '{"user":{"id":1,"role":"Super Admin"}}', 99999999);
	db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("sid-live-2", '{"user":{"id":3,"role":"Driver"}}', 99999999);

	db.prepare("INSERT INTO drivers_directory (id,driver_name,email,phone,cell,address) VALUES (?,?,?,?,?,?)")
		.run(1, "Sam Driver", FAKE.mailA, FAKE.phone, FAKE.phone, "12 Real Street, Houston TX 77002");
	db.prepare("INSERT INTO investors (id,name,email,phone,ein_ssn,address) VALUES (?,?,?,?,?,?)")
		.run(1, "Example Fund LLC", FAKE.mailB, FAKE.phone, FAKE.einA, "900 Money Ave, Austin TX 78701");
	db.prepare("INSERT INTO investor_applications (id,email,phone,ein_ssn,address,access_token,status) VALUES (?,?,?,?,?,?,?)")
		.run(1, FAKE.mailB, FAKE.phone, FAKE.einB, "900 Money Ave", "live-bearer-token-must-be-regenerated", "approved");
	db.prepare("INSERT INTO investor_outreach_log (id,email,sent_at) VALUES (?,?,?)").run(1, FAKE.mailD, "2026-08-01");
	db.prepare("INSERT INTO job_applications (id,email,phone,cell,ssn,dob,drivers_license,address,signature) VALUES (?,?,?,?,?,?,?,?,?)")
		.run(1, FAKE.mailC, FAKE.phone, FAKE.phone, FAKE.ssnA, "1985-03-04", FAKE.licence, "5 Applicant Way", "data:image/png;base64,AAAA");
	db.prepare("INSERT INTO job_applications (id,email,ssn,drivers_license,address) VALUES (?,?,?,?,?)")
		.run(2, FAKE.mailC, FAKE.ssnB, FAKE.licence, "6 Applicant Way");
	db.prepare("INSERT INTO sheet_job_tracking (id,load_id,email,phone_number) VALUES (?,?,?,?)")
		.run(1, "562620213", FAKE.mailE, FAKE.phone);
	db.prepare("INSERT INTO investor_payment_info (id,investor_id,routing_number,account_number,account_name,bank_name) VALUES (?,?,?,?,?,?)")
		.run(1, 1, FAKE.routing, FAKE.accountA, "Example Fund LLC", "First Example Bank");
	db.prepare("INSERT INTO driver_payment_info (id,driver,bank_routing,bank_account,bank_acct_name,bank_name,bank_address,bank_phone,check_name) VALUES (?,?,?,?,?,?,?,?,?)")
		.run(1, "Sam Driver", FAKE.routing, FAKE.accountB, "Sam Driver", "Second Example Bank", "1 Bank Plaza", FAKE.phone, "Sam Driver");
	db.prepare("INSERT INTO onboarding_documents (id,signature_text) VALUES (?,?)").run(1, "Sam Driver");
	db.prepare("INSERT INTO investor_onboarding_documents (id,signature_text,signature_image) VALUES (?,?,?)")
		.run(1, "Pat Investor", "data:image/png;base64,BBBB");
	db.prepare("INSERT INTO driver_locations (id,driver_name,latitude,longitude,recorded_at) VALUES (?,?,?,?,?)")
		.run(1, "Sam Driver", 29.76, -95.36, "2026-05-01 10:00:00");

	// Telemetry, so the trim has something to do and the artifact is realistic.
	const tel = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id,latitude,longitude,speed,dropped_reason,geocoded_location,fetched_at) VALUES (?,?,?,?,'',?,?)");
	const many = db.transaction(() => {
		for (let i = 0; i < 4000; i++) {
			const d = new Date(Date.UTC(2026, 7, 8) - i * 3600e3).toISOString().replace("T", " ").slice(0, 19);
			tel.run("veh-33", 29.7 + i / 1e5, -95.3 - i / 1e5, 20, "Houston, TX", d);
		}
	});
	many();

	// The advisory tier: operational content that legitimately contains an
	// address nobody scrubs. This must NOT fail the run, or the refusal becomes
	// routine and then gets bypassed.
	db.prepare("INSERT INTO messages (id,sender,body,created_at) VALUES (?,?,?,?)")
		.run(1, "dispatch", `Rate con is coming from ${FAKE.mailE} — watch for it.`, "2026-08-01");
	db.prepare("INSERT INTO audit_trail (id,action,details,created_at) VALUES (?,?,?,?)")
		.run(1, "note", `broker contact ${FAKE.mailE}`, "2026-08-01");

	db.close();
}

function gzipTo(src, dst) {
	fs.writeFileSync(dst, zlib.gzipSync(fs.readFileSync(src), { level: 6 }));
}
function gunzipToBuffer(p) {
	return /\.gz$/i.test(p) ? zlib.gunzipSync(fs.readFileSync(p)) : fs.readFileSync(p);
}
function writeEnv(dir, lines) {
	fs.writeFileSync(path.join(dir, ".env"), lines.join("\n") + "\n");
}

// ===========================================================================
(function run_all() {
	console.log(`sanitize-before-transfer — scratch root ${ROOT}\n`);

	// PREFLIGHT — say so plainly, before anything looks like a test result.
	// seedDatabase() require()s better-sqlite3 directly on its first line, so
	// without it this suite died on a raw MODULE_NOT_FOUND stack trace three
	// frames deep, which reads like a broken test rather than a missing install.
	// Exits non-zero on purpose: a suite that cannot run has not passed, and a
	// green exit here would let a CI box with no dependencies report success on
	// the assertions that prove PII never leaves the VPS.
	if (!NODE_MODULES) {
		console.log("CANNOT RUN — better-sqlite3 does not resolve from this checkout.");
		console.log("  Run `npm install` here, or in the parent checkout if this is a git worktree.");
		console.log("  Nothing was tested. This is a missing dependency, not a failing assertion.");
		fs.rmSync(ROOT, { recursive: true, force: true });
		process.exit(1);
	}

	// --- fixture -----------------------------------------------------------
	const vps = path.join(ROOT, "vps-backups");
	const laptop = path.join(ROOT, "laptop-checkout");
	fs.mkdirSync(vps); fs.mkdirSync(laptop);

	const rawDb = path.join(vps, "app.db.20260809_020001");
	seedDatabase(rawDb);
	const snapshot = `${rawDb}.gz`;
	gzipTo(rawDb, snapshot);
	fs.unlinkSync(rawDb);
	console.log(`fixture: ${path.basename(snapshot)} (${(fs.statSync(snapshot).size / 1024).toFixed(0)} KiB gz), ${MUST_NOT_SURVIVE.length} planted secrets\n`);

	const GOOD_ENV = [
		"PORT=3011",
		"SPREADSHEET_ID=156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0",
		"NODE_ENV=development",
	];
	writeEnv(laptop, GOOD_ENV);
	const target = path.join(laptop, "app.db");

	// =======================================================================
	section("1. The planted secrets are really in the snapshot");
	{
		const raw = gunzipToBuffer(snapshot).toString("latin1");
		const missing = MUST_NOT_SURVIVE.filter((s) => !raw.includes(s));
		check("every planted secret is present before sanitizing", missing.length === 0,
			missing.length ? `absent: ${missing.join(", ")}` : `${MUST_NOT_SURVIVE.length}/${MUST_NOT_SURVIVE.length} found`);
		const v = run(["--verify", snapshot]);
		check("--verify calls the RAW snapshot unsanitized (the assertions can fail)", v.code === 1,
			v.code === 1 ? `exit 1, ${(v.out.match(/^ {11}\d+ /gm) || []).length} findings` : `exit ${v.code}`);
	}

	// =======================================================================
	section("2. Gates still refuse — and refuse BEFORE anything is copied");
	{
		const ok = run(["--check-env-only", "--to", target]);
		check("passes on a correct non-production .env", ok.code === 0, `exit ${ok.code}`);

		writeEnv(laptop, ["PORT=3011", "SPREADSHEET_ID=1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"]);
		const prodSheet = run(["--check-env-only", "--to", target]);
		check("refuses a PRODUCTION SPREADSHEET_ID", prodSheet.code === 1 && /PRODUCTION sheet/.test(prodSheet.out));

		writeEnv(laptop, ["PORT=3011"]);
		const noSheet = run(["--check-env-only", "--to", target]);
		check("refuses a MISSING SPREADSHEET_ID", noSheet.code === 1 && /no SPREADSHEET_ID/.test(noSheet.out));

		writeEnv(laptop, [...GOOD_ENV, "GMAIL_USER=info@logisx.com", "GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx"]);
		const mail = run(["--check-env-only", "--to", target]);
		check("refuses a mail-capable .env", mail.code === 1 && /GMAIL_USER and GMAIL_APP_PASSWORD/.test(mail.out));

		writeEnv(laptop, [...GOOD_ENV, "INVOICE_AUTOGEN_ENABLED=true"]);
		const money = run(["--check-env-only", "--to", target]);
		check("refuses INVOICE_AUTOGEN_ENABLED=true", money.code === 1 && /INVOICE_AUTOGEN_ENABLED=true/.test(money.out));

		// The property that makes ordering meaningful: check-env-only cannot read
		// or write a database at all, so a refusal is structurally incapable of
		// having moved data first.
		const before = fs.readdirSync(laptop).sort().join(",");
		writeEnv(laptop, GOOD_ENV);
		run(["--check-env-only", "--to", target]);
		check("check-env-only creates nothing", fs.readdirSync(laptop).sort().join(",") === before);
	}

	// =======================================================================
	section("3. Sanitize on the 'VPS' — module resolution via a symlink, as the flow does");
	let artifact;
	{
		const remoteTmp = path.join(ROOT, "vps-tmp");
		fs.mkdirSync(remoteTmp, { mode: 0o700 });
		// Exactly what refresh-local.sh does: ship the script, symlink the app's
		// node_modules beside it, run from there. This proves the resolution
		// mechanism, not just the sanitizing.
		fs.copyFileSync(SCRIPT, path.join(remoteTmp, "refresh-env.js"));

		// NODE_MODULES is resolved, not composed — see the comment on its
		// definition for why, and for the git-worktree caveat. The preflight has
		// already established that it is non-null, so a failure here is a real
		// symlink failure (EEXIST, EPERM, a read-only scratch dir) and is reported
		// as itself rather than swallowed into the misleading "run this from the
		// application directory" message the next check would otherwise print.
		try {
			fs.symlinkSync(NODE_MODULES, path.join(remoteTmp, "node_modules"), "dir");
		} catch (e) {
			console.log(`  [skip] no node_modules symlink — symlinking ${NODE_MODULES} failed: ${e.code || e.message}.`);
			console.log("         The next check will report \"better-sqlite3 not available\"; the cause is THIS, not a wrong working directory.");
		}
		artifact = path.join(remoteTmp, "sanitized.db.gz");

		// Invoked as the SHIPPED copy, from its own directory, with no NODE_PATH:
		// if the symlink mechanism did not work this exits non-zero on
		// "better-sqlite3 not available".
		const shipped = (() => {
			try {
				const out = execFileSync(process.execPath, [path.join(remoteTmp, "refresh-env.js"),
					"--sanitize-only", "--from", snapshot, "--emit", artifact, "--telemetry-days", "45"],
					{ encoding: "utf8", cwd: remoteTmp, stdio: ["ignore", "pipe", "pipe"] });
				return { code: 0, out };
			} catch (e) { return { code: e.status || 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
		})();
		check("sanitize-only runs from a temp dir with only a node_modules symlink", shipped.code === 0,
			shipped.code === 0 ? "" : shipped.out.split("\n").slice(-4).join(" | "));
		check("an artifact was emitted", fs.existsSync(artifact),
			fs.existsSync(artifact) ? `${(fs.statSync(artifact).size / 1024).toFixed(0)} KiB gz` : "");
		if (fs.existsSync(artifact)) {
			check("artifact is mode 600", (fs.statSync(artifact).mode & 0o777) === 0o600,
				"0" + (fs.statSync(artifact).mode & 0o777).toString(8));
		}
		const leftovers = fs.readdirSync(remoteTmp).filter((f) => /\.tmp$|\.partial$|-wal$|-shm$/.test(f));
		check("no working copy left behind on the 'VPS'", leftovers.length === 0, leftovers.join(", "));
	}

	// Every section below reads the artifact section 3 emitted. If it is not
	// there, stop and let the [FAIL] lines above be the last word — the previous
	// shape threw a raw ENOENT here, which scrolled the real explanation off the
	// screen and made a missing dependency look like a broken test.
	if (!fs.existsSync(artifact)) {
		console.log("\nNo artifact was emitted, so the remaining sections cannot run. See the failures above.");
		finish();
	}

	// =======================================================================
	section("4. The bytes that would cross the network");
	{
		const raw = gunzipToBuffer(artifact).toString("latin1");
		const survivors = MUST_NOT_SURVIVE.filter((s) => raw.includes(s));
		check("ZERO planted SSN / EIN / routing / account / licence / address values survive",
			survivors.length === 0, survivors.length ? `SURVIVED: ${survivors.join(", ")}` : `0 of ${MUST_NOT_SURVIVE.length}`);

		// Independent of the planted list: any string of the shape at all.
		const ssnShaped = raw.match(/\b\d{3}-\d{2}-\d{4}\b/g) || [];
		check("no SSN-shaped string anywhere in the artifact", ssnShaped.length === 0,
			ssnShaped.length ? `${ssnShaped.length} match(es)` : "0 matches");

		const mails = (raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*[A-Za-z0-9]\.[A-Za-z]{2,}/g) || [])
			.filter((m) => !/@invalid$/i.test(m) && !/@example-broker\.test$/i.test(m));
		check("no routable address outside the operational free-text tier", mails.length === 0,
			mails.length ? `${[...new Set(mails)].slice(0, 3).join(", ")}` : "0");

		check("the old bearer token is gone", !raw.includes("live-bearer-token-must-be-regenerated"));
		check("production password hashes are gone", !raw.includes("productionhashthatmustnotsurvive"));
	}

	// =======================================================================
	section("5. --verify agrees, and the two tiers behave differently on the SAME file");
	{
		// The fixture deliberately keeps one operational broker address in a
		// message body and an audit note — columns nothing scrubs, where such a
		// value is ordinary content. That is the whole reason the free-text sweep
		// is advisory: if it refused here, the refusal would be routine on real
		// data and would be flagged away within a week.
		const v = run(["--verify", artifact]);
		check("--verify passes the artifact", v.code === 0, v.code === 0 ? "" : v.out.split("\n").slice(-3).join(" | "));
		check("…while still REPORTING the operational free-text it found",
			/free-text scan — messages\.body/.test(v.out) && /free-text scan — audit_trail\.details/.test(v.out),
			"seen and deliberately not fatal");

		const s = run(["--verify", artifact, "--strict-scan"]);
		check("--strict-scan promotes exactly those advisories to a refusal",
			s.code === 1 && /messages\.body/.test(s.out) && /audit_trail\.details/.test(s.out), `exit ${s.code}`);
		const strictFindings = s.out.match(/\bvalue\(s\) matching\b/g) || [];
		check("…and names nothing else (no scrubbed column leaked into the strict tier)",
			strictFindings.length === 2, `${strictFindings.length} finding(s)`);
	}

	// =======================================================================
	section("6. Install refuses a dirty artifact, accepts a clean one");
	{
		writeEnv(laptop, GOOD_ENV);
		// Feed the RAW snapshot to the install path pretending it is sanitized:
		// this is the "the remote pass silently did not run" scenario.
		const dirty = run(["--from", snapshot, "--to", target, "--from-sanitized", "--yes-non-prod"]);
		check("--from-sanitized REFUSES an unsanitized artifact", dirty.code === 1 && /NOT sanitized/.test(dirty.out));
		check("…and installs nothing", !fs.existsSync(target));

		const good = run(["--from", artifact, "--to", target, "--from-sanitized", "--yes-non-prod"]);
		check("--from-sanitized installs the clean artifact", good.code === 0,
			good.code === 0 ? "" : good.out.split("\n").slice(-3).join(" | "));
		check("app.db exists at the target", fs.existsSync(target),
			fs.existsSync(target) ? `${(fs.statSync(target).size / 1048576).toFixed(1)} MB` : "");
		const sidecars = fs.readdirSync(laptop).filter((f) => /-wal$|-shm$|\.tmp$/.test(f));
		check("no orphaned -wal / -shm / .tmp beside the installed database", sidecars.length === 0, sidecars.join(", "));

		const installed = run(["--verify", target]);
		check("the INSTALLED database verifies clean", installed.code === 0);
	}

	// =======================================================================
	section("7. The new source/target gates");
	{
		const live = run(["--sanitize-only", "--from", "/var/www/logistics-app/app.db", "--emit", path.join(ROOT, "x.gz")]);
		check("refuses --from the LIVE production app.db", live.code === 1 && /LIVE production database/.test(live.out));

		const intoProd = run(["--sanitize-only", "--from", snapshot, "--emit", "/var/www/logistics-app/backups/x.gz"]);
		check("refuses --emit into the production application directory",
			intoProd.code === 1 && /production application directory/.test(intoProd.out));

		const same = run(["--sanitize-only", "--from", snapshot, "--emit", snapshot]);
		check("refuses --from and --emit being the same file", same.code === 1 && /same file/.test(same.out));
	}

	// =======================================================================
	section("8. Regression: the ORIGINAL one-pass path still works (refresh-staging.sh uses it)");
	{
		// Staging's source and target share a filesystem, so nothing crosses a
		// network and it keeps `--from <snapshot> --to <app.db>`. The gate
		// restructuring above must not have touched it.
		const staging = path.join(ROOT, "staging");
		fs.mkdirSync(staging);
		writeEnv(staging, ["PORT=3003", "SPREADSHEET_ID=1Ny1q0nY-sYxgjH_4KqzEdWXUNp8etfW7M-G7h_MNA9Y", "NODE_ENV=development"]);
		const sTarget = path.join(staging, "app.db");

		const noOptIn = run(["--from", snapshot, "--to", sTarget]);
		check("still refuses without --yes-non-prod", noOptIn.code === 1 && /--yes-non-prod/.test(noOptIn.out));

		const prodDir = run(["--from", snapshot, "--to", "/var/www/logistics-app/app.db", "--yes-non-prod"]);
		check("still refuses --to the production application directory",
			prodDir.code === 1 && /production application directory/.test(prodDir.out));

		const r = run(["--from", snapshot, "--to", sTarget, "--yes-non-prod", "--telemetry-days", "45"]);
		check("one-pass sanitize+install succeeds", r.code === 0,
			r.code === 0 ? "" : r.out.split("\n").slice(-3).join(" | "));
		check("it sanitized (not just copied)", fs.existsSync(sTarget) && run(["--verify", sTarget]).code === 0);
		check("it reported the target sheet as non-production", /target sheet: 1Ny1q0nY/.test(r.out));

		const dry = run(["--from", snapshot, "--to", sTarget, "--yes-non-prod", "--dry-run"]);
		check("--dry-run still leaves the target alone",
			dry.code === 0 && /work file discarded/.test(dry.out) &&
			fs.readdirSync(staging).filter((f) => /\.tmp$/.test(f)).length === 0);
	}

	// =======================================================================
	finish();
})();
