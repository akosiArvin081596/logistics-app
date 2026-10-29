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
//   §2 scrub.js clears sessions, the staff sign-in IP and browser records
//      (sign_in_network) and every credential column (snake_case or
//      camelCase) in the COPY, keeps every other value, refuses the live
//      database, and leaves none of the removed values anywhere in the file's
//      bytes: planted values are searched for, a plain DELETE is shown to leave
//      them behind, and a value that lives on elsewhere fails the step
//   §3 settings.js copies business settings only: secrets by name, a URL
//      carrying credentials, a value that looks like a key, runtime settings and
//      any name the app's code does not read are skipped, by rule and name;
//      what it writes reads back exactly through dotenv; on this checkout's own
//      server.js and lib/, every flag, first month and lease setting the app
//      reads (process.env.NAME, env.NAME in a lib/ helper, or a name table) is
//      copied, and the bank settings, secrets and production targets are not
//   §4 the stamp (unique per run) and task rules; the pull scripts keep the
//      production host out of the repository, fail when the server's folder
//      cannot be confirmed gone, sweep stale folders (over an hour old), and
//      run at low priority
//   §5 the compressed download: compress.js turns app.db and sheets.json into
//      zstd files (600) and records each original's size and SHA-256; unpack
//      gives back byte-identical files and refuses a short, damaged or
//      mismatched download (removing what it wrote); the server's folder goes,
//      compressed files included, on success, on a failed step and when the
//      pull is interrupted; the progress filter never shows or logs a file
//      name; pull.sh downloads whole, with progress, and checks before the swap
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
const { scrub, residue } = require(path.join(REMOTE, "scrub.js"));
const { exportSettings } = require(path.join(REMOTE, "settings.js"));

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
// Every temporary folder goes when the runner exits, pass or fail.
const tempDirs = [];
process.on("exit", () => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tempDirs.push(d); return d; };
// pull.sh's trap, on_exit(), and what it calls, with the variables they read:
// run as pull.sh has them, with ssh standing in.
const PULL_TRAP_FNS = ["ctl", "prod_ssh", "direct_ssh", "conn_open", "close_conn", "restore_clean", "new_snapshot_in_place", "failure_outcome", "remote_cleanup", "on_exit"];
const PULL_TRAP_VARS = 'CONN_DIR=""; CONN_SOCK=""; WATCHDOG_PID=""; CONN_PERSIST_S=30; FILES_STARTED=0; SETTINGS_DONE=0; RESTORED=0; log() { echo "$*"; }';

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
console.log("§2 the scrub clears tokens and sessions in the copy, out of its bytes too");
{
	// Distinctive values, so a search of the file's bytes can only find these.
	const P = (tag) => `PLANTED-${tag}-${crypto.randomBytes(8).toString("hex")}`;
	const planted = { sid1: P("sid1"), sid2: P("sid2"), tok: P("access"), inv1: P("invite1"), inv2: P("invite2"), oauth: P("oauth"), api: P("apikey"), reset: P("resetcode"), browser: P("browser") };
	const fixture = (file) => {
		const db = new Database(file);
		db.exec(`
			CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire TEXT);
			CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, legal_name TEXT, access_token TEXT, ein_ssn TEXT);
			CREATE TABLE investor_invites (id INTEGER PRIMARY KEY, token_sha256 TEXT NOT NULL UNIQUE, invitee_email TEXT);
			CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, resetCode TEXT);
			CREATE TABLE expenses (id INTEGER PRIMARY KEY, amount REAL, receipt_hash TEXT);
			CREATE TABLE integrations (id INTEGER PRIMARY KEY, name TEXT, apiKey TEXT, login_nonce TEXT);
			CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT);
			CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
			CREATE TABLE sign_in_network (id INTEGER PRIMARY KEY AUTOINCREMENT, audit_id INTEGER NOT NULL, user_id INTEGER NOT NULL, at TEXT NOT NULL,
				ip TEXT NOT NULL DEFAULT '', ip_source TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '');
			CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT);
		`);
		const ins = (sql, ...a) => db.prepare(sql).run(...a);
		ins("INSERT INTO sessions VALUES (?, '{}', '2026-12-01'), (?, '{}', '2026-12-01')", planted.sid1, planted.sid2);
		// A staff sign-in's IP and browser (lib/sign-in.js); the browser string is
		// the planted value the byte search looks for.
		ins("INSERT INTO sign_in_network (audit_id, user_id, at, ip, ip_source, user_agent) VALUES (1, 1, '2026-10-28T12:00:00.000Z', '203.0.113.90', 'proxy', ?)", planted.browser);
		ins("INSERT INTO investor_applications VALUES (1, 'Quill Harbor LLC', ?, '12-3456789'), (2, 'Moss Lane LLC', NULL, NULL)", planted.tok);
		ins("INSERT INTO investor_invites VALUES (1, ?, 'quill@example.test'), (2, ?, 'moss@example.test')", planted.inv1, planted.inv2);
		ins("INSERT INTO users VALUES (1, 'super_admin', '$2a$10$abcdefghijklmnopqrstuv', ?)", planted.reset);
		ins("INSERT INTO expenses VALUES (1, 12.5, 'receipt-fingerprint-0001')");
		ins("INSERT INTO integrations VALUES (1, 'feed', ?, NULL)", planted.api);
		ins("INSERT INTO server_state VALUES ('route_cache_snapshot', '[]'), ('gmail_oauth_token', ?)", planted.oauth);
		ins("INSERT INTO app_settings VALUES ('payout_day', '15')");
		// Pages of other data, so freed space is a real part of the file.
		const fill = db.prepare("INSERT INTO filler (body) VALUES (?)");
		for (let i = 0; i < 400; i++) fill.run("x".repeat(500));
		return db;
	};
	const bytesHold = (file, v) => fs.readFileSync(file).includes(Buffer.from(v));

	// The residue the fix is for: a plain DELETE/UPDATE leaves the old values in
	// the file's free pages, where the search finds them.
	const plainDir = tmp("replica-scrub-plain-");
	const plainFile = path.join(plainDir, "app.db");
	const plain = fixture(plainFile);
	plain.pragma("journal_mode = DELETE");
	plain.exec("DELETE FROM sessions; UPDATE investor_applications SET access_token = NULL");
	plain.close();
	ok("without secure_delete and VACUUM a deleted value stays in the file (the case this guards)", bytesHold(plainFile, planted.sid1));
	eq("...and the residue check finds it", residue([plainFile], [planted.sid1]).remaining, 1);

	const dir = tmp("replica-scrub-");
	const file = path.join(dir, "app.db");
	const db = fixture(file);
	const { cleared, removed } = scrub(db);
	const find = (t, c) => cleared.find((x) => x.table === t && x.column === c);
	eq("every session is gone", db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0);
	eq("...and reported", find("sessions", "*").rows, 2);
	eq("every staff sign-in IP and browser record is gone (sign_in_network)", db.prepare("SELECT COUNT(*) AS n FROM sign_in_network").get().n, 0);
	eq("...and reported", (find("sign_in_network", "*") || {}).rows, 1);
	eq("access_token is cleared", db.prepare("SELECT access_token FROM investor_applications WHERE id = 1").get().access_token, null);
	eq("...the rest of the row is as it was", db.prepare("SELECT legal_name, ein_ssn FROM investor_applications WHERE id = 1").get(), { legal_name: "Quill Harbor LLC", ein_ssn: "12-3456789" });
	const tokens = db.prepare("SELECT token_sha256 FROM investor_invites ORDER BY id").all().map((r) => r.token_sha256);
	ok("a NOT NULL UNIQUE token gets fresh random values (no link can match)", tokens.every((t) => /^[0-9a-f]{64}$/.test(t)) && tokens[0] !== tokens[1]);
	eq("camelCase and *_code credential columns are cleared too (apiKey, resetCode, login_nonce)", [db.prepare("SELECT apiKey FROM integrations").get().apiKey, db.prepare("SELECT resetCode FROM users").get().resetCode, find("integrations", "login_nonce").how], [null, null, "set to NULL"]);
	eq("password hashes are kept by design, and named", [db.prepare("SELECT password_hash FROM users").get().password_hash, /kept by design/.test(find("users", "password_hash").how)], ["$2a$10$abcdefghijklmnopqrstuv", true]);
	eq("a receipt fingerprint is kept, and named", [db.prepare("SELECT receipt_hash FROM expenses").get().receipt_hash, /not a credential/.test(find("expenses", "receipt_hash").how)], ["receipt-fingerprint-0001", true]);
	eq("a key/value row naming a credential is deleted, the others kept", db.prepare("SELECT key FROM server_state ORDER BY key").all().map((r) => r.key), ["route_cache_snapshot"]);
	eq("app_settings keeps its business rows", db.prepare("SELECT COUNT(*) AS n FROM app_settings").get().n, 1);
	eq("the scrub ran with secure_delete on, out of WAL", [db.pragma("secure_delete", { simple: true }), db.pragma("journal_mode", { simple: true })], [1, "delete"]);
	db.close();
	eq("every removed value was collected for the check", removed.length, 8);
	const leftovers = Object.values(planted).filter((v) => bytesHold(file, v));
	eq("none of the removed values is anywhere in the file's bytes (secure_delete, then VACUUM)", leftovers.length, 0);
	eq("...which is what the residue check reports", residue([file], removed), { searched: 8, tooShortToSearch: 0, remaining: 0 });
	ok("the summary names tables and columns, never a value", !Object.values(planted).some((v) => JSON.stringify(cleared).includes(v)));

	const app = tmp("replica-scrub-app-");
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
	const liveDb = fixture(path.join(app, "app.db"));
	liveDb.close();
	const refused = spawnSync(process.execPath, [path.join(REMOTE, "scrub.js"), `--app=${app}`, `--db=${path.join(app, "app.db")}`], { encoding: "utf8" });
	ok("scrub.js refuses the live database", refused.status !== 0 && /live database/.test(refused.stderr));
	fs.linkSync(path.join(app, "app.db"), path.join(dir, "linked.db"));
	const viaLink = spawnSync(process.execPath, [path.join(REMOTE, "scrub.js"), `--app=${app}`, `--db=${path.join(dir, "linked.db")}`], { encoding: "utf8" });
	ok("...by any name (a hard link to it)", viaLink.status !== 0);

	const copy = path.join(tmp("replica-scrub-copy-"), "app.db");
	fixture(copy).close();
	const fine = spawnSync(process.execPath, [path.join(REMOTE, "scrub.js"), `--app=${app}`, `--db=${copy}`], { encoding: "utf8" });
	const summary = fine.status === 0 ? JSON.parse(fine.stdout) : {};
	eq("scrub.js on a copy: exit 0, its byte check passed with counts only", [fine.status, summary.check], [0, { removedValues: 8, searched: 8, tooShortToSearch: 0, remaining: 0 }]);
	ok("...and nothing it printed holds a removed value", !Object.values(planted).some((v) => (fine.stdout + fine.stderr).includes(v)));

	// A removed value that lives on elsewhere in the copy is still in its bytes:
	// the step fails, so the pull fails and nothing is downloaded.
	const leaky = path.join(tmp("replica-scrub-leak-"), "app.db");
	const ldb = fixture(leaky);
	ldb.prepare("INSERT INTO filler (body) VALUES (?)").run(`audit: invite ${planted.inv1} opened`);
	ldb.close();
	const leak = spawnSync(process.execPath, [path.join(REMOTE, "scrub.js"), `--app=${app}`, `--db=${leaky}`], { encoding: "utf8" });
	ok("a removed value still in the copy fails the step, naming a count, never the value", leak.status === 1 && /1 removed value\(s\) are still in the copy's bytes/.test(leak.stderr) && !(leak.stdout + leak.stderr).includes(planted.inv1), { status: leak.status, err: leak.stderr.slice(0, 200) });
	eq("values too short to search are counted, not searched", residue([copy], ["short", "x", planted.sid1]), { searched: 1, tooShortToSearch: 2, remaining: 0 });
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
		REPORT_SETTING: "AIzaSyD3x9EXAMPLEEXAMPLE12345", ALERT_URL: "https://hooks.example.test/services/T01/B02/aB3dE5fG7hI9jK1lM3nO5pQ7",
		DRIVE_FOLDER_ID: "1Xy7-kQ2_wErT5yU8iOp3aSdF6gHjK9lZ",
	};
	const { copied, skipped, text } = exportSettings(prod);
	eq("business settings are copied", copied, ["CSRF_HEADER_REQUIRED", "DRIVE_FOLDER_ID", "GEMINI_OCR_MODEL", "MAINTENANCE_NOTICE_MESSAGE", "PLAIN_URL", "ROUTEMATE_ENABLED"]);
	const rule = (n) => (skipped.find((s) => s.name === n) || {}).rule;
	// Decision 36: the app's Gmail account and its reconcile label are production targets.
	for (const n of ["GMAIL_USER", "RATECON_RECONCILE_MAILBOX"]) eq(`${n} is skipped as a production target`, rule(n), "production only: names a production target");
	for (const [n, part] of [["GEMINI_API_KEY", "KEY"], ["GMAIL_APP_PASSWORD", "PASS"], ["SESSION_SECRET", "SECRET"], ["LINXUP_WEBHOOK_TOKEN", "TOKEN"], ["N8N_WEBHOOK_SECRET", "SECRET"], ["SETUP_RECOVERY_TOKEN", "TOKEN"], ["PRIVATE_THING", "PRIVATE"], ["SMTP_HOST", "SMTP"], ["SENTRY_DSN", "DSN"], ["OAUTH_CLIENT", "AUTH"]]) {
		eq(`${n} is skipped as a secret (name contains ${part})`, rule(n), `secret: name contains ${part}`);
	}
	eq("a URL with userinfo is skipped", rule("REPORT_URL"), "secret: value is a URL carrying credentials");
	eq("a URL with a credential query parameter is skipped", rule("FEED_URL"), "secret: value is a URL carrying credentials");
	eq("a URL with a token in its path is skipped", rule("ALERT_URL"), "secret: value is a URL carrying credentials");
	eq("a value that looks like a key is skipped, whatever its name", rule("REPORT_SETTING"), "secret: value looks like a key");
	ok("an identifier setting (*_ID) is copied though it looks like a key", copied.includes("DRIVE_FOLDER_ID"));
	for (const n of ["NODE_ENV", "PORT", "DATABASE_PATH"]) eq(`${n} is skipped as runtime`, rule(n), "runtime: set by replica:start");
	const back = dotenv.parse(text);
	eq("what is written reads back exactly through dotenv", copied.map((n) => back[n]), copied.map((n) => prod[n]));
	ok("no secret value is in the written file", !["k", "p", "abc", "secret@"].some((v) => text.includes(`='${v}'`) || text.includes(v + "@")) && !/GEMINI_API_KEY|SESSION_SECRET|NODE_ENV/.test(text));
	const out = tmp("replica-settings-");
	const app = tmp("replica-settings-app-");
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
	fs.writeFileSync(path.join(app, ".env"), Object.entries({ ...prod, NOT_READ_SETTING: "on" }).map(([k, v]) => `${k}="${v}"`).join("\n"));
	// The app this export reads: the allowlist is the names its code reads.
	fs.writeFileSync(path.join(app, "server.js"), copied.map((n) => `const x${n} = process.env.${n};`).join("\n"));
	fs.mkdirSync(path.join(app, "lib"));
	fs.writeFileSync(path.join(app, "lib", "a.js"), "module.exports = process.env.REPORT_SETTING;");
	const r = spawnSync(process.execPath, [path.join(REMOTE, "settings.js"), `--app=${app}`, `--out=${path.join(out, "settings.env")}`], { encoding: "utf8" });
	eq("settings.js exits 0", r.status, 0);
	const cli = r.status === 0 ? JSON.parse(r.stdout) : { copied: [], skipped: [] };
	ok("...and prints names, never a value", !/dispatch@example|gemini-2\.5|Sunday|smtp\.example|"k"|"p"|AIzaSy/.test(r.stdout) && cli.copied.length === 6);
	eq("...a setting no app code reads is skipped by the allowlist", (cli.skipped.find((x) => x.name === "NOT_READ_SETTING") || {}).rule, "not read by the app");
	eq("...and one the app reads that looks like a key is still skipped", (cli.skipped.find((x) => x.name === "REPORT_SETTING") || {}).rule, "secret: value looks like a key");
	eq("...writing the file 0600", (fs.statSync(path.join(out, "settings.env")).mode & 0o777).toString(8), "600");
}
{
	// This checkout's own server.js and lib/, read the way settings.js reads the
	// app on the server. Made-up values only.
	const app = tmp("replica-settings-real-");
	const out = tmp("replica-settings-real-out-");
	for (const f of ["node_modules", "server.js", "lib"]) fs.symlinkSync(path.join(ROOT, f), path.join(app, f));
	const wanted = {
		// read as env.NAME on the env a lib/ helper is handed
		LEDGER_DAY_ONCE_ENABLED: "true", LEDGER_DAY_ONCE_FROM: "2030-01", BROKER_INVOICE_LINES_ENABLED: "true",
		TRIP_WORK_DAYS_ENABLED: "false", TRIP_WORK_DAYS_FROM: "2030-01", DRIVER_RATE_ONLY_ENABLED: "false", DRIVER_RATE_ONLY_FROM: "2030-01",
		// read through a name table: env[flag.enabled], env[flag.from], env[s.env]
		INVOICE_BLANK_PICKUP_FALLBACK_ENABLED: "false", INVOICE_BLANK_PICKUP_FALLBACK_FROM: "2030-01",
		LEDGER_BLANK_DROPOFF_FALLBACK_ENABLED: "false", LEDGER_BLANK_DROPOFF_FALLBACK_FROM: "2030-01",
		INVESTOR_LEASE_DOWNTIME: "unpaid", INVESTOR_LEASE_PRORATE: "daily", INVESTOR_LEASE_RETIREMENT: "stop",
		// read as process.env.NAME
		PAYOUT_RULES_V2_ENABLED: "false", MARK_PAID_CLOSED_MONTH_ENABLED: "true",
	};
	const withheld = {
		INVOICE_BANK_ROUTING: "000000000", INVOICE_BANK_ACCOUNT: "000000000000",
		GEMINI_API_KEY: "made-up-key", SESSION_SECRET: "made-up-secret", GMAIL_APP_PASSWORD: "made-up-pass", LINXUP_WEBHOOK_TOKEN: "made-up-token",
		SPREADSHEET_ID: "made-up-sheet-id", BISON_INVOICE_EMAIL: "ap-bison@example.test", DEFAULT_INVOICE_EMAIL: "ap-default@example.test",
		N8N_BASE_URL: "https://n8n.example.test", N8N_WORKFLOW_ID: "made-up-workflow",
		ADMIN_NOTIFY_EMAIL: "admin-notify@example.test", RATECON_DRIVE_FOLDER_ID: "made-up-drive-folder",
	};
	fs.writeFileSync(path.join(app, ".env"), Object.entries({ ...wanted, ...withheld }).map(([k, v]) => `${k}="${v}"`).join("\n"));
	const r = spawnSync(process.execPath, [path.join(REMOTE, "settings.js"), `--app=${app}`, `--out=${path.join(out, "settings.env")}`], { encoding: "utf8" });
	eq("settings.js on this checkout's server.js and lib/ exits 0", r.status, 0);
	const cli = r.status === 0 ? JSON.parse(r.stdout) : { copied: [], skipped: [] };
	for (const n of Object.keys(wanted)) ok(`${n}, which the app reads, is copied`, cli.copied.includes(n), (cli.skipped.find((x) => x.name === n) || {}).rule);
	const written = r.status === 0 ? dotenv.parse(fs.readFileSync(path.join(out, "settings.env"))) : {};
	eq("...with its value exactly", Object.keys(wanted).map((n) => written[n]), Object.values(wanted));
	for (const n of Object.keys(withheld)) ok(`${n} is never copied`, !cli.copied.includes(n) && !(n in written) && cli.skipped.some((x) => x.name === n));
	const serverSrc = require("./lib/server-source").serverSource();
	for (const n of ["ADMIN_NOTIFY_EMAIL", "RATECON_DRIVE_FOLDER_ID"]) {
		ok(`${n} is never copied, though server.js reads it as plain process.env.${n}`, new RegExp(`process\\.env\\.${n}\\b`).test(serverSrc)
			&& (cli.skipped.find((x) => x.name === n) || {}).rule === "production only: names a production target", (cli.skipped.find((x) => x.name === n) || {}).rule);
	}
	ok("...and no withheld value is in the written file or the output", r.status === 0 && Object.values(withheld).every((v) => !fs.readFileSync(path.join(out, "settings.env"), "utf8").includes(v) && !r.stdout.includes(v)));
	// Every flag the replica rules know (and each one's first month) is one the
	// export finds read, without counting replica-rules.js's own lists.
	const sources = ["server.js", ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js") && f !== "replica-rules.js").map((f) => path.join("lib", f))]
		.map((f) => (f === "server.js" ? serverSrc : fs.readFileSync(path.join(ROOT, f), "utf8")));
	const read = rules.namesReadBy(sources);
	const known = [...rules.ENABLE_ALLOWED, ...Object.keys(rules.ENABLE_REFUSED), ...Object.values(rules.ENABLE_FROM)];
	eq("every flag the replica rules know is found read by server.js or lib/", known.filter((n) => !read.has(n)), []);
}
{
	// lib/replica-rules.js names settings only to judge them: a name that only
	// its lists or comments mention is not read by the app.
	const app = tmp("replica-settings-rules-");
	const out = tmp("replica-settings-rules-out-");
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(app, "node_modules"));
	fs.writeFileSync(path.join(app, "server.js"), "const r = process.env.ROUTEMATE_ENABLED;\n");
	fs.mkdirSync(path.join(app, "lib"));
	fs.writeFileSync(path.join(app, "lib", "replica-rules.js"), 'const ENABLE_ALLOWED = ["ONLY_IN_RULES_ENABLED"];\n// see "RULES_COMMENT_FROM"\n');
	fs.writeFileSync(path.join(app, ".env"), 'ROUTEMATE_ENABLED="true"\nONLY_IN_RULES_ENABLED="true"\nRULES_COMMENT_FROM="2030-01"\n');
	const r = spawnSync(process.execPath, [path.join(REMOTE, "settings.js"), `--app=${app}`, `--out=${path.join(out, "settings.env")}`], { encoding: "utf8" });
	const cli = r.status === 0 ? JSON.parse(r.stdout) : { copied: [], skipped: [] };
	const rule = (n) => (cli.skipped.find((x) => x.name === n) || {}).rule;
	ok("a name only lib/replica-rules.js lists or mentions in a comment is not read by the app", r.status === 0 && cli.copied.includes("ROUTEMATE_ENABLED")
		&& rule("ONLY_IN_RULES_ENABLED") === "not read by the app" && rule("RULES_COMMENT_FROM") === "not read by the app", { status: r.status, copied: cli.copied });
}

// ---- §4 rules and the pull scripts ------------------------------------------------------------
console.log("§4 stamps, tasks and the pull scripts");
{
	for (const s of ["20261008T0700Z", "20261008T082941Z-3fa1c2d9", "a", "x_1-2"]) ok(`stamp ${s} is accepted`, rules.isValidStamp(s));
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
	ok("pull.sh runs with umask 077", /^umask 077$/m.test(pull));

	// The stamp: unique per run, in the shape the server program and the guard accept.
	const stampLine = (pull.match(/^STAMP="\$\(date -u \+%Y%m%dT%H%M%SZ\)-\$\(od -An -N4 -tx1 \/dev\/urandom \| tr -d ' \\n'\)"$/m) || [])[0];
	ok("pull.sh stamps each run with the time and 8 random hex digits", !!stampLine);
	const stamps = stampLine ? [0, 1].map(() => spawnSync("bash", ["-c", `${stampLine}; printf %s "$STAMP"`], { encoding: "utf8" }).stdout) : [];
	ok("...two runs get different stamps, each one the guard's folder shape accepts", stamps.length === 2 && stamps[0] !== stamps[1] && stamps.every((s) => rules.isValidStamp(s) && /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(s)), stamps);

	// The server's folder must be confirmed gone, or the pull fails. The trap's
	// functions are run as pull.sh has them, with ssh standing in.
	const fn = (name) => (pull.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m")) || [""])[0];
	ok("pull.sh has remote_cleanup(), on_exit() and what they call", PULL_TRAP_FNS.every((f) => !!fn(f)), PULL_TRAP_FNS.filter((f) => !fn(f)));
	const exitWith = (sshStatus) => {
		const d = tmp("replica-exit-");
		const script = [
			"set -euo pipefail",
			`ssh() { return ${sshStatus}; }`,
			"SSH_OPTS=(-o BatchMode=yes); LOGISX_PROD_SSH=x; TMP_PARENT=/root/logisx-replica-tmp; STAMP=s1",
			`ROOT="${d}"; INCOMING="${d}/in"; LOCK="${d}/lock"; LOG="${d}/log"; REMOTE_STARTED=1; ${PULL_TRAP_VARS}`,
			"mkdir -p \"$LOCK\"",
			...PULL_TRAP_FNS.map(fn),
			"trap on_exit EXIT",
			"true",
		].join("\n");
		return spawnSync("bash", ["-c", script], { encoding: "utf8" });
	};
	const unconfirmed = exitWith(1);
	ok("a pull whose server folder cannot be confirmed removed exits non-zero", unconfirmed.status === 1 && /could not confirm the server's temporary folder/.test(unconfirmed.stderr), { status: unconfirmed.status });
	const confirmed = exitWith(0);
	ok("...and one whose folder is confirmed gone exits 0", confirmed.status === 0 && /temporary folder is removed/.test(confirmed.stdout), { status: confirmed.status });
	ok("the download step's own cleanup fails the pull too (pipefail)", /^set -euo pipefail$/m.test(pull) && /^remote_cleanup prod_ssh 2>&1 \| tee -a "\$LOG"$/m.test(pull));

	const begin = fs.readFileSync(path.join(REMOTE, "begin.sh"), "utf8");
	ok("the server program removes its folder when any step fails (its own trap)", /trap replica_remote_cleanup EXIT/.test(begin) && /rm -rf -- "\$TMP"/.test(begin));
	ok("...creates it mode 700 with umask 077, under /root/logisx-replica-tmp only", /umask 077/.test(begin) && /mkdir -m 700 -- "\$TMP"/.test(begin) && /\[ "\$TMP_PARENT" = \/root\/logisx-replica-tmp \]/.test(begin));
	// The stale-folder sweep, run as begin.sh has it, on a temporary parent.
	const sweep = (begin.match(/^if \[ -d "\$TMP_PARENT" \] && \[ ! -L "\$TMP_PARENT" \]; then\n[\s\S]*?\nfi\n/m) || [""])[0];
	ok("begin.sh sweeps stale folders first", !!sweep && begin.indexOf(sweep) < begin.indexOf('mkdir -m 700 -- "$TMP"'));
	{
		const parent = tmp("replica-stale-");
		const elsewhere = tmp("replica-elsewhere-");
		const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
		const mk = (name, m) => { const p = path.join(parent, name); fs.mkdirSync(p); fs.writeFileSync(path.join(p, "app.db"), "x"); fs.utimesSync(p, minutesAgo(m), minutesAgo(m)); return p; };
		mk("20261008T010000Z-aaaa1111", 7 * 60);
		mk("20261008T070000Z-cccc3333", 75);
		mk("20261008T070000Z-bbbb2222", 45);
		mk(".hidden-old", 7 * 60);
		const oldFile = path.join(parent, "20261008T020000Z-dddd4444");
		fs.writeFileSync(oldFile, "x");
		fs.utimesSync(oldFile, minutesAgo(7 * 60), minutesAgo(7 * 60));
		fs.symlinkSync(elsewhere, path.join(parent, "20261008T000000Z-link"));
		fs.writeFileSync(path.join(elsewhere, "keep"), "x");
		const r = spawnSync("bash", ["-c", `set -euo pipefail\nTMP_PARENT=${JSON.stringify(parent)}\n${sweep}`], { encoding: "utf8" });
		eq("...it removes stamp folders over an hour old (75 min, 7 h) and nothing else (a 45-minute one, an odd name, a file, a symlink)", [r.status, fs.readdirSync(parent).sort()], [0, [".hidden-old", "20261008T000000Z-link", "20261008T020000Z-dddd4444", "20261008T070000Z-bbbb2222"]]);
		ok("...never following a symlink", fs.existsSync(path.join(elsewhere, "keep")));
		ok("...and says how many it removed", /removed 2 stale temporary folder/.test(r.stdout));
		ok("...pull.sh's message names the same age", /the next pull removes it once it is an hour old/.test(pull) && !/6 hours/.test(pull));
	}

	const finish = fs.readFileSync(path.join(REMOTE, "finish.sh"), "utf8");
	const steps = finish.split("\n").filter((l) => /"\$NODE"/.test(l));
	ok("the server steps all run at low priority and never read the program's stdin", steps.length === 6 && steps.every((l) => /^"\$\{LOW\[@\]\}" "\$NODE" /.test(l) && /<\/dev\/null/.test(l)), steps);
	ok("...low priority is nice, plus ionice where the box has it", /^LOW=\(nice -n 10\)$/m.test(finish) && /command -v ionice >\/dev\/null 2>&1; then LOW\+=\(ionice -c 2 -n 7\)/.test(finish));
	const run = spawnSync("bash", ["-n", path.join(ROOT, "scripts", "replica", "pull.sh")], { encoding: "utf8" });
	eq("pull.sh parses", run.status, 0);
	for (const f of ["begin.sh", "finish.sh"]) eq(`remote/${f} parses`, spawnSync("bash", ["-n", path.join(REMOTE, f)]).status, 0);
	const noSsh = spawnSync("bash", [path.join(ROOT, "scripts", "replica", "pull.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp("replica-home-") } });
	ok("without LOGISX_PROD_SSH it stops before doing anything", noSsh.status !== 0 && /LOGISX_PROD_SSH/.test(noSsh.stderr));
}

// ---- §5 the compressed download -------------------------------------------------------------
(async () => {
	console.log("§5 the compressed download");
	const { compressFolder, FILES, LEVEL } = require(path.join(REMOTE, "compress.js"));
	const local = require(path.join(ROOT, "scripts", "replica", "pull-local.js"));
	const dir = tmp;
	const mode = (f) => fs.statSync(f).mode & 0o777;

	// A pull folder as manifest.js leaves it: a real database and a Sheets copy.
	const pullFolder = () => {
		const parent = dir("replica-zst-");
		const stamp = "20261011T0600Z-0a1b2c3d";
		const d = path.join(parent, stamp);
		fs.mkdirSync(d, { mode: 0o700 });
		const db = new Database(path.join(d, "app.db"));
		db.exec("CREATE TABLE loads (id INTEGER PRIMARY KEY, name TEXT, notes TEXT)");
		const ins = db.prepare("INSERT INTO loads (name, notes) VALUES (?, ?)");
		// One transaction: a file database commits (and syncs) each bare insert
		// on its own, which made these 3000 rows take seconds.
		db.transaction(() => {
			for (let i = 0; i < 3000; i++) ins.run(`load-${i}`, crypto.randomBytes(24).toString("hex"));
		})();
		db.close();
		fs.writeFileSync(path.join(d, "sheets.json"), JSON.stringify({ format: 1, spreadsheets: { s1: { role: "main", tabs: { "Job Tracking": [["Load ID"], ["1"]] } } } }));
		fs.writeFileSync(path.join(d, "manifest.json"), "{}");
		return { parent, stamp, d };
	};

	{
		const { parent, stamp, d } = pullFolder();
		const before = Object.fromEntries(FILES.map((f) => [f, { sha256: sha(path.join(d, f)), bytes: fs.statSync(path.join(d, f)).size }]));
		const run = spawnSync(process.execPath, [path.join(REMOTE, "compress.js"), `--stamp=${stamp}`, `--parent=${parent}`], { encoding: "utf8" });
		eq("compress.js exits 0", [run.status, run.stderr], [0, ""]);
		eq("...leaves each file only as <name>.zst, mode 600, beside compress.json", fs.readdirSync(d).sort(), ["app.db.zst", "compress.json", "manifest.json", "sheets.json.zst"]);
		ok("...every file it wrote is mode 600", ["app.db.zst", "sheets.json.zst", "compress.json"].every((f) => mode(path.join(d, f)) === 0o600));
		const summary = JSON.parse(fs.readFileSync(path.join(d, "compress.json"), "utf8"));
		eq("...compress.json records zstd level 6 and each original's size and SHA-256", [summary.codec, summary.level, summary.files.map((f) => [f.name, f.bytes, f.sha256])], ["zstd", 6, FILES.map((f) => [f, before[f].bytes, before[f].sha256])]);
		eq("...and each compressed file's size", summary.files.map((f) => f.compressed), FILES.map((f) => fs.statSync(path.join(d, `${f}.zst`)).size));
		ok("...the database shrinks", summary.files[0].compressed < summary.files[0].bytes / 2, summary.files[0]);
		ok("...its output names sizes only", /"step":"compress"/.test(run.stdout) && !/[0-9a-f]{64}/.test(run.stdout), run.stdout);
		eq("level 6, as approved", LEVEL, 6);

		const incoming = dir("replica-in-");
		for (const f of fs.readdirSync(d)) fs.copyFileSync(path.join(d, f), path.join(incoming, f));
		const said = [];
		let err = null;
		try { await local.unpack(incoming, (s) => said.push(s)); } catch (e) { err = e; }
		ok("unpack gives back the files", !err, err && err.message);
		eq("...byte-identical to the server's (SHA-256)", FILES.map((f) => fs.existsSync(path.join(incoming, f)) && sha(path.join(incoming, f))), FILES.map((f) => before[f].sha256));
		ok("...mode 600, with the .zst files gone", FILES.every((f) => mode(path.join(incoming, f)) === 0o600 && !fs.existsSync(path.join(incoming, `${f}.zst`))));
		ok("...and says each one matched", said.length === 2 && said.every((s) => /SHA-256 matches the server's/.test(s)), said);

		// Each refusal starts from a fresh copy of the server's folder.
		const refused = async (name, damage, re, kept = {}) => {
			const inc = dir("replica-bad-");
			for (const f of fs.readdirSync(d)) fs.copyFileSync(path.join(d, f), path.join(inc, f));
			damage(inc);
			let e = null;
			try { await local.unpack(inc, () => {}); } catch (x) { e = x; }
			ok(`unpack refuses ${name}`, e && re.test(e.message), e ? e.message : "no error");
			const left = FILES.map((f) => fs.existsSync(path.join(inc, f)) ? fs.readFileSync(path.join(inc, f), "utf8") === kept[f] ? "kept" : "LEFT" : "none");
			eq("...and leaves no file it decompressed behind", left, FILES.map((f) => (f in kept ? "kept" : "none")));
		};
		// Cuts a .zst short and says the server made it that size, so only the
		// decompressed size and SHA-256 can catch it (zstd may end without an error).
		const cutAndAgree = (inc, name) => {
			const f = path.join(inc, `${name}.zst`);
			fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2));
			const c = JSON.parse(fs.readFileSync(path.join(inc, "compress.json"), "utf8"));
			c.files.find((x) => x.name === name).compressed = fs.statSync(f).size;
			fs.writeFileSync(path.join(inc, "compress.json"), JSON.stringify(c));
		};
		await refused("a short download", (inc) => fs.truncateSync(path.join(inc, "app.db.zst"), 1000), /incomplete/);
		await refused("a damaged one (same size, one byte changed)", (inc) => {
			const f = path.join(inc, "app.db.zst");
			const b = fs.readFileSync(f);
			b[Math.floor(b.length / 2)] ^= 0xff;
			fs.writeFileSync(f, b);
		}, /damaged|SHA-256/);
		await refused("a file whose checksum differs from the server's", (inc) => {
			const f = path.join(inc, "compress.json");
			const c = JSON.parse(fs.readFileSync(f, "utf8"));
			c.files[0].sha256 = "0".repeat(64);
			fs.writeFileSync(f, JSON.stringify(c));
		}, /the server's was/);
		await refused("a download with no compress.json", (inc) => fs.rmSync(path.join(inc, "compress.json")), /no compress\.json/);
		await refused("a compress.json naming other files", (inc) => {
			const f = path.join(inc, "compress.json");
			const c = JSON.parse(fs.readFileSync(f, "utf8"));
			c.files[0].name = "../app.db";
			fs.writeFileSync(f, JSON.stringify(c));
		}, /does not list the files/);
		await refused("a cut-off file whose compressed size was made to agree", (inc) => cutAndAgree(inc, "app.db"), /the server's was|damaged/);
		await refused("a damaged second file, after the first matched", (inc) => cutAndAgree(inc, "sheets.json"), /sheets\.json.*(the server's was|damaged)/);
		await refused("a file already in the download folder, without touching it", (inc) => fs.writeFileSync(path.join(inc, "app.db"), "older"), /app\.db is already in the download folder/, { "app.db": "older" });
		{
			const inc = dir("replica-bad-");
			for (const f of fs.readdirSync(d)) fs.copyFileSync(path.join(d, f), path.join(inc, f));
			cutAndAgree(inc, "sheets.json");
			try { await local.unpack(inc, () => {}); } catch { /* refused above */ }
			ok("...and the .zst files stay until every file has matched", FILES.every((f) => fs.existsSync(path.join(inc, `${f}.zst`))));
		}
	}
	{
		const { parent, stamp, d } = pullFolder();
		fs.writeFileSync(path.join(d, "app.db.zst"), "x");
		const run = spawnSync(process.execPath, [path.join(REMOTE, "compress.js"), `--stamp=${stamp}`, `--parent=${parent}`], { encoding: "utf8" });
		ok("compress.js refuses an existing .zst and keeps the original", run.status === 1 && /already exists/.test(run.stderr) && fs.existsSync(path.join(d, "app.db")), run.stderr);
		const bad = spawnSync(process.execPath, [path.join(REMOTE, "compress.js"), "--stamp=../x", `--parent=${parent}`], { encoding: "utf8" });
		ok("...and a stamp that isn't one", bad.status === 1 && /stamp/.test(bad.stderr));
		let e = null;
		try { await compressFolder(path.join(parent, "no-such-stamp")); } catch (x) { e = x; }
		ok("...and a folder with nothing to compress", e && /app\.db is missing/.test(e.message));
	}
	{
		const { parent, stamp, d } = pullFolder();
		fs.renameSync(path.join(d, "app.db"), path.join(d, "real.db"));
		fs.symlinkSync(path.join(d, "real.db"), path.join(d, "app.db"));
		const run = spawnSync(process.execPath, [path.join(REMOTE, "compress.js"), `--stamp=${stamp}`, `--parent=${parent}`], { encoding: "utf8" });
		ok("compress.js refuses an app.db that isn't a regular file (a link)", run.status === 1 && /not a regular file/.test(run.stderr) && !fs.existsSync(path.join(d, "app.db.zst")), run.stderr);
	}

	// The server's folder goes, compressed files included, on success (the
	// download step's cleanup), on any failure and on an interruption (the
	// trap), each run as pull.sh has it with ssh running the command here.
	{
		const pull = fs.readFileSync(path.join(ROOT, "scripts", "replica", "pull.sh"), "utf8");
		const fn = (name) => (pull.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m")) || [""])[0];
		const traps = ["trap on_exit EXIT", "trap 'exit 130' INT TERM HUP"];
		ok("pull.sh traps EXIT and INT, TERM, HUP", traps.every((t) => pull.split("\n").includes(t)));
		const serverFolder = () => {
			const parent = dir("replica-srv-");
			fs.mkdirSync(path.join(parent, "s1"));
			for (const f of ["app.db.zst", "sheets.json.zst", "compress.json", "manifest.json"]) fs.writeFileSync(path.join(parent, "s1", f), "x");
			return parent;
		};
		const script = (parent, body) => [
			"set -euo pipefail",
			'ssh() { bash -c "${!#}"; }',
			`SSH_OPTS=(-o BatchMode=yes); LOGISX_PROD_SSH=x; TMP_PARENT=${JSON.stringify(parent)}; STAMP=s1`,
			`ROOT=${JSON.stringify(parent)}; INCOMING=${JSON.stringify(path.join(parent, "in"))}; LOCK=${JSON.stringify(path.join(parent, "lock"))}; LOG=/dev/null; REMOTE_STARTED=1; ${PULL_TRAP_VARS}`,
			'mkdir -p "$LOCK"',
			...PULL_TRAP_FNS.map(fn),
			...traps,
			body,
		].join("\n");
		{
			const parent = serverFolder();
			const r = spawnSync("bash", ["-c", script(parent, "remote_cleanup prod_ssh\nREMOTE_STARTED=0")], { encoding: "utf8" });
			ok("after the download, the cleanup removes the folder with its compressed files", r.status === 0 && !fs.existsSync(path.join(parent, "s1")), { status: r.status, err: r.stderr });
		}
		{
			const parent = serverFolder();
			const r = spawnSync("bash", ["-c", script(parent, "false")], { encoding: "utf8" });
			ok("a failed step removes it through the trap", r.status === 1 && !fs.existsSync(path.join(parent, "s1")), { status: r.status, err: r.stderr });
		}
		for (const sig of ["INT", "TERM", "HUP"]) {
			const parent = serverFolder();
			const r = spawnSync("bash", ["-c", script(parent, `kill -${sig} $$\nsleep 5`)], { encoding: "utf8", timeout: 15000 });
			ok(`an interruption (SIG${sig}) removes it too and the pull exits 130`, r.status === 130 && !fs.existsSync(path.join(parent, "s1")), { status: r.status, err: r.stderr });
		}
		const begin = fs.readFileSync(path.join(REMOTE, "begin.sh"), "utf8");
		const trapFn = (begin.match(/^replica_remote_cleanup\(\) \{\n[\s\S]*?\n\}\n/m) || [""])[0];
		{
			// The server program's own trap, when a step fails part way (a half-written .zst).
			const parent = serverFolder();
			const r = spawnSync("bash", ["-c", ["set -euo pipefail", `TMP_PARENT=${JSON.stringify(parent)}; TMP="$TMP_PARENT/s1"; REPLICA_REMOTE_OK=0`, trapFn, "trap replica_remote_cleanup EXIT", "false"].join("\n")], { encoding: "utf8" });
			ok("on the server, a failed step removes the folder with its compressed files", !!trapFn && r.status === 1 && !fs.existsSync(path.join(parent, "s1")), { status: r.status, err: r.stderr });
		}

		const rsyncLines = pull.split("\n").filter((l) => /^\s*rsync /.test(l));
		ok("every rsync shows progress through pull-local.js progress, never straight to the log", rsyncLines.length === 2 && rsyncLines.every((l) => / --progress /.test(l) && /\| "\$NODE_BIN" "\$HERE\/pull-local\.js" progress /.test(l) && !/tee/.test(l)), rsyncLines);
		ok("the download is whole: no seed from the last snapshot", !/cp -c?R "\$ROOT\/clean\/\."/.test(pull));
		ok("pull.sh streams compress.js to the server", /^REMOTE_FILES=\(.* compress\.js\)$/m.test(pull));
		const CHECK = 'if (typeof require("zlib").createZstdDecompress !== "function") process.exit(3); new (require(process.argv[1]))(":memory:").close();';
		const precheck = pull.indexOf(`"$NODE_BIN" -e '${CHECK}' "$REPO/node_modules/better-sqlite3"`);
		ok("...checks the local Node's zstd and better-sqlite3 (opening a database, so the binary loads) after the freshness check and before the server does any work", precheck > pull.indexOf("# Fresh enough?") && precheck < pull.search(/^LOCK="/m) && precheck < pull.search(/^open_conn$/m) && pull.search(/^open_conn$/m) < pull.search(/^remote_program \| prod_ssh /m), precheck);
		ok("...and the unpack and verify errors reach the log", /pull-local\.js" unpack "\$INCOMING" 2>&1 \| tee -a "\$LOG"/.test(pull) && /pull-local\.js" verify "\$INCOMING" 2>&1 \| tee -a "\$LOG"/.test(pull));
		const pre = spawnSync(process.execPath, ["-e", CHECK, path.join(ROOT, "node_modules", "better-sqlite3")], { encoding: "utf8" });
		eq("...a check this Node passes", pre.status, 0);
		// A stand-in better-sqlite3 that loads but can't open a database, as a
		// binary built for another Node does.
		const fakeMod = dir("replica-fake-bs3-");
		fs.writeFileSync(path.join(fakeMod, "index.js"), "module.exports = function Database() { throw new Error('NODE_MODULE_VERSION mismatch'); };");
		const preBad = spawnSync(process.execPath, ["-e", CHECK, fakeMod], { encoding: "utf8" });
		ok("...and one a better-sqlite3 built for another Node fails", preBad.status !== 0);
		const at = (re) => pull.search(re);
		const order = [/^remote_cleanup prod_ssh 2>&1 \| tee -a "\$LOG"$/m, /pull-local\.js" unpack "\$INCOMING"/, /pull-local\.js" verify "\$INCOMING"/, /^mv "\$INCOMING" "\$ROOT\/clean"$/m].map(at);
		ok("after the download: the server's folder goes, then unpack, then verify, then the swap", order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), order);
		const finish = fs.readFileSync(path.join(REMOTE, "finish.sh"), "utf8");
		ok("on the server, compress.js runs after manifest.js", finish.indexOf("compress.js") > finish.indexOf("manifest.js") && finish.indexOf("compress.js") < finish.indexOf('rm -f -- "$TMP"/*.js'));
	}

	// The progress filter, on openrsync's own output with names a person could have.
	{
		const SAMPLE = [
			"app.db.zst\n",
			"     1081344  36%    1.03MB/s    00:00:01\r",
			"     2097152  70%  992.00KB/s    00:00:00\r",
			"     3000000 100%    1.42MB/s    00:00:02 (xfer#1, to-check=1/3)\n",
			// A top-level name shaped like a stats line, and openrsync's own error about it.
			"Total jane doe.pdf\n",
			"rsync(40131): error: uploads/jane doe.pdf: open: Permission denied\n",
			"driver-jane-doe-license.jpg\n",
			"           3 100%   13.82KB/s    00:00:00 (xfer#2, to-check=2/3)\n",
			"Number of files: 3\nNumber of files transferred: 2\nTotal file size: 3000003 B\n",
			"sent 3000548 bytes  received 64 bytes  2467203200000 bytes/sec\ntotal size is 3000003  speedup is 1.00\n",
			"rsync: connection unexpectedly closed (0 bytes received so far) [receiver]\n",
			// openrsync's, GNU rsync's and ssh's errors, as a failed download prints them.
			"rsync(40131): error: unexpected end of file\n",
			'rsync: [sender] send_files failed to open "/var/www/app/uploads/jane doe.pdf": Permission denied (13)\n',
			"ssh: connect to host box.example port 22: Connection refused\n",
			"Connection closed by 192.0.2.10 port 22\n",
			"Received disconnect from 2001:db8:0:0:0:0:0:1 port 22:2: Too many authentication failures\n",
			"Connection closed by 2001:db8::1 port 22\n",
			"ssh: Could not resolve hostname box.example.com: nodename nor servname provided, or not known\n",
			"openrsync(4242): error: uploads/jane doe.pdf: open: Permission denied\n",
			"rsync(4242): error: jane doe.pdf: partial cleanup failed, left at .jane doe.pdf.Ab12Cd\n",
		].join("");
		const run = (tty, chunks) => {
			let clock = 0;
			let out = "";
			const logged = [];
			const f = local.progressFilter({ label: "download", tty, write: (s) => { out += s; }, log: (l) => logged.push(l), now: () => clock, every: 30000 });
			for (const c of chunks) { f.push(c); clock += 10000; }
			f.end();
			return { out, logged };
		};
		const pieces = (text, n) => Array.from({ length: Math.ceil(text.length / n) }, (_, i) => text.slice(i * n, (i + 1) * n));
		for (const tty of [false, true]) {
			const { out, logged } = run(tty, pieces(SAMPLE, 37));
			const where = tty ? "on a terminal" : "off a terminal";
			ok(`the progress filter never shows a file name, a path or the host (${where})`, !/jane|doe|app\.db\.zst|\.jpg|\.pdf|\/var\/www|box\.example|192\.0\.2|2001:db8/.test(out), out);
			ok(`...nor logs one, and the log has no progress lines (${where})`, !/jane|doe|\.jpg|\.pdf|app\.db\.zst|\/var\/www|box\.example|192\.0\.2|2001:db8|%|\r/.test(logged.join("\n")), logged);
			ok(`...shows bytes, percent, rate and time left (${where})`, /download: 1\.0 MiB so far, 1\.03MB\/s; this file 36%, 00:00:01 left/.test(out), out);
			eq(`...logs rsync's stats as they are, and its and ssh's errors with the names taken out (${where})`, logged, [
				"rsync(40131): error: <…>: Permission denied",
				"Number of files: 3", "Number of files transferred: 2", "Total file size: 3000003 B",
				"sent 3000548 bytes  received 64 bytes  2467203200000 bytes/sec", "total size is 3000003  speedup is 1.00",
				"rsync: connection unexpectedly closed (0 bytes received so far) [receiver]",
				"rsync(40131): error: unexpected end of file",
				'rsync: [sender] send_files failed to open "<…>": Permission denied (13)',
				"ssh: connect to host <host> port 22: Connection refused",
				"Connection closed by <address> port 22",
				"Received disconnect from <address> port 22:2: Too many authentication failures",
				"Connection closed by <address> port 22",
				"ssh: Could not resolve hostname <host>: nodename nor servname provided, or not known",
				"openrsync(4242): error: <…>: Permission denied",
				"rsync(4242): error: <…>: <…>",
			]);
			ok(`...and shows those errors too (${where})`, /rsync\(40131\): error: unexpected end of file\nrsync: \[sender\]/.test(out) && /ssh: connect to host <host> port 22: Connection refused/.test(out), out);
		}
		const total = run(false, [SAMPLE]).out;
		ok("...counts the bytes so far over every file, and prints the latest before the stats", /download: 2\.9 MiB so far, 13\.82KB\/s\nNumber of files: 3/.test(total), total);
		const term = run(true, [SAMPLE]).out;
		ok("on a terminal the status line is redrawn in place, and ends before the stats", /\rdownload: [^\n]*\x1b\[K\nNumber of files: 3/.test(term), term);
		const quiet = run(false, pieces(SAMPLE, 9));
		const lines = quiet.out.split("\n").filter((l) => l.startsWith("download:"));
		ok("off a terminal a status line is printed at most every 30 s, plus the last one", lines.length >= 2 && lines.length < 6 && !/\r/.test(quiet.out), lines);
		const gnu = run(false, ["      32,768   0%    0.00kB/s    0:00:00\r 65,536,000 100%   10.00MB/s    0:00:06 (xfr#1, to-chk=0/1)\n"]).out;
		ok("...and reads GNU rsync's commas", /download: 62\.5 MiB so far, 10\.00MB\/s\n/.test(gnu), gnu);
	}

	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	return failures ? 1 : 0;
})().catch((err) => {
	console.error(err);
	return 1;
}).then((code) => process.exit(code));
