#!/usr/bin/env node
/**
 * The browser E2E harness builds its database from made-up data by default
 * (scripts/e2e/setup-db.cjs, scripts/e2e/seed-made-up.cjs); real data is copied
 * only when SOURCE_DB names a database under ~/LogisX-replica/.
 *
 *   §1 no SOURCE_DB: no database outside the work dir is ever opened (a decoy
 *      app.db sits in the main checkout, where the old default copied from); the
 *      schema comes from booting the checkout's server.js on an empty file with
 *      boot-server.sh (here a stub server.js that answers the routes the seed
 *      uses); the five logins (Super Admin, Driver, investor, investor2,
 *      Dispatcher) exist on made-up names only, their passwords in the Keychain,
 *      and verify-creds.cjs signs each in; the driver has the truck with an image
 *      photo (a JPEG), an application with an image cdl_front (a well-formed PNG)
 *      and is fully onboarded; the seed server is stopped and its Sheets
 *      copy removed.
 *   §1b a second made-up database reuses the Keychain's passwords.
 *   §1c a seed server that never gets ready is stopped: no server, no pid file.
 *   §2 a SOURCE_DB inside a checkout or worktree is refused, even under
 *      ~/LogisX-replica/, and so is one outside ~/LogisX-replica/: nothing is
 *      written.
 *   §3 a SOURCE_DB under ~/LogisX-replica/ is copied (a made-up database stands
 *      in for one there: HOME points into this test's sandbox).
 *   §4 payout-parity.mjs has no SOURCE_DB default and refuses one by the same rule.
 *
 * Hermetic: a mkdtemp sandbox for HOME, the work dir, the checkouts and the
 * Keychain (a stand-in `security`, E2E_SECURITY_BIN). No real database, no real
 * Keychain, no network beyond 127.0.0.1.
 * Run: node scripts/test-e2e-made-up-seed.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "logisx-e2e-madeup.")));
fs.chmodSync(SANDBOX, 0o700);
const WORK = path.join(SANDBOX, "work");
fs.mkdirSync(WORK, { mode: 0o700 });
const HOME = path.join(SANDBOX, "home");
const REPLICA = path.join(HOME, "LogisX-replica");
fs.mkdirSync(REPLICA, { recursive: true });
const BIN = path.join(SANDBOX, "bin");
fs.mkdirSync(BIN);
const STORE = path.join(SANDBOX, "keychain.json");
const OPEN_LOG = path.join(SANDBOX, "opened.log");

process.on("exit", () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

let pass = 0, fail = 0;
function ok(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); }
	else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	ok(g === w, label, `got ${g}, want ${w}`);
}

// A stand-in for macOS's `security` (find / add generic passwords; `-i` reads commands from stdin).
fs.writeFileSync(path.join(BIN, "security"), `#!/usr/bin/env node
const fs = require("fs");
const load = () => { try { return JSON.parse(fs.readFileSync(process.env.FAKE_KEYCHAIN, "utf8")); } catch { return []; } };
const opt = (a, f) => { const i = a.indexOf(f); return i === -1 ? null : a[i + 1]; };
function run(a) {
	if (a[0] === "help") return 0;
	if (a[0] === "find-generic-password") {
		const s = opt(a, "-s"), acct = opt(a, "-a");
		const it = load().find((x) => x.s === s && (acct === null || x.a === acct));
		if (!it) return 44;
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

// Preloaded into setup-db.cjs: logs the file of every better-sqlite3 database it opens.
const SPY = path.join(SANDBOX, "open-spy.cjs");
fs.writeFileSync(SPY, `
const fs = require("fs");
const Module = require("module");
const load = Module._load;
let wrapped = null;
Module._load = function (request, ...rest) {
	const m = load.call(this, request, ...rest);
	if (request !== "better-sqlite3") return m;
	if (!wrapped) {
		wrapped = function Database(file, opts) {
			fs.appendFileSync(process.env.E2E_OPEN_LOG, JSON.stringify(String(file)) + "\\n");
			return new m(file, opts);
		};
		wrapped.prototype = m.prototype;
	}
	return wrapped;
};
`);

const Database = require("better-sqlite3");
// A made-up database with a Driver who qualifies for the copy's picks, marked so a
// copy of it is recognizable.
function madeUpSourceDb(file, marker) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const db = new Database(file);
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT, driver_name TEXT DEFAULT '',
			email TEXT DEFAULT '', must_change_password INTEGER DEFAULT 0);
		CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, assigned_driver TEXT, photo TEXT);
		CREATE TABLE driver_onboarding (user_id INTEGER, application_id INTEGER, status TEXT);
		CREATE TABLE job_applications (id INTEGER PRIMARY KEY, cdl_front TEXT);
	`);
	const u = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', ?, ?)");
	u.run(1, "super_admin", "Super Admin", "");
	u.run(2, `${marker}-driver`, "Driver", `${marker} Driver`);
	u.run(3, `${marker}-inv1`, "Investor", "");
	u.run(4, `${marker}-inv2`, "Investor", "");
	u.run(5, `${marker}-disp`, "Dispatcher", "");
	db.prepare("INSERT INTO trucks VALUES (1, ?, 'data:image/png;base64,AAAA')").run(`${marker} Driver`);
	db.prepare("INSERT INTO driver_onboarding VALUES (2, 7, 'fully_onboarded')").run();
	db.prepare("INSERT INTO job_applications VALUES (7, 'data:image/png;base64,BBBB')").run();
	db.close();
}

// The main checkout, with a decoy app.db where the old default copied from.
const MAIN = path.join(SANDBOX, "main");
madeUpSourceDb(path.join(MAIN, "app.db"), "decoy");

// The checkout whose server.js builds the schema: a stub that creates the tables
// the seed writes and answers the routes it calls, as server.js does.
const SEED_WT = path.join(SANDBOX, "seed-wt");
fs.mkdirSync(SEED_WT);
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(SEED_WT, "node_modules"));
fs.writeFileSync(path.join(SEED_WT, "server.js"), `
const http = require("http");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const db = new Database(process.env.DATABASE_PATH);
db.exec(\`
	CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
		role TEXT NOT NULL, driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT DEFAULT '',
		must_change_password INTEGER DEFAULT 1);
	CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
	CREATE TABLE IF NOT EXISTS trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL, make TEXT, model TEXT,
		assigned_driver TEXT DEFAULT '', photo TEXT DEFAULT '', notes TEXT DEFAULT '');
	CREATE TABLE IF NOT EXISTS job_applications (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, email TEXT NOT NULL,
		phone TEXT NOT NULL, dob TEXT NOT NULL, address TEXT NOT NULL, ssn TEXT NOT NULL, drivers_license TEXT NOT NULL,
		position TEXT NOT NULL, experience TEXT NOT NULL, has_cdl TEXT NOT NULL, work_authorized TEXT NOT NULL,
		felony_convicted TEXT NOT NULL, accident_history TEXT NOT NULL, skills TEXT NOT NULL, signature TEXT NOT NULL,
		status TEXT NOT NULL, cdl_front TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '');
	CREATE TABLE IF NOT EXISTS driver_onboarding (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE,
		application_id INTEGER NOT NULL, driver_name TEXT NOT NULL, status TEXT NOT NULL, onboarded_at TEXT DEFAULT '');
\`);
const sessions = new Map();
const send = (res, status, body, cookie) => {
	res.writeHead(status, { "content-type": "application/json", ...(cookie ? { "set-cookie": cookie } : {}) });
	res.end(JSON.stringify(body));
};
http.createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => { raw += c; });
	req.on("end", () => {
		const body = raw ? JSON.parse(raw) : {};
		const sid = (/(?:^|; )sid=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
		const me = sid && sessions.get(sid);
		const route = req.method + " " + req.url;
		if (req.method === "POST" && req.headers["x-requested-with"] !== "XMLHttpRequest") return send(res, 403, { error: "CSRF" });
		if (route === "GET /api/auth/session") return send(res, 200, { authenticated: !!me });
		if (route === "GET /api/auth/setup-check") return send(res, 200, { needsSetup: db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0 });
		if (route === "POST /api/auth/setup") {
			if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n) return send(res, 400, { error: "Setup already completed" });
			const id = db.prepare("INSERT INTO users (username, password_hash, role, email, must_change_password) VALUES (?, ?, 'Super Admin', ?, 0)")
				.run(body.username, bcrypt.hashSync(body.password, 4), body.email || "").lastInsertRowid;
			const s = crypto.randomBytes(8).toString("hex");
			sessions.set(s, { id, role: "Super Admin" });
			return send(res, 200, { success: true }, "sid=" + s + "; Path=/; HttpOnly");
		}
		if (route === "POST /api/auth/logout") { if (sid) sessions.delete(sid); return send(res, 200, { success: true }); }
		if (!me || me.role !== "Super Admin") return send(res, 403, { error: "Forbidden" });
		if (route === "POST /api/users") {
			db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email, full_name) VALUES (?, ?, ?, ?, ?, ?)")
				.run(body.username, bcrypt.hashSync(body.password, 4), body.role, body.driverName || "", body.email || "", body.fullName || "");
			return send(res, 200, { success: true });
		}
		if (route === "POST /api/trucks") {
			if (!/^data:image\\/(png|jpeg);base64,/.test(body.photo || "")) return send(res, 415, { error: "UNSUPPORTED_IMAGE_TYPE" });
			const id = db.prepare("INSERT INTO trucks (unit_number, make, model, assigned_driver, photo, notes) VALUES (?, ?, ?, ?, ?, ?)")
				.run(body.unitNumber, body.make || "", body.model || "", body.assignedDriver || "", body.photo, body.notes || "").lastInsertRowid;
			return send(res, 200, { success: true, id: Number(id) });
		}
		send(res, 404, { error: "no such route in the stub" });
	});
}).listen(Number(process.env.PORT), process.env.BIND_HOST);
`);

const ENV = {
	...process.env,
	HOME,
	E2E_SECURITY_BIN: path.join(BIN, "security"),
	FAKE_KEYCHAIN: STORE,
	E2E_WORK_DIR: WORK,
	APP_DIR: ROOT,
	MAIN_CHECKOUT: MAIN,
	E2E_SEED_CHECKOUT: SEED_WT,
	E2E_OPEN_LOG: OPEN_LOG,
	NODE_OPTIONS: `--require ${SPY}`,
};
for (const k of ["SOURCE_DB", "LOGINS_FILE", "E2E_KEYCHAIN_SERVICE", "CREDS_FILE", "E2E_MAINTENANCE_NOTICE", "E2E_FAKE_GMAIL", "E2E_DRIVER_INSTRUCTIONS_DENY"]) delete ENV[k];
// SETUP_DB_JS runs another setup-db.cjs (beside this one in scripts/e2e/), e.g. the base branch's.
const scriptPath = (script) => (script === "setup-db.cjs" && process.env.SETUP_DB_JS) || path.join(ROOT, "scripts", "e2e", script);
const node = (script, args, extra = {}) => spawnSync(process.execPath, [scriptPath(script), ...args],
	{ encoding: "utf8", env: { ...ENV, ...extra }, timeout: 180_000 });
const store = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return []; } };
const opened = () => { try { return fs.readFileSync(OPEN_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const ROLES = ["superAdmin", "driver", "investor", "investor2", "dispatcher"];
const loginsPath = path.join(WORK, "logins.json");
const readLogins = () => { try { return JSON.parse(fs.readFileSync(loginsPath, "utf8")); } catch { return null; } };

// A data:image/png URI is a well-formed PNG: signature, every chunk's CRC, and
// IDAT inflating to exactly the rows IHDR describes.
function pngOk(uri) {
	const m = /^data:image\/png;base64,(.+)$/.exec(uri || "");
	if (!m) return false;
	const b = Buffer.from(m[1], "base64");
	if (!b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false;
	let off = 8, w = 0, h = 0;
	const idat = [];
	while (off < b.length) {
		const len = b.readUInt32BE(off);
		const type = b.toString("ascii", off + 4, off + 8);
		const data = b.subarray(off + 8, off + 8 + len);
		if (zlib.crc32(b.subarray(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) return false;
		if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
		if (type === "IDAT") idat.push(data);
		off += 12 + len;
		if (type === "IEND") break;
	}
	return w > 0 && h > 0 && zlib.inflateSync(Buffer.concat(idat)).length === (w * 3 + 1) * h;
}

// A data:image/jpeg URI is a JPEG: it starts with SOI and an APP/DQT marker and ends with EOI.
function jpegOk(uri) {
	const m = /^data:image\/jpeg;base64,(.+)$/.exec(uri || "");
	if (!m) return false;
	const b = Buffer.from(m[1], "base64");
	return b.length > 100 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}

console.log("§1 no SOURCE_DB: a made-up database");
const dest = path.join(WORK, "qa.db");
const s1 = node("setup-db.cjs", [dest]);
ok(s1.status === 0, "setup-db.cjs with no SOURCE_DB succeeds", `${s1.status} ${(s1.stderr || "").slice(0, 400)}`);
const files = opened();
eq("…and opens no database outside the work dir (the main checkout's app.db is never opened)",
	files.filter((f) => !path.resolve(f).startsWith(WORK + path.sep)), []);
ok(files.length > 0, "…while it does open its own database (the spy sees the opens)", JSON.stringify(files));
const logins = readLogins() || {};
eq("logins.json says the seed is made-up", logins.seed, "made-up");
eq("…and names the five logins, all made-up qa-e2e- accounts",
	ROLES.map((k) => /^qa-e2e-[a-z0-9-]+$/.test((logins[k] || {}).username || "")), ROLES.map(() => true));
ok(!/decoy/.test(JSON.stringify(logins)) && !/password/i.test(JSON.stringify(logins)), "…with no copied account and no password in the file", "");
const items = store().filter((x) => x.s === "logisx-e2e-local");
eq("the five passwords are in the Keychain", items.map((x) => x.a).sort(), [...ROLES].sort());
ok(items.every((x) => !s1.stdout.includes(x.w) && !s1.stderr.includes(x.w)), "setup-db.cjs prints no password", "");
const v1 = node("verify-creds.cjs", [dest], { NODE_OPTIONS: "" });
ok(v1.status === 0 && (v1.stdout.match(/password matches=true must_change_password=0/g) || []).length === 5,
	"verify-creds.cjs signs all five in on the made-up database", `${v1.status} ${(v1.stdout + v1.stderr).slice(0, 400)}`);
if (fs.existsSync(dest)) try {
	const db = new Database(dest, { readonly: true });
	eq("the database holds exactly the five made-up accounts, one per role",
		db.prepare("SELECT username, role FROM users ORDER BY id").all().map((u) => `${u.username}/${u.role}`).sort(),
		["qa-e2e-admin/Super Admin", "qa-e2e-dispatcher/Dispatcher", "qa-e2e-driver/Driver", "qa-e2e-investor1/Investor", "qa-e2e-investor2/Investor"]);
	const drv = db.prepare("SELECT id, driver_name FROM users WHERE username = 'qa-e2e-driver'").get() || {};
	const truck = db.prepare("SELECT id, unit_number, assigned_driver, photo FROM trucks").all();
	eq("one truck, QA-E2E-T1, assigned to the made-up driver", truck.map((t) => [t.unit_number, t.assigned_driver]), [["QA-E2E-T1", drv.driver_name]]);
	ok(truck.length === 1 && jpegOk(truck[0].photo), "…with a JPEG photo drawn at run time (step 9 expects image/jpeg)", "");
	eq("logins.json's driver names that truck", (logins.driver || {}).truckId, truck[0] && truck[0].id);
	const onb = db.prepare("SELECT o.status, o.onboarded_at, a.cdl_front, a.email, a.ssn, a.id AS app FROM driver_onboarding o JOIN job_applications a ON a.id = o.application_id WHERE o.user_id = ?").get(drv.id) || {};
	eq("the driver is fully onboarded on an application", onb.status, "fully_onboarded");
	ok(Date.now() - Date.parse(onb.onboarded_at) > 14 * 86_400_000,
		"…more than 14 days ago, so the driver app's welcome card does not cover the run's taps", String(onb.onboarded_at));
	ok(pngOk(onb.cdl_front), "…whose cdl_front is a well-formed PNG", "");
	ok(/@example\.test$/.test(onb.email || "") && onb.ssn === "", "…with an example.test address and no SSN", JSON.stringify({ email: onb.email, ssn: onb.ssn }));
	eq("logins.json's driver names that application", (logins.driver || {}).applicationId, onb.app);
	eq("no session is left in the database", db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
	db.close();
} catch (e) {
	ok(false, "the made-up database has the seed's records", e.message);
}
ok(!fs.existsSync(`${dest}.sheets.json`), "the seed server's Sheets copy is removed (the run's first boot starts a fresh one)", "");
eq("the seed server's pid file is gone (it was stopped)", fs.readdirSync(WORK).filter((f) => /^server-\d+\.(pid|log)$/.test(f)), []);
const raw = fs.existsSync(dest) ? fs.readFileSync(dest) : Buffer.alloc(0);
ok(raw.length > 0 && !raw.includes("decoy"), "nothing of the main checkout's database is in the new one", "");

console.log("§1b a second made-up database reuses the Keychain's passwords");
const s1b = node("setup-db.cjs", [path.join(WORK, "qa2.db")]);
const items1b = store().filter((x) => x.s === "logisx-e2e-local");
ok(s1b.status === 0 && JSON.stringify(items1b.map((x) => [x.a, x.w]).sort()) === JSON.stringify(items.map((x) => [x.a, x.w]).sort()),
	"the five Keychain passwords are unchanged", `${s1b.status} ${(s1b.stderr || "").slice(0, 200)}`);
const v1b = node("verify-creds.cjs", [dest, path.join(WORK, "qa2.db")], { NODE_OPTIONS: "" });
ok(v1b.status === 0 && (v1b.stdout.match(/password matches=true must_change_password=0/g) || []).length === 10,
	"…so one set of logins signs in on both made-up databases", `${v1b.status} ${(v1b.stdout + v1b.stderr).slice(0, 300)}`);

console.log("§1c a seed server that never gets ready is still stopped");
const HANG_WT = path.join(SANDBOX, "seed-wt-hang");
const HANG_PID = path.join(SANDBOX, "hang.pid");
fs.mkdirSync(HANG_WT);
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(HANG_WT, "node_modules"));
fs.writeFileSync(path.join(HANG_WT, "server.js"), `
require("fs").writeFileSync(${JSON.stringify(HANG_PID)}, String(process.pid));
require("http").createServer((req, res) => { res.writeHead(503); res.end(); }).listen(Number(process.env.PORT), process.env.BIND_HOST);
`);
const s1c = node("setup-db.cjs", [path.join(WORK, "hang.db")], { E2E_SEED_CHECKOUT: HANG_WT, E2E_BOOT_WAIT_S: "2" });
let hangPid = 0;
try { hangPid = Number(fs.readFileSync(HANG_PID, "utf8")); } catch { /* never started */ }
let hangAlive = false;
try { if (hangPid > 0) { process.kill(hangPid, 0); hangAlive = true; } } catch { /* gone */ }
if (hangAlive) { try { process.kill(hangPid, "SIGTERM"); } catch { /* gone */ } }
ok(s1c.status !== 0 && /did not boot/.test(s1c.stderr), "setup-db.cjs fails when the seed server never answers", `${s1c.status} ${(s1c.stderr || "").slice(0, 300)}`);
ok(hangPid > 0 && !hangAlive, "…and the server it started is no longer running", `pid ${hangPid} alive ${hangAlive}`);
eq("…and no pid file is left in the work dir", fs.readdirSync(WORK).filter((f) => /^server-\d+\.pid$/.test(f)), []);

console.log("§2 a SOURCE_DB inside a checkout, or outside ~/LogisX-replica/, is refused");
const otherCheckout = path.join(SANDBOX, "other-repo");
fs.mkdirSync(path.join(otherCheckout, ".git"), { recursive: true });
madeUpSourceDb(path.join(otherCheckout, "data", "app.db"), "inrepo");
const replicaCheckout = path.join(REPLICA, "code", "abc123");
fs.mkdirSync(replicaCheckout, { recursive: true });
fs.writeFileSync(path.join(replicaCheckout, ".git"), "gitdir: /nowhere\n");
madeUpSourceDb(path.join(replicaCheckout, "app.db"), "inworktree");
const outside = path.join(SANDBOX, "elsewhere", "app.db");
madeUpSourceDb(outside, "outside");
const linkIntoRepo = path.join(REPLICA, "linked.db");
fs.symlinkSync(path.join(otherCheckout, "data", "app.db"), linkIntoRepo);
const refusals = [
	["the main checkout's app.db", path.join(MAIN, "app.db"), /refusing SOURCE_DB .*inside the checkout/],
	["a database inside another repo", path.join(otherCheckout, "data", "app.db"), /refusing SOURCE_DB .*inside the checkout/],
	["a worktree (a .git file) under ~/LogisX-replica/", path.join(replicaCheckout, "app.db"), /refusing SOURCE_DB .*inside the checkout/],
	["a link under ~/LogisX-replica/ into a repo", linkIntoRepo, /refusing SOURCE_DB .*inside the checkout/],
	["a database outside ~/LogisX-replica/", outside, /refusing SOURCE_DB .*only from under/],
];
for (const [label, src, want] of refusals) {
	fs.rmSync(loginsPath, { force: true });
	const d = path.join(WORK, "refused.db");
	const r = node("setup-db.cjs", [d, "--force"], { SOURCE_DB: src });
	ok(r.status === 2 && want.test(r.stderr) && /Unset SOURCE_DB/.test(r.stderr), `refused: ${label}`, `${r.status} ${(r.stderr || r.stdout || "").slice(0, 300)}`);
	ok(!fs.existsSync(d) && !fs.existsSync(loginsPath), `…and nothing written (${label})`, "");
}

console.log("§3 a SOURCE_DB under ~/LogisX-replica/ is copied");
const replicaDb = path.join(REPLICA, "clean", "app.db");
madeUpSourceDb(replicaDb, "replica");
const s3 = node("setup-db.cjs", [path.join(WORK, "copy.db")], { SOURCE_DB: replicaDb });
ok(s3.status === 0 && /backup: ok \(source opened read-only\)/.test(s3.stdout), "setup-db.cjs copies it", `${s3.status} ${(s3.stderr || "").slice(0, 300)}`);
const l3 = readLogins() || {};
ok(l3.seed === "copy" && (l3.driver || {}).username === "replica-driver", "…and logins.json names the copy's driver and says it is a copy", JSON.stringify({ seed: l3.seed, driver: (l3.driver || {}).username }));

console.log("§4 payout-parity.mjs takes SOURCE_DB by the same rule, with no default");
const parityCases = [
	["no SOURCE_DB (no default: the main checkout's app.db is not used)", undefined, /SOURCE_DB is required/],
	["the main checkout's app.db", path.join(MAIN, "app.db"), /refusing SOURCE_DB .*inside the checkout/],
	["a worktree (a .git file) under ~/LogisX-replica/", path.join(replicaCheckout, "app.db"), /refusing SOURCE_DB .*inside the checkout/],
	["a database outside ~/LogisX-replica/", outside, /refusing SOURCE_DB .*only from under/],
];
for (const [label, src, want] of parityCases) {
	const extra = { FLAG: "off", NODE_OPTIONS: "" };
	if (src) extra.SOURCE_DB = src;
	const r = node("payout-parity.mjs", [], extra);
	ok(r.status === 2 && want.test(r.stderr), `payout-parity refuses: ${label}`, `${r.status} ${(r.stderr || r.stdout || "").slice(0, 300)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
