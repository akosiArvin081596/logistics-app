#!/usr/bin/env node
/**
 * The browser E2E harness keeps its passwords in the macOS Keychain, never in a
 * file (scripts/e2e/keychain.cjs, setup-db.cjs, verify-creds.cjs, e2e.mjs):
 *
 *   §1 setup-db.cjs on a small synthetic database: deletes the old creds files
 *      in the work dir, and leaves alone a file of another tool's that a stray
 *      CREDS_FILE names; stores the five logins' passwords in the Keychain (sent on stdin, never
 *      in any command's arguments) and writes logins.json (0600) with names and
 *      ids only; prints no password; verify-creds.cjs then signs every login
 *      against the copy from the Keychain.
 *   §2 a second copy reuses the same passwords.
 *   §3 loadLogins(): passwords in memory only (not serialized); a logins file
 *      that holds a password is refused; a missing Keychain item is named, not
 *      guessed; an entry may name its own item (a staging login, by service);
 *      only logisx-… items are read or written.
 *
 * Hermetic: a mkdtemp sandbox, and a stand-in `security` (E2E_SECURITY_BIN)
 * that keeps its items in a sandbox file and logs every command's arguments.
 * No real Keychain, no network, no server.
 * Run: node scripts/test-e2e-keychain-logins.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-e2e-keychain.")));
const WORK = path.join(SANDBOX, "work");
fs.mkdirSync(WORK, { mode: 0o700 });
const BIN = path.join(SANDBOX, "bin");
fs.mkdirSync(BIN);
const STORE = path.join(SANDBOX, "keychain.json");
const ARGV_LOG = path.join(SANDBOX, "security-argv.log");

let pass = 0, fail = 0;
function check(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); }
	else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

// A stand-in for macOS's `security`: find / add generic passwords, `-i` reading
// commands from stdin, every invocation's argv logged.
fs.writeFileSync(path.join(BIN, "security"), `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(process.env.FAKE_KEYCHAIN_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const load = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_KEYCHAIN, "utf8")); } catch { return []; } };
const opt = (a, f) => { const i = a.indexOf(f); return i === -1 ? null : a[i + 1]; };
function run(a) {
	if (a[0] === "help") return 0;
	if (a[0] === "find-generic-password") {
		const s = opt(a, "-s"), acct = opt(a, "-a");
		const it = load().find((x) => x.s === s && (acct === null || x.a === acct));
		if (!it) { process.stderr.write("The specified item could not be found in the keychain.\\n"); return 44; }
		if (a.includes("-w")) process.stdout.write(it.w + "\\n");
		return 0;
	}
	if (a[0] === "add-generic-password") {
		const s = opt(a, "-s"), acct = opt(a, "-a"), w = opt(a, "-w");
		const items = load().filter((x) => !(x.s === s && x.a === acct));
		items.push({ s, a: acct, w });
		fs.writeFileSync(process.env.FAKE_KEYCHAIN, JSON.stringify(items));
		return 0;
	}
	return 1;
}
if (process.argv[2] === "-i") {
	let code = 0;
	for (const line of fs.readFileSync(0, "utf8").split("\\n").filter(Boolean)) {
		code = run([...line.matchAll(/"([^"]*)"|(\\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]))) || code;
	}
	process.exit(code);
}
process.exit(run(process.argv.slice(2)));
`, { mode: 0o755 });

// A file of some other tool's, outside the work dir, that a stray CREDS_FILE names.
const OTHER = path.join(SANDBOX, "other-tool-credentials.json");
fs.writeFileSync(OTHER, JSON.stringify({ hostinger: { token: "not-the-harness" } }));
const ENV = {
	...process.env,
	E2E_SECURITY_BIN: path.join(BIN, "security"),
	FAKE_KEYCHAIN: STORE,
	FAKE_KEYCHAIN_LOG: ARGV_LOG,
	E2E_WORK_DIR: WORK,
	APP_DIR: ROOT,
	MAIN_CHECKOUT: ROOT,
	SOURCE_DB: path.join(SANDBOX, "source.db"),
	CREDS_FILE: OTHER,
};
for (const k of ["LOGINS_FILE", "E2E_KEYCHAIN_SERVICE"]) delete ENV[k];
Object.assign(process.env, { E2E_SECURITY_BIN: ENV.E2E_SECURITY_BIN, FAKE_KEYCHAIN: STORE, FAKE_KEYCHAIN_LOG: ARGV_LOG });
for (const k of ["LOGINS_FILE", "CREDS_FILE", "E2E_KEYCHAIN_SERVICE"]) delete process.env[k];

const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
{
	const db = new Database(ENV.SOURCE_DB);
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, driver_name TEXT DEFAULT '',
			email TEXT DEFAULT '', must_change_password INTEGER DEFAULT 0);
		CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, assigned_driver TEXT, photo TEXT);
		CREATE TABLE driver_onboarding (user_id INTEGER, application_id INTEGER, status TEXT);
		CREATE TABLE job_applications (id INTEGER PRIMARY KEY, cdl_front TEXT);
	`);
	const u = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, must_change_password) VALUES (?, ?, 'x', ?, ?, ?)");
	u.run(1, "super_admin", "Super Admin", "", 1);
	u.run(2, "dan.driver", "Driver", "Dan Driver", 0);
	u.run(3, "inv.one", "Investor", "", 0);
	u.run(4, "inv.two", "Investor", "", 0);
	u.run(5, "disp.one", "Dispatcher", "", 0);
	db.prepare("INSERT INTO trucks VALUES (1, 'Dan Driver', 'data:image/png;base64,AAAA')").run();
	db.prepare("INSERT INTO driver_onboarding VALUES (2, 7, 'fully_onboarded')").run();
	db.prepare("INSERT INTO job_applications VALUES (7, 'data:image/png;base64,BBBB')").run();
	db.close();
}

const node = (script, args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "e2e", script), ...args], { encoding: "utf8", env: ENV });
const store = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return []; } };
const ROLES = ["superAdmin", "driver", "investor", "investor2", "dispatcher"];

console.log("§1 setup-db.cjs");
const legacy = path.join(WORK, "creds.json");
const legacyStaging = path.join(WORK, "creds-staging.json");
const notHarness = path.join(WORK, "creds-notes.json");
fs.writeFileSync(legacy, JSON.stringify({ superAdmin: { username: "super_admin", password: "old-file-password-123456" } }), { mode: 0o600 });
fs.writeFileSync(legacyStaging, JSON.stringify({ superAdmin: { username: "e2e_playwright", password: "old-staging-password-1234" } }), { mode: 0o600 });
fs.writeFileSync(notHarness, JSON.stringify({ note: "not a login file" }));
const s1 = node("setup-db.cjs", [path.join(WORK, "qa.db")]);
check(s1.status === 0, "setup-db.cjs makes a copy", `${s1.status} ${(s1.stderr || "").slice(0, 300)}`);
check(!fs.existsSync(legacy) && !fs.existsSync(legacyStaging) && /deleted .*creds\.json/.test(s1.stdout) && /deleted .*creds-staging\.json/.test(s1.stdout),
	"…deleting the old creds files in the work dir, which held passwords", s1.stdout.slice(0, 300));
check(fs.existsSync(OTHER) && fs.existsSync(notHarness) && /left in place: .*other-tool-credentials\.json/.test(s1.stdout),
	"…and leaving alone what is not one: a file of another tool's that CREDS_FILE names, a creds*.json without a login", s1.stdout.slice(0, 300));
const items = store().filter((x) => x.s === "logisx-e2e-local");
const passwords = items.map((x) => x.w);
check(JSON.stringify(items.map((x) => x.a).sort()) === JSON.stringify([...ROLES].sort()) && passwords.every((p) => /^[A-Za-z0-9_-]{24}$/.test(p)),
	"…storing the five logins' passwords in the Keychain (service logisx-e2e-local, one account each)", JSON.stringify(items.map((x) => x.a)));
const loginsPath = path.join(WORK, "logins.json");
const loginsText = fs.existsSync(loginsPath) ? fs.readFileSync(loginsPath, "utf8") : "";
const mode = fs.existsSync(loginsPath) ? fs.statSync(loginsPath).mode & 0o777 : -1;
check(mode === 0o600 && ROLES.every((k) => loginsText.includes(`"${k}"`)) && !/password/i.test(loginsText) && passwords.every((p) => !loginsText.includes(p)),
	"…and writing logins.json (0600) with names and ids only", `mode ${mode.toString(8)}`);
const argvLines = fs.readFileSync(ARGV_LOG, "utf8");
check(passwords.every((p) => !argvLines.includes(p)), "no password ever appears in a `security` command's arguments (stdin only)", "");
check(passwords.every((p) => !s1.stdout.includes(p) && !s1.stderr.includes(p)), "setup-db.cjs prints no password", "");
const v1 = node("verify-creds.cjs", [path.join(WORK, "qa.db")]);
check(v1.status === 0 && (v1.stdout.match(/password matches=true must_change_password=0/g) || []).length === 5 && passwords.every((p) => !v1.stdout.includes(p)),
	"verify-creds.cjs signs all five in against the copy, passwords from the Keychain", `${v1.status} ${(v1.stdout + v1.stderr).slice(0, 300)}`);

console.log("§2 a second copy");
const s2 = node("setup-db.cjs", [path.join(WORK, "qa2.db")]);
const items2 = store().filter((x) => x.s === "logisx-e2e-local");
check(s2.status === 0 && JSON.stringify(items2.map((x) => [x.a, x.w]).sort()) === JSON.stringify(items.map((x) => [x.a, x.w]).sort()),
	"reuses the Keychain's passwords", `${s2.status} ${(s2.stderr || "").slice(0, 200)}`);
const v2 = node("verify-creds.cjs", [path.join(WORK, "qa.db"), path.join(WORK, "qa2.db")]);
check(v2.status === 0, "…so one set of logins signs in on both copies", (v2.stdout + v2.stderr).slice(0, 300));

console.log("§3 loadLogins()");
process.env.E2E_WORK_DIR = WORK;
const keychain = require("./e2e/keychain.cjs");
const loaded = keychain.loadLogins(loginsPath);
const sa = items.find((x) => x.a === "superAdmin");
check(loaded.superAdmin.password === sa.w && !JSON.stringify(loaded).includes(sa.w), "passwords are filled in memory and never serialized", "");
const withPw = path.join(WORK, "with-password.json");
fs.writeFileSync(withPw, JSON.stringify({ superAdmin: { username: "super_admin", password: "in-a-file-123456789" } }));
let refused = "";
try { keychain.loadLogins(withPw); } catch (e) { refused = e.message; }
check(/holds a password/.test(refused) && !refused.includes("in-a-file"), "a logins file that holds a password is refused (without repeating it)", refused);
const missing = path.join(WORK, "missing.json");
fs.writeFileSync(missing, JSON.stringify({ superAdmin: { username: "x", keychain: { service: "logisx-nowhere", account: "x" } } }));
let missingMsg = "";
try { keychain.loadLogins(missing); } catch (e) { missingMsg = e.message; }
check(/no Keychain password for superAdmin \(service logisx-nowhere, account x\)/.test(missingMsg), "a missing Keychain item is named", missingMsg);
keychain.storePassword({ service: "logisx-staging", account: "e2e_playwright" }, "StagingPw-abcdefghijklmnop");
const staging = path.join(WORK, "logins-staging.json");
fs.writeFileSync(staging, JSON.stringify({ superAdmin: { username: "e2e_playwright", keychain: { service: "logisx-staging" } } }));
check(keychain.loadLogins(staging).superAdmin.password === "StagingPw-abcdefghijklmnop", "an entry may name its own Keychain item by service (a staging login)", "");
const foreign = path.join(WORK, "logins-foreign.json");
fs.writeFileSync(foreign, JSON.stringify({ superAdmin: { username: "x", keychain: { service: "some-other-app" } } }));
let foreignMsg = "", foreignStore = "";
try { keychain.loadLogins(foreign); } catch (e) { foreignMsg = e.message; }
try { keychain.storePassword({ service: "some-other-app", account: "x" }, "abcdefghijklmnopqrstuvwx"); } catch (e) { foreignStore = e.message; }
check(/only logisx-/.test(foreignMsg) && /only logisx-/.test(foreignStore), "the harness reads and writes only logisx-… Keychain items", `${foreignMsg} | ${foreignStore}`);

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
