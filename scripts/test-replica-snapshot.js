#!/usr/bin/env node
// replica:pull's server-side steps (scripts/replica/remote/), run locally on
// temporary files: what production would see them do.
//
//   §1 the snapshot is read-only: on a WAL database with rows still in the -wal,
//      snapshot.js leaves the database and its -wal byte-identical, its copy
//      holds every row (the WAL's included), the connection it uses refuses a
//      write (SQLITE_READONLY), and it keeps the shape the production-write
//      guard allows (readonly: true, VACUUM INTO, one folder under
//      /root/logisx-replica-tmp, app.db)
//   §2 scrub.js clears sessions and every token column in the COPY, keeps every
//      other value, and refuses the live database
//   §3 settings.js copies business settings only: secrets by name, a URL
//      carrying credentials and runtime settings are skipped, by rule and name;
//      what it writes reads back exactly through dotenv
//   §4 the stamp and task rules, and the pull scripts keep the production host
//      out of the repository and clean up the server on failure
//
// Standalone: node scripts/test-replica-snapshot.js. No server, no network.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REMOTE = path.join(ROOT, "scripts", "replica", "remote");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const dotenv = require(path.join(ROOT, "node_modules", "dotenv"));
const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
const { scrub } = require(path.join(REMOTE, "scrub.js"));
const { exportSettings } = require(path.join(REMOTE, "settings.js"));

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- §1 the snapshot ------------------------------------------------------------
console.log("§1 the snapshot reads the live database and writes only its copy");
{
	const app = tmp("replica-snap-app-");
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
	const live = path.join(app, "app.db");
	const w = new Database(live);
	w.pragma("journal_mode = WAL");
	w.pragma("wal_autocheckpoint = 0");
	w.exec("CREATE TABLE loads (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire TEXT)");
	const ins = w.prepare("INSERT INTO loads (name) VALUES (?)");
	for (let i = 0; i < 200; i++) ins.run(`load-${i}`);
	w.pragma("wal_checkpoint(TRUNCATE)");
	for (let i = 200; i < 260; i++) ins.run(`wal-only-${i}`);
	// The writer stays open, as the live app's does, so the -wal stays as it is.
	ok("the fixture has rows only in the -wal", fs.statSync(`${live}-wal`).size > 0);
	const before = { db: sha(live), wal: sha(`${live}-wal`) };

	const parent = tmp("replica-snap-tmp-");
	const stamp = "20261008T0700Z";
	fs.mkdirSync(path.join(parent, stamp), { mode: 0o700 });
	const run = spawnSync(process.execPath, [path.join(REMOTE, "snapshot.js"), `--app=${app}`, `--stamp=${stamp}`, `--parent=${parent}`, `--source=${live}`], { encoding: "utf8" });
	eq("snapshot.js exits 0", run.status, 0);
	const copy = path.join(parent, stamp, "app.db");
	eq("the live database is byte-identical afterwards", sha(live), before.db);
	eq("...and so is its -wal", sha(`${live}-wal`), before.wal);
	const c = new Database(copy, { readonly: true });
	eq("the copy holds every row, the -wal's included", c.prepare("SELECT COUNT(*) AS n FROM loads").get().n, 260);
	eq("...the last one written", c.prepare("SELECT name FROM loads ORDER BY id DESC LIMIT 1").get().name, "wal-only-259");
	c.close();
	eq("the copy is private (0600)", (fs.statSync(copy).mode & 0o777).toString(8), "600");
	const again = spawnSync(process.execPath, [path.join(REMOTE, "snapshot.js"), `--app=${app}`, `--stamp=${stamp}`, `--parent=${parent}`, `--source=${live}`], { encoding: "utf8" });
	ok("an existing copy is never overwritten", again.status !== 0 && /already exists/.test(again.stderr));
	const bad = spawnSync(process.execPath, [path.join(REMOTE, "snapshot.js"), `--app=${app}`, "--stamp=../escape", `--parent=${parent}`, `--source=${live}`], { encoding: "utf8" });
	ok("a stamp that could leave the folder is refused", bad.status !== 0);
	let code = null;
	const ro = new Database(live, { readonly: true, fileMustExist: true });
	try { ro.prepare("INSERT INTO loads (name) VALUES ('x')").run(); } catch (e) { code = e.code; }
	ro.close();
	eq("a connection opened the way snapshot.js opens it refuses a write", code, "SQLITE_READONLY");
	w.close();

	const src = fs.readFileSync(path.join(REMOTE, "snapshot.js"), "utf8");
	ok("it opens the live database { readonly: true, fileMustExist: true }", /new Database\(source, \{ readonly: true, fileMustExist: true \}\)/.test(src));
	ok("it copies with VACUUM INTO and nothing else", (src.match(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/g) || []).length === 0 && /VACUUM INTO \?/.test(src));
	eq("its default destination is one folder under /root/logisx-replica-tmp, named app.db", require(path.join(REMOTE, "snapshot.js")).snapshotPath(rules.REMOTE_TMP_PARENT, stamp), `/root/logisx-replica-tmp/${stamp}/app.db`);
}

// ---- §2 scrub ------------------------------------------------------------------------
console.log("§2 the scrub clears tokens and sessions in the copy only");
{
	const dir = tmp("replica-scrub-");
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(`
		CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire TEXT);
		CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, legal_name TEXT, access_token TEXT, ein_ssn TEXT);
		CREATE TABLE investor_invites (id INTEGER PRIMARY KEY, token_sha256 TEXT NOT NULL UNIQUE, invitee_email TEXT);
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
		CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
		INSERT INTO sessions VALUES ('s1', '{}', '2026-12-01'), ('s2', '{}', '2026-12-01');
		INSERT INTO investor_applications VALUES (1, 'Quill Harbor LLC', 'tok-1', '12-3456789'), (2, 'Moss Lane LLC', NULL, NULL);
		INSERT INTO investor_invites VALUES (1, 'aaaa', 'quill@example.test'), (2, 'bbbb', 'moss@example.test');
		INSERT INTO users VALUES (1, 'super_admin', '$2a$10$abc');
		INSERT INTO server_state VALUES ('route_cache_snapshot', '[]'), ('gmail_oauth_token', 'x');
		INSERT INTO app_settings VALUES ('payout_day', '15');
	`);
	const cleared = scrub(db);
	const find = (t, c) => cleared.find((x) => x.table === t && x.column === c);
	eq("every session is gone", db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
	eq("...and reported", find("sessions", "*").rows, 2);
	eq("access_token is cleared", db.prepare("SELECT access_token FROM investor_applications WHERE id = 1").get().access_token, null);
	eq("...the rest of the row is as it was", db.prepare("SELECT legal_name, ein_ssn FROM investor_applications WHERE id = 1").get(), { legal_name: "Quill Harbor LLC", ein_ssn: "12-3456789" });
	const tokens = db.prepare("SELECT token_sha256 FROM investor_invites ORDER BY id").all().map((r) => r.token_sha256);
	ok("a NOT NULL UNIQUE token gets fresh random values (no link can match)", tokens.every((t) => /^[0-9a-f]{64}$/.test(t)) && tokens[0] !== tokens[1] && !tokens.includes("aaaa"));
	eq("passwords and other data are not touched", db.prepare("SELECT password_hash FROM users").get().password_hash, "$2a$10$abc");
	eq("a key/value row naming a credential is deleted, the others kept", db.prepare("SELECT key FROM server_state ORDER BY key").all().map((r) => r.key), ["route_cache_snapshot"]);
	eq("app_settings keeps its business rows", db.prepare("SELECT COUNT(*) AS n FROM app_settings").get().n, 1);
	ok("the summary names tables and columns, never a value", !JSON.stringify(cleared).includes("tok-1") && !JSON.stringify(cleared).includes("aaaa"));
	db.close();

	const app = tmp("replica-scrub-app-");
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
	fs.copyFileSync(file, path.join(app, "app.db"));
	const refused = spawnSync(process.execPath, [path.join(REMOTE, "scrub.js"), `--app=${app}`, `--db=${path.join(app, "app.db")}`], { encoding: "utf8" });
	ok("scrub.js refuses the live database", refused.status !== 0 && /live database/.test(refused.stderr));
	fs.linkSync(path.join(app, "app.db"), path.join(dir, "linked.db"));
	const viaLink = spawnSync(process.execPath, [path.join(REMOTE, "scrub.js"), `--app=${app}`, `--db=${path.join(dir, "linked.db")}`], { encoding: "utf8" });
	ok("...by any name (a hard link to it)", viaLink.status !== 0);
	const copy = path.join(dir, "copy");
	fs.mkdirSync(copy);
	fs.copyFileSync(file, path.join(copy, "app.db"));
	const fine = spawnSync(process.execPath, [path.join(REMOTE, "scrub.js"), `--app=${app}`, `--db=${path.join(copy, "app.db")}`], { encoding: "utf8" });
	eq("...and runs on a copy outside the app, printing one JSON summary", [fine.status, JSON.parse(fine.stdout).step], [0, "scrub"]);
}

// ---- §3 settings ------------------------------------------------------------------------
console.log("§3 the settings export copies business settings only");
{
	const prod = {
		CSRF_HEADER_REQUIRED: "true", ROUTEMATE_ENABLED: "true", GMAIL_USER: "dispatch@example.test", GEMINI_OCR_MODEL: "gemini-2.5-flash",
		RATECON_RECONCILE_MAILBOX: "INBOX", MAINTENANCE_NOTICE_MESSAGE: "Planned work, it's Sunday",
		GEMINI_API_KEY: "k", GMAIL_APP_PASSWORD: "p", SESSION_SECRET: "s", LINXUP_WEBHOOK_TOKEN: "t", N8N_WEBHOOK_SECRET: "w",
		SETUP_RECOVERY_TOKEN: "r", PRIVATE_THING: "x", SMTP_HOST: "smtp.example.test", SENTRY_DSN: "d", OAUTH_CLIENT: "o",
		REPORT_URL: "https://user:secret@reports.example.test/x", FEED_URL: "https://feed.example.test/data?api_key=abc", PLAIN_URL: "https://logisx.example.test/help",
		NODE_ENV: "production", PORT: "3000", DATABASE_PATH: "/var/www/x/app.db",
	};
	const { copied, skipped, text } = exportSettings(prod);
	eq("business settings are copied", copied, ["CSRF_HEADER_REQUIRED", "GEMINI_OCR_MODEL", "GMAIL_USER", "MAINTENANCE_NOTICE_MESSAGE", "PLAIN_URL", "RATECON_RECONCILE_MAILBOX", "ROUTEMATE_ENABLED"]);
	const rule = (n) => (skipped.find((s) => s.name === n) || {}).rule;
	for (const [n, part] of [["GEMINI_API_KEY", "KEY"], ["GMAIL_APP_PASSWORD", "PASS"], ["SESSION_SECRET", "SECRET"], ["LINXUP_WEBHOOK_TOKEN", "TOKEN"], ["N8N_WEBHOOK_SECRET", "SECRET"], ["SETUP_RECOVERY_TOKEN", "TOKEN"], ["PRIVATE_THING", "PRIVATE"], ["SMTP_HOST", "SMTP"], ["SENTRY_DSN", "DSN"], ["OAUTH_CLIENT", "AUTH"]]) {
		eq(`${n} is skipped as a secret (name contains ${part})`, rule(n), `secret: name contains ${part}`);
	}
	eq("a URL with userinfo is skipped", rule("REPORT_URL"), "secret: value is a URL carrying credentials");
	eq("a URL with a credential query parameter is skipped", rule("FEED_URL"), "secret: value is a URL carrying credentials");
	for (const n of ["NODE_ENV", "PORT", "DATABASE_PATH"]) eq(`${n} is skipped as runtime`, rule(n), "runtime: set by replica:start");
	const back = dotenv.parse(text);
	eq("what is written reads back exactly through dotenv", copied.map((n) => back[n]), copied.map((n) => prod[n]));
	ok("no secret value is in the written file", !["k", "p", "abc", "secret@"].some((v) => text.includes(`='${v}'`) || text.includes(v + "@")) && !/GEMINI_API_KEY|SESSION_SECRET|NODE_ENV/.test(text));
	const out = tmp("replica-settings-");
	const app = tmp("replica-settings-app-");
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
	fs.writeFileSync(path.join(app, ".env"), Object.entries(prod).map(([k, v]) => `${k}="${v}"`).join("\n"));
	const r = spawnSync(process.execPath, [path.join(REMOTE, "settings.js"), `--app=${app}`, `--out=${path.join(out, "settings.env")}`], { encoding: "utf8" });
	eq("settings.js exits 0", r.status, 0);
	ok("...and prints names, never a value", !/dispatch@example|gemini-2\.5|Sunday|smtp\.example|"k"|"p"/.test(r.stdout) && JSON.parse(r.stdout).copied.length === 7);
	eq("...writing the file 0600", (fs.statSync(path.join(out, "settings.env")).mode & 0o777).toString(8), "600");
}

// ---- §4 rules and the pull scripts ------------------------------------------------------------
console.log("§4 stamps, tasks and the pull scripts");
{
	for (const s of ["20261008T0700Z", "a", "x_1-2"]) ok(`stamp ${s} is accepted`, rules.isValidStamp(s));
	for (const s of ["", "-x", "../x", "a/b", "a b", "_x", "x".repeat(65)]) ok(`stamp ${JSON.stringify(s)} is refused`, !rules.isValidStamp(s));
	for (const t of ["default", "issue-431", "a1"]) ok(`task ${t} is accepted`, rules.isValidTask(t));
	for (const t of ["", "Big", "-x", "a_b", "../x", "x".repeat(49)]) ok(`task ${JSON.stringify(t)} is refused`, !rules.isValidTask(t));

	const files = [...fs.readdirSync(path.join(ROOT, "scripts", "replica")).map((f) => path.join("scripts", "replica", f)), ...fs.readdirSync(REMOTE).map((f) => path.join("scripts", "replica", "remote", f)), "lib/replica-mode.js", "lib/replica-rules.js", "lib/replica-sheets.js"]
		.filter((f) => fs.statSync(path.join(ROOT, f)).isFile());
	const leaks = files.filter((f) => {
		const s = fs.readFileSync(path.join(ROOT, f), "utf8");
		return /\b(?!127\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(s.replace(/\b0\.0\.0\.0\b|\b192\.0\.2\.\d+\b/g, "")) || /\bsrv\d{5,}/i.test(s);
	});
	eq("no replica file names the production host (it comes from LOGISX_PROD_SSH)", leaks, []);
	const pull = fs.readFileSync(path.join(ROOT, "scripts", "replica", "pull.sh"), "utf8");
	ok("pull.sh refuses to run without LOGISX_PROD_SSH", /\[ -n "\$\{LOGISX_PROD_SSH:-\}" \] \|\| die/.test(pull));
	ok("pull.sh removes the server's folder from a trap on exit, success or failure", /trap on_exit EXIT/.test(pull) && /if \[ "\$REMOTE_STARTED" = 1 \]; then remote_cleanup; fi/.test(pull));
	ok("pull.sh runs with umask 077", /^umask 077$/m.test(pull));
	const begin = fs.readFileSync(path.join(REMOTE, "begin.sh"), "utf8");
	ok("the server program removes its folder when any step fails (its own trap)", /trap replica_remote_cleanup EXIT/.test(begin) && /rm -rf -- "\$TMP"/.test(begin));
	ok("...creates it mode 700 with umask 077, under /root/logisx-replica-tmp only", /umask 077/.test(begin) && /mkdir -m 700 -- "\$TMP"/.test(begin) && /\[ "\$TMP_PARENT" = \/root\/logisx-replica-tmp \]/.test(begin));
	const finish = fs.readFileSync(path.join(REMOTE, "finish.sh"), "utf8");
	ok("...and gives no step its stdin (the program itself)", finish.split("\n").filter((l) => /^"\$NODE"/.test(l)).every((l) => /<\/dev\/null/.test(l)));
	const run = spawnSync("bash", ["-n", path.join(ROOT, "scripts", "replica", "pull.sh")], { encoding: "utf8" });
	eq("pull.sh parses", run.status, 0);
	const noSsh = spawnSync("bash", [path.join(ROOT, "scripts", "replica", "pull.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp("replica-home-") } });
	ok("without LOGISX_PROD_SSH it stops before doing anything", noSsh.status !== 0 && /LOGISX_PROD_SSH/.test(noSsh.stderr));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
