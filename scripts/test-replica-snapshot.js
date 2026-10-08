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
//   §2 scrub.js clears sessions and every credential column (snake_case or
//      camelCase) in the COPY, keeps every other value, refuses the live
//      database, and leaves none of the removed values anywhere in the file's
//      bytes: planted values are searched for, a plain DELETE is shown to leave
//      them behind, and a value that lives on elsewhere fails the step
//   §3 settings.js copies business settings only: secrets by name, a URL
//      carrying credentials, a value that looks like a key, runtime settings and
//      any name the app's code does not read are skipped, by rule and name;
//      what it writes reads back exactly through dotenv
//   §4 the stamp (unique per run) and task rules; the pull scripts keep the
//      production host out of the repository, fail when the server's folder
//      cannot be confirmed gone, sweep stale folders, and run at low priority
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
console.log("§2 the scrub clears tokens and sessions in the copy, out of its bytes too");
{
	// Distinctive values, so a search of the file's bytes can only find these.
	const P = (tag) => `PLANTED-${tag}-${crypto.randomBytes(8).toString("hex")}`;
	const planted = { sid1: P("sid1"), sid2: P("sid2"), tok: P("access"), inv1: P("invite1"), inv2: P("invite2"), oauth: P("oauth"), api: P("apikey"), reset: P("resetcode") };
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
			CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT);
		`);
		const ins = (sql, ...a) => db.prepare(sql).run(...a);
		ins("INSERT INTO sessions VALUES (?, '{}', '2026-12-01'), (?, '{}', '2026-12-01')", planted.sid1, planted.sid2);
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
	eq("business settings are copied", copied, ["CSRF_HEADER_REQUIRED", "DRIVE_FOLDER_ID", "GEMINI_OCR_MODEL", "GMAIL_USER", "MAINTENANCE_NOTICE_MESSAGE", "PLAIN_URL", "RATECON_RECONCILE_MAILBOX", "ROUTEMATE_ENABLED"]);
	const rule = (n) => (skipped.find((s) => s.name === n) || {}).rule;
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
	ok("...and prints names, never a value", !/dispatch@example|gemini-2\.5|Sunday|smtp\.example|"k"|"p"|AIzaSy/.test(r.stdout) && cli.copied.length === 8);
	eq("...a setting no app code reads is skipped by the allowlist", (cli.skipped.find((x) => x.name === "NOT_READ_SETTING") || {}).rule, "not read by the app");
	eq("...and one the app reads that looks like a key is still skipped", (cli.skipped.find((x) => x.name === "REPORT_SETTING") || {}).rule, "secret: value looks like a key");
	eq("...writing the file 0600", (fs.statSync(path.join(out, "settings.env")).mode & 0o777).toString(8), "600");
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

	// The server's folder must be confirmed gone, or the pull fails. The two
	// functions are run as pull.sh has them, with ssh standing in.
	const fn = (name) => (pull.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m")) || [""])[0];
	ok("pull.sh has remote_cleanup() and on_exit()", !!fn("remote_cleanup") && !!fn("on_exit"));
	const exitWith = (sshStatus) => {
		const d = tmp("replica-exit-");
		const script = [
			"set -euo pipefail",
			`ssh() { return ${sshStatus}; }`,
			"SSH_OPTS=(-o BatchMode=yes); LOGISX_PROD_SSH=x; TMP_PARENT=/root/logisx-replica-tmp; STAMP=s1",
			`INCOMING="${d}/in"; LOCK="${d}/lock"; LOG="${d}/log"; REMOTE_STARTED=1`,
			"mkdir -p \"$LOCK\"",
			fn("remote_cleanup"), fn("on_exit"),
			"trap on_exit EXIT",
			"true",
		].join("\n");
		return spawnSync("bash", ["-c", script], { encoding: "utf8" });
	};
	const unconfirmed = exitWith(1);
	ok("a pull whose server folder cannot be confirmed removed exits non-zero", unconfirmed.status === 1 && /could not confirm the server's temporary folder/.test(unconfirmed.stderr), { status: unconfirmed.status });
	const confirmed = exitWith(0);
	ok("...and one whose folder is confirmed gone exits 0", confirmed.status === 0 && /temporary folder is removed/.test(confirmed.stdout), { status: confirmed.status });
	ok("the download step's own cleanup fails the pull too (pipefail)", /^set -euo pipefail$/m.test(pull) && /^remote_cleanup 2>&1 \| tee -a "\$LOG"$/m.test(pull));

	const begin = fs.readFileSync(path.join(REMOTE, "begin.sh"), "utf8");
	ok("the server program removes its folder when any step fails (its own trap)", /trap replica_remote_cleanup EXIT/.test(begin) && /rm -rf -- "\$TMP"/.test(begin));
	ok("...creates it mode 700 with umask 077, under /root/logisx-replica-tmp only", /umask 077/.test(begin) && /mkdir -m 700 -- "\$TMP"/.test(begin) && /\[ "\$TMP_PARENT" = \/root\/logisx-replica-tmp \]/.test(begin));
	// The stale-folder sweep, run as begin.sh has it, on a temporary parent.
	const sweep = (begin.match(/^if \[ -d "\$TMP_PARENT" \] && \[ ! -L "\$TMP_PARENT" \]; then\n[\s\S]*?\nfi\n/m) || [""])[0];
	ok("begin.sh sweeps stale folders first", !!sweep && begin.indexOf(sweep) < begin.indexOf('mkdir -m 700 -- "$TMP"'));
	{
		const parent = tmp("replica-stale-");
		const elsewhere = tmp("replica-elsewhere-");
		const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);
		const mk = (name, h) => { const p = path.join(parent, name); fs.mkdirSync(p); fs.writeFileSync(path.join(p, "app.db"), "x"); fs.utimesSync(p, hoursAgo(h), hoursAgo(h)); return p; };
		mk("20261008T010000Z-aaaa1111", 7);
		mk("20261008T070000Z-bbbb2222", 1);
		mk(".hidden-old", 7);
		fs.symlinkSync(elsewhere, path.join(parent, "20261008T000000Z-link"));
		fs.writeFileSync(path.join(elsewhere, "keep"), "x");
		const r = spawnSync("bash", ["-c", `set -euo pipefail\nTMP_PARENT=${JSON.stringify(parent)}\n${sweep}`], { encoding: "utf8" });
		eq("...it removes a stamp folder over 6 hours old and nothing else (a young one, an odd name, a symlink)", [r.status, fs.readdirSync(parent).sort()], [0, [".hidden-old", "20261008T000000Z-link", "20261008T070000Z-bbbb2222"]]);
		ok("...never following a symlink", fs.existsSync(path.join(elsewhere, "keep")));
		ok("...and says how many it removed", /removed 1 stale temporary folder/.test(r.stdout));
	}

	const finish = fs.readFileSync(path.join(REMOTE, "finish.sh"), "utf8");
	const steps = finish.split("\n").filter((l) => /"\$NODE"/.test(l));
	ok("the server steps all run at low priority and never read the program's stdin", steps.length === 5 && steps.every((l) => /^"\$\{LOW\[@\]\}" "\$NODE" /.test(l) && /<\/dev\/null/.test(l)), steps);
	ok("...low priority is nice, plus ionice where the box has it", /^LOW=\(nice -n 10\)$/m.test(finish) && /command -v ionice >\/dev\/null 2>&1; then LOW\+=\(ionice -c 2 -n 7\)/.test(finish));
	const run = spawnSync("bash", ["-n", path.join(ROOT, "scripts", "replica", "pull.sh")], { encoding: "utf8" });
	eq("pull.sh parses", run.status, 0);
	for (const f of ["begin.sh", "finish.sh"]) eq(`remote/${f} parses`, spawnSync("bash", ["-n", path.join(REMOTE, f)]).status, 0);
	const noSsh = spawnSync("bash", [path.join(ROOT, "scripts", "replica", "pull.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp("replica-home-") } });
	ok("without LOGISX_PROD_SSH it stops before doing anything", noSsh.status !== 0 && /LOGISX_PROD_SSH/.test(noSsh.stderr));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
