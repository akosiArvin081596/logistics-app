#!/usr/bin/env node
// Replica mode (LOCAL_REPLICA=1, lib/replica-mode.js): a local copy of
// production that can reach no real person and no real service.
//
//   §1 the rules: which settings are secrets (by name, by a URL or a value that
//      looks like a key, by the allowlist of names the app reads), which
//      credentials and proxy settings refuse a start
//   §2 the start refusals: anywhere but macOS, without replica:start's marker,
//      NODE_ENV=production, a server (pm2, root, a server path, a hosting host
//      name), any outbound credential or proxy setting, a database or data
//      folder outside the task's working copy, a settings file or guard log
//      outside ~/LogisX-replica
//   §3 server.js, read: replica mode boots before dotenv and a .env-only
//      LOCAL_REPLICA is checked right after it; every runtime data path goes
//      through DATA_DIR; every boot-time job asks startsJob(); every outbound
//      path (Sheets, Drive, mail, IMAP, n8n, HTTP, OCR, ELD and scan providers,
//      Chromium) is off in a replica; every secret-named variable the app reads
//      is an outbound credential the boot refuses
//   §4 the network guard refuses and records every non-loopback socket, DNS
//      query and fetch, holds "localhost" to loopback answers, and lets
//      loopback through
//   §5 the file guard refuses .env files and Google keys, and nothing else
//   §6 the banner is on every page, and nothing else is touched
//   §7 server.js itself: refusals exit before listening (LOCAL_REPLICA=1 set
//      only by a .env file included), and a good boot serves the banner (login
//      page included), starts no scheduled job, uses the local Sheets copy,
//      never reads the .env or the key file beside it, and attempts no outbound
//      connection. The test child is preloaded with a shim reporting macOS, so
//      this runs in CI's Linux too; a child reporting Linux is refused
//   §8 outside replica mode nothing changes: boot() returns null for any value
//      but 1 (off values silently, a stray one with a warning) and patches
//      nothing; after dotenv, a server-like run carries on for every value but
//      LOCAL_REPLICA=1 from a .env file; DATA_DIR is the app directory
//
// Standalone: node scripts/test-replica-mode.js. Temporary folders only (HOME is
// pointed at one for the boots), port 0, no network.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const MODE = path.join(ROOT, "lib", "replica-mode.js");
const replica = require(MODE);
const rules = require(path.join(ROOT, "lib", "replica-rules.js"));
const SRC = fs.readFileSync(SERVER, "utf8");

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// A replica folder under a temporary HOME, as replica:pull and replica:start leave it.
function replicaHome({ settings = "", task = "t1", sheetsId = "replica-test-main" } = {}) {
	const home = tmp("replica-home-");
	const root = path.join(home, "LogisX-replica");
	const work = path.join(root, "work", task);
	fs.mkdirSync(path.join(work, "uploads"), { recursive: true });
	fs.mkdirSync(path.join(root, "logs"), { recursive: true });
	fs.writeFileSync(path.join(root, "settings.env"), settings);
	fs.writeFileSync(path.join(work, "app.db"), "");
	fs.writeFileSync(path.join(work, "sheets.json"), JSON.stringify({
		format: 1,
		spreadsheets: {
			[sheetsId]: {
				role: "main",
				properties: { title: "test" },
				sheets: [{ properties: { sheetId: 0, title: "Job Tracking", index: 0, gridProperties: { rowCount: 10, columnCount: 5 } }, values: [["Load ID", "Driver"]], formulas: {} }],
			},
		},
	}));
	const env = {
		LOCAL_REPLICA: "1",
		LOGISX_REPLICA_TASK: task,
		DATABASE_PATH: path.join(work, "app.db"),
		LOGISX_REPLICA_DATA_DIR: work,
		LOGISX_REPLICA_GUARD_LOG: path.join(root, "logs", "outbound.log"),
		NODE_ENV: "development",
		[rules.LAUNCHER_ENV]: rules.LAUNCHER_VALUE,
	};
	return { home, root, work, env };
}

(async () => {
	// ---- §1 rules ---------------------------------------------------------------
	console.log("§1 the rules");
	for (const n of ["GEMINI_API_KEY", "GMAIL_APP_PASSWORD", "SESSION_SECRET", "LINXUP_WEBHOOK_TOKEN", "SMTP_HOST", "SENTRY_DSN", "MY_PRIVATE_X", "GOOGLE_APPLICATION_CREDENTIALS", "N8N_INVOICE_WEBHOOK_URL", "OAUTH_X"]) {
		ok(`${n} is a secret by name`, rules.isSecretName(n));
	}
	for (const n of ["ROUTEMATE_ENABLED", "GMAIL_USER", "GOOGLE_DRIVE_FOLDER_ID", "RATECON_RECONCILE_MAILBOX", "LINXUP_SPEED_UNIT"]) ok(`${n} is a business setting`, !rules.isSecretName(n));
	ok("a URL with userinfo carries credentials", rules.isCredentialUrl("https://u:p@h.example.test/x"));
	ok("a URL with ?api_key= carries credentials", rules.isCredentialUrl("https://h.example.test/x?api_key=1"));
	ok("a plain URL does not", !rules.isCredentialUrl("https://h.example.test/help?page=2"));
	ok("a URL with a token-like path segment carries credentials", rules.isCredentialUrl("https://hooks.example.test/services/T01/B02/aB3dE5fG7hI9jK1lM3nO5pQ7"));
	ok("...a URL with ordinary path words does not", !rules.isCredentialUrl("https://logisx.example.test/help/driver-guide-2026"));
	ok("a value that looks like a key is one", rules.isBareKeyValue("SOME_SETTING", "AIzaSyD3x9EXAMPLEEXAMPLE12345"));
	ok("...so is a long hex value", rules.isBareKeyValue("SOME_SETTING", "0123456789abcdef0123456789abcdef"));
	for (const [n, v] of [["GEMINI_OCR_MODEL", "gemini-2.5-flash"], ["RATECON_RECONCILE_MAILBOX", "[Gmail]/All Mail"], ["GMAIL_USER", "dispatch@example.test"], ["ROUTEMATE_POLL_LIVE_SEC", "60"], ["GOOGLE_DRIVE_FOLDER_ID", "1VAMgB8xQe50xs-PuX-WW3yL6Hom2xetL"]]) {
		ok(`${n}'s kind of value is not taken for a key`, !rules.isBareKeyValue(n, v));
	}
	eq("a setting the app does not read is skipped by the allowlist", rules.classifySetting("SOMETHING_ELSE", "x", { readByApp: new Set(["ROUTEMATE_ENABLED"]) }).rule, "not read by the app");
	eq("...one it reads is copied", rules.classifySetting("ROUTEMATE_ENABLED", "true", { readByApp: new Set(["ROUTEMATE_ENABLED"]) }).copy, true);
	eq("namesReadBy lists process.env names", [...rules.namesReadBy(["process.env.A_B || process.env.C"])].sort(), ["A_B", "C"]);
	eq("proxy settings are found in any case, and NODE_USE_ENV_PROXY", rules.proxySettingsSet({ https_proxy: "x", HTTP_PROXY: "y", All_Proxy: "z", NODE_USE_ENV_PROXY: "1", NO_PROXY: "localhost", PATH: "/bin" }), ["All_Proxy", "HTTP_PROXY", "NODE_USE_ENV_PROXY", "https_proxy"]);
	eq("outboundCredentialsSet names credentials, ignores empties and SESSION_SECRET", rules.outboundCredentialsSet({ GEMINI_API_KEY: "x", GOOGLE_MAPS_API_KEY: "", SESSION_SECRET: "s", ROUTEMATE_ENABLED: "true", FEED: "https://a:b@x.example.test" }), ["FEED (a URL carrying credentials)", "GEMINI_API_KEY"]);
	for (const n of rules.OUTBOUND_CREDENTIALS) ok(`${n} refuses a start`, rules.outboundCredentialsSet({ [n]: "x" }).length === 1);

	// ---- §2 refusals ---------------------------------------------------------------
	console.log("§2 the start refusals");
	{
		const h = replicaHome();
		const base = { env: h.env, appDir: ROOT, cwd: h.work, uid: 501, hostname: "dev-mac.local", home: h.home, platform: "darwin" };
		eq("a well-formed replica may start", replica.refusals(base), []);
		const has = (name, ctx, re) => {
			const r = replica.refusals({ ...base, ...ctx });
			ok(name, r.some((x) => re.test(x)), r);
		};
		has("NODE_ENV=production refuses", { env: { ...h.env, NODE_ENV: "production" } }, /NODE_ENV is production/);
		has("pm2 in the environment refuses", { env: { ...h.env, pm_id: "4" } }, /running under pm2/);
		has("running as root refuses", { uid: 0 }, /running as root/);
		has("an app directory under /var/www refuses", { appDir: "/var/www/logistics-app" }, /app directory .* is under a server path/);
		has("a working directory under /var/www refuses", { cwd: "/var/www/logisx-staging" }, /working directory .* is under a server path/);
		has("a hosting host name refuses", { hostname: "srv1000001.example.cloud" }, /looks like a server's/);
		has("a database outside ~/LogisX-replica refuses", { env: { ...h.env, DATABASE_PATH: path.join(tmp("elsewhere-"), "app.db") } }, /DATABASE_PATH .* is not under/);
		has("a data folder outside ~/LogisX-replica refuses", { env: { ...h.env, LOGISX_REPLICA_DATA_DIR: tmp("elsewhere-") } }, /LOGISX_REPLICA_DATA_DIR .* is not under/);
		has("a settings file outside ~/LogisX-replica refuses", { env: { ...h.env, LOGISX_REPLICA_SETTINGS: path.join(tmp("elsewhere-"), "settings.env") } }, /settings file .* is not under/);
		has("a guard log outside ~/LogisX-replica refuses", { env: { ...h.env, LOGISX_REPLICA_GUARD_LOG: path.join(tmp("elsewhere-"), "g.log") } }, /guard log .* is not under/);
		has("a symlink out of the replica folder is followed and refused", (() => {
			const out = tmp("elsewhere-");
			fs.symlinkSync(out, path.join(h.root, "escape"));
			return { env: { ...h.env, DATABASE_PATH: path.join(h.root, "escape", "app.db") } };
		})(), /DATABASE_PATH .* is not under/);
		has("no DATABASE_PATH refuses", { env: { ...h.env, DATABASE_PATH: "" } }, /DATABASE_PATH .* is not set/);
		has("a missing replica folder refuses", { home: tmp("empty-home-") }, /does not exist \(run npm run replica:pull\)/);
		has("a replica folder inside the app directory refuses", { appDir: h.home }, /inside the app directory/);
		has("any outbound credential refuses", { env: { ...h.env, GMAIL_APP_PASSWORD: "x" } }, /outbound credentials are set: GMAIL_APP_PASSWORD/);
		has("GOOGLE_APPLICATION_CREDENTIALS refuses", { env: { ...h.env, GOOGLE_APPLICATION_CREDENTIALS: "/k.json" } }, /GOOGLE_APPLICATION_CREDENTIALS/);
		has("BIND_HOST other than loopback refuses", { env: { ...h.env, BIND_HOST: "0.0.0.0" } }, /BIND_HOST is 0\.0\.0\.0/);
		has("a bad task name refuses", { env: { ...h.env, LOGISX_REPLICA_TASK: "../x" } }, /LOGISX_REPLICA_TASK/);
		has("anywhere but macOS refuses", { platform: "linux" }, /a replica runs on a developer Mac \(macOS\) only/);
		const noMarker = { ...h.env };
		delete noMarker[rules.LAUNCHER_ENV];
		has("a start without replica:start's marker refuses", { env: noMarker }, /not started by replica:start/);
		has("a proxy setting refuses (any case)", { env: { ...h.env, https_proxy: "http://127.0.0.1:9" } }, /proxy settings are set: https_proxy/);
		has("NODE_USE_ENV_PROXY refuses", { env: { ...h.env, NODE_USE_ENV_PROXY: "1" } }, /proxy settings are set: NODE_USE_ENV_PROXY/);
		has("a database in the clean snapshot refuses (only the task's working copy)", { env: { ...h.env, DATABASE_PATH: path.join(h.root, "clean", "app.db") } }, /DATABASE_PATH .* is not under .*work\/t1 \(the task's working copy\)/);
		has("a data folder that is the whole replica folder refuses", { env: { ...h.env, LOGISX_REPLICA_DATA_DIR: h.root } }, /LOGISX_REPLICA_DATA_DIR .* is not under .*work\/t1/);
		has("another task's working copy refuses", { env: { ...h.env, DATABASE_PATH: path.join(h.root, "work", "other", "app.db") } }, /DATABASE_PATH .* is not under .*work\/t1/);
		eq("SESSION_SECRET alone is accepted (it reaches nothing)", replica.refusals({ ...base, env: { ...h.env, SESSION_SECRET: "x" } }), []);
		eq("BIND_HOST=127.0.0.1 is accepted", replica.refusals({ ...base, env: { ...h.env, BIND_HOST: "127.0.0.1" } }), []);
	}

	// ---- §3 server.js, read ------------------------------------------------------------
	console.log("§3 server.js");
	{
		const at = (s) => SRC.indexOf(s);
		const bootAt = at('const REPLICA = require("./lib/replica-mode").boot({ appDir: __dirname });');
		ok("replica mode boots after the umask and before dotenv", bootAt > at("process.umask(BOOT_UMASK)") && bootAt < at('require("dotenv").config();'));
		ok("a LOCAL_REPLICA that only a .env file set is checked right after dotenv", SRC.includes('require("dotenv").config();\n// A LOCAL_REPLICA that only a .env file set is refused here: replica mode was\n// decided above, before dotenv (lib/replica-mode.js checkDotenvFlag()).\nrequire("./lib/replica-mode").checkDotenvFlag(process.env);\n'));
		ok("...and before every other module", bootAt < SRC.search(/^const express = require\("express"\);/m));
		ok("server.js's fetch is the replica's in replica mode", /^const fetch = REPLICA \? REPLICA\.fetch : globalThis\.fetch;$/m.test(SRC));
		ok("startsJob() always says yes outside replica mode", /function startsJob\(name\) \{\n\treturn REPLICA \? REPLICA\.jobNotStarted\(name\) : true;\n\}/.test(SRC));
		ok("DATA_DIR is the app directory outside replica mode", /^const DATA_DIR = REPLICA \? REPLICA\.dataDir : __dirname;$/m.test(SRC));
		const dirnameJoins = [...SRC.matchAll(/path\.join\(__dirname, ([^)]{0,40})/g)].map((m) => m[1]).filter((a) => !/^"(client|public|lib|onboarding-templates|\.cache|app\.db)"/.test(a));
		eq("every runtime data path (uploads/, storage/, evidence-archive/, stored /uploads paths) goes through DATA_DIR", dirnameJoins, []);
		ok("...the /uploads static mount included", /express\.static\(path\.join\(DATA_DIR, "uploads"\)/.test(SRC));

		// Every timer started at boot asks startsJob(); the socket-session sweep
		// (it ends the replica's own expired sessions' sockets) is the one kept.
		// A timer's context: the line itself and each enclosing line (less indented)
		// up to column 0. A boot-time timer is one whose column-0 line is not a
		// function or a route; it must have startsJob() somewhere in its context.
		// An interval is a scheduled job wherever it is.
		const lines = SRC.split("\n");
		const indent = (l) => l.match(/^\t*/)[0].length;
		const contextOf = (i) => {
			const ctx = [lines[i]];
			let cur = indent(lines[i]);
			for (let j = i - 1; j >= 0 && cur > 0; j--) {
				const l = lines[j];
				if (!l.trim() || /^\s*(\/\/|\*|\/\*)/.test(l)) continue;
				if (indent(l) < cur) { ctx.push(l); cur = indent(l); }
			}
			return ctx;
		};
		const inFunction = (h) => /^(async function|function|app\.|io\.|const \w+ = (async )?(\(|function)|publicTrack\.|class )/.test(h);
		const ungated = [];
		lines.forEach((l, i) => {
			if (/^\s*(\/\/|\*)/.test(l) || !/\bset(Interval|Timeout|Immediate)\(/.test(l)) return;
			if (/^const socketSessionSweepTimer = setInterval\(sweepSessionlessSockets, SOCKET_SESSION_SWEEP_MS\);$/.test(l)) return;
			const ctx = contextOf(i);
			const gated = ctx.some((c) => /startsJob\(/.test(c));
			const header = ctx[ctx.length - 1];
			if (/\bsetInterval\(/.test(l) ? !gated : (!inFunction(header) && !gated)) ungated.push(`${i + 1}: ${l.trim().slice(0, 80)}`);
		});
		eq("every interval and boot-time timer asks startsJob()", ungated, []);
		ok("the session store sweeps no expired sessions in a replica", /expired: \{ clear: !REPLICA, intervalMs: 3600000 \}/.test(SRC));
		ok("the boot's address geocode asks startsJob()", /if \(startsJob\("address geocode and load-coordinate backfill \(at boot\)"\)\) \(async \(\) => \{/.test(SRC));
		const jobs = [...SRC.matchAll(/startsJob\("([^"]+)"\)/g)].map((m) => m[1]);
		for (const j of ["month-end close", "weekly invoice batch", "rate-con email reconcile", "Routemate live telemetry poll", "ELD telemetry trim (at boot, then weekly)", "fuel-event sweep", "duplicate-receipt alert sweep", "ELD feed-silence sweep"]) {
			ok(`the job "${j}" is gated`, jobs.includes(j));
		}

		// Outbound paths, one by one.
		ok("Google Sheets: getSheets() answers from the local copy first", /async function getSheets\(\) \{\n\t\/\/[^\n]*\n\tif \(REPLICA\) return REPLICA\.sheets\(\);/.test(SRC));
		ok("Google auth: no GoogleAuth (no key read) in a replica", /^const auth = REPLICA \? null : new google\.auth\.GoogleAuth\(\{$/m.test(SRC));
		const clients = [...SRC.matchAll(/google\.(sheets|drive)\(\{/g)].length;
		eq("the only Google clients are the two lazily built in getSheets()/getDrive()", clients, 2);
		ok("Google Drive: getDrive() refuses in a replica", /async function getDrive\(\) \{[\s\S]{0,300}if \(REPLICA\) \{\n\t\tREPLICA\.off\("Google Drive"\);\n\t\tthrow/.test(SRC));
		ok("email (SMTP): sendEmail() sends nothing in a replica", /async function sendEmail\([^)]*\) \{\n\t\/\/[^\n]*\n\tif \(REPLICA\) \{ REPLICA\.off\("email \(SMTP\)"\); return false; \}/.test(SRC));
		const passReads = [...SRC.matchAll(/^.*process\.env\.GMAIL_APP_PASSWORD.*$/gm)].map((m) => m[0].trim());
		ok("Gmail (outreach mail, IMAP drafts, the IMAP reconcile): no mailbox password in a replica", passReads.every((l) => /REPLICA \? "" : process\.env\.GMAIL_APP_PASSWORD/.test(l) || /^if \(REPLICA \|\| /.test(l) || l === "const gmailPass = process.env.GMAIL_APP_PASSWORD;"), passReads);
		const sendEmailBody = SRC.slice(at("async function sendEmail("), at("async function sendEmail(") + 400);
		ok("...the one plain read is sendEmail's, after its replica gate", sendEmailBody.indexOf("if (REPLICA)") < sendEmailBody.indexOf("process.env.GMAIL_APP_PASSWORD"));
		ok("n8n invoice webhook: no URL in a replica", /const webhookUrl = REPLICA \? "" : process\.env\.N8N_INVOICE_WEBHOOK_URL;/.test(SRC));
		for (const f of ["ROUTEMATE_ENABLED", "SCANKIT_ENABLED", "LINXUP_ENABLED"]) {
			ok(`${f} is off in a replica`, new RegExp(`^const ${f} = !REPLICA && `, "m").test(SRC));
		}
		// Every outbound HTTP call in server.js is turned away before its fetch in a
		// replica: by a REPLICA gate in its function, or by a credential the boot
		// refuses (the Distance Matrix needs GOOGLE_MAPS_API_KEY, the n8n webhook
		// its URL and secret, the Gemini extraction GEMINI_API_KEY at every caller).
		const fetchSites = [];
		lines.forEach((l, i) => {
			if (!/\bawait fetch\(/.test(l) || /^\s*\/\//.test(l)) return;
			let h = i;
			while (h > 0 && !/^(async function|function|app\.(get|post|put|delete|patch)\()/.test(lines[h])) h--;
			const body = lines.slice(h, i + 1).join("\n");
			const gate = /if \(REPLICA\)/.test(body) ? "REPLICA"
				: /if \(GOOGLE_MAPS_API_KEY( |\))/.test(body) ? "GOOGLE_MAPS_API_KEY"
				: /if \(webhookUrl && webhookSecret\)/.test(body) ? "N8N webhook URL"
				: /^async function runRateConGemini\(/.test(lines[h]) ? "GEMINI_API_KEY (callers)"
				: "";
			fetchSites.push({ line: i + 1, fn: lines[h].slice(0, 60), gate });
		});
		ok("server.js makes outbound HTTP calls (the scan works)", fetchSites.length >= 8, fetchSites.length);
		eq("every one is turned away before its fetch in a replica", fetchSites.filter((s) => !s.gate), []);
		for (const g of ["Google Routes", "Google geocoding", "Google Places search", "Google weather"]) {
			ok(`${g} answers without Google in a replica`, SRC.includes(`REPLICA.off("${g}")`));
		}
		const geminiCallers = [...SRC.matchAll(/runRateConGemini\(/g)].length - 1;
		ok("every Gemini extraction caller checks GEMINI_API_KEY (refused at a replica's start)", geminiCallers >= 3 && (SRC.match(/if \(!GEMINI_API_KEY\) return res\.status\(503\)/g) || []).length >= 4 && /const geminiExtract = GEMINI_API_KEY\n/.test(SRC));
		ok("receipt OCR (a child process that downloads its model) is off in a replica", /function queueReceiptOcr\(documentId, imageBuffer\) \{\n(\t\/\/[^\n]*\n)*\tif \(REPLICA\) \{ REPLICA\.off\("receipt OCR"\); return false; \}/.test(SRC));
		const pdf = fs.readFileSync(path.join(ROOT, "lib", "pdf-browser.js"), "utf8");
		ok("Chromium (PDFs) starts unable to reach anything in a replica, as boot() decided (never the environment)", /require\("\.\/replica-mode"\)\.active\(\) \? require\("\.\/replica-rules"\)\.CHROMIUM_OFFLINE_ARGS : \[\]/.test(pdf));
		ok("...those arguments send every request to a closed loopback proxy and resolve no name", rules.CHROMIUM_OFFLINE_ARGS.includes("--proxy-server=http://127.0.0.1:9") && rules.CHROMIUM_OFFLINE_ARGS.some((a) => /^--host-resolver-rules=MAP \* ~NOTFOUND/.test(a)));
		ok("the banner is mounted ahead of the static files", at("if (REPLICA) app.use(REPLICA.bannerMiddleware(") > 0 && at("if (REPLICA) app.use(REPLICA.bannerMiddleware(") < at("app.use(express.static(clientDistPath));"));

		// Every secret-named variable the app reads is a credential the boot refuses.
		const appSrc = [SRC, ...fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8"))].join("\n");
		const read = [...new Set([...appSrc.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
		const unlisted = read.filter((n) => rules.isSecretName(n) && n !== rules.SESSION_SECRET_NAME && !rules.OUTBOUND_CREDENTIALS.includes(n));
		eq("every secret-named variable the app reads is in OUTBOUND_CREDENTIALS", unlisted, []);
	}

	// ---- §4 the network guard ---------------------------------------------------------------------
	console.log("§4 the network guard");
	{
		const dir = tmp("replica-guard-");
		const log = path.join(dir, "outbound.log");
		const child = `
			const replica = require(${JSON.stringify(MODE)});
			const net = require("net"), tls = require("tls"), http = require("http"), https = require("https"), dns = require("dns");
			replica.installNetworkGuard(replica.makeRecorder(${JSON.stringify(log)}));
			const results = {};
			const settle = (name, fn) => new Promise((resolve) => {
				const t = setTimeout(() => { results[name] = "TIMEOUT"; resolve(); }, 4000);
				const done = (v) => { clearTimeout(t); results[name] = v; resolve(); };
				try { fn(done); } catch (e) { done("THROW " + (e.code || e.message)); }
			});
			(async () => {
				const srv = http.createServer((q, r) => r.end("local")).listen(0, "127.0.0.1");
				await new Promise((r) => srv.once("listening", r));
				const port = srv.address().port;
				await settle("net.connect", (d) => net.connect(443, "192.0.2.1").on("connect", () => d("CONNECTED")).on("error", (e) => d(e.code)));
				await settle("tls.connect", (d) => tls.connect({ host: "192.0.2.1", port: 443 }).on("secureConnect", () => d("CONNECTED")).on("error", (e) => d(e.code)));
				await settle("http.get", (d) => http.get("http://192.0.2.1/x").on("response", () => d("RESPONSE")).on("error", (e) => d(e.code)));
				await settle("https.request", (d) => https.request({ host: "guard-test.invalid", path: "/" }).on("response", () => d("RESPONSE")).on("error", (e) => d(e.code)).end());
				await settle("fetch", (d) => fetch("https://guard-test.invalid/api?key=x").then(() => d("RESPONSE"), (e) => d(e.cause && e.cause.code)));
				await settle("dns.lookup", (d) => dns.lookup("guard-test.invalid", (e) => d(e ? e.code : "RESOLVED")));
				await settle("dns.promises.lookup", (d) => dns.promises.lookup("guard-test.invalid").then(() => d("RESOLVED"), (e) => d(e.code)));
				await settle("dns.resolve4", (d) => dns.resolve4("guard-test.invalid", (e) => d(e ? e.code : "RESOLVED")));
				await settle("Resolver.resolve4", (d) => new dns.Resolver().resolve4("guard-test.invalid", (e) => d(e ? e.code : "RESOLVED")));
				await settle("dns.promises.resolveTxt", (d) => dns.promises.resolveTxt("guard-test.invalid").then(() => d("RESOLVED"), (e) => d(e.code)));
				await settle("loopback http", (d) => http.get("http://127.0.0.1:" + port + "/", (r) => { r.resume(); d(r.statusCode); }).on("error", (e) => d(e.code)));
				await settle("loopback localhost", (d) => http.get("http://localhost:" + port + "/", (r) => { r.resume(); d(r.statusCode); }).on("error", (e) => d(e.code)));
				await settle("loopback fetch", (d) => fetch("http://127.0.0.1:" + port + "/").then((r) => d(r.status), (e) => d("ERR " + (e.cause && e.cause.code))));
				await settle("loopback net", (d) => { const s = net.connect(port, "127.0.0.1", () => { s.destroy(); d("CONNECTED"); }); s.on("error", (e) => d(e.code)); });
				await settle("dns.lookup name.localhost", (d) => dns.lookup("guard.localhost", (e) => d(e ? e.code : "RESOLVED")));
				await settle("dns.lookup localhost", (d) => dns.lookup("localhost", { all: true }, (e, a) => d(e ? e.code : (a.every((x) => /^127\.|^::1$/.test(x.address)) ? "LOOPBACK" : "OTHER"))));
				await settle("loopback via localhost", (d) => http.get("http://localhost:" + port + "/", (r) => { r.resume(); d(r.statusCode); }).on("error", (e) => d(e.code)));
				srv.close();
				process.stdout.write(JSON.stringify(results));
			})();`;
		const r = spawnSync(process.execPath, ["-e", child], { encoding: "utf8", timeout: 45000 });
		let res = {};
		try { res = JSON.parse(r.stdout); } catch { ok("the guard child ran", false, r.stderr.slice(0, 400)); }
		for (const k of ["net.connect", "tls.connect", "http.get", "https.request", "fetch", "dns.lookup", "dns.promises.lookup", "dns.resolve4", "Resolver.resolve4", "dns.promises.resolveTxt", "dns.lookup name.localhost"]) {
			eq(`${k} to the outside is refused before any packet`, res[k], "REPLICA_OUTBOUND_REFUSED");
		}
		for (const k of ["loopback http", "loopback localhost", "loopback fetch"]) eq(`${k} goes through`, res[k], 200);
		eq("loopback net.connect goes through", res["loopback net"], "CONNECTED");
		eq("localhost resolves, to loopback only", res["dns.lookup localhost"], "LOOPBACK");
		eq("a connection by the name localhost goes through", res["loopback via localhost"], 200);
		ok("a localhost answer that is not loopback is caught", !!replica.nonLoopbackAnswer([{ address: "127.0.0.1", family: 4 }, { address: "203.0.113.9", family: 4 }]) && !replica.nonLoopbackAnswer([{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]) && !!replica.nonLoopbackAnswer("10.0.0.1", 4));
		ok("only 127.0.0.0/8 and ::1 are loopback addresses", ["127.0.0.1", "127.9.8.7", "::1", "::ffff:127.0.0.1"].every(replica.isLoopbackAddress) && !["10.0.0.1", "0.0.0.0", "::", "localhost", "a.localhost"].some(replica.isLoopbackAddress));
		const entries = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
		ok("every refused attempt is in the guard log (and nothing else is)", entries.length >= 10 && entries.every((e) => /192\.0\.2\.1|guard-test\.invalid|guard\.localhost/.test(e.target)), entries.map((e) => e.target));
		ok("...with what asked: the via and the caller", entries.every((e) => e.via && e.caller));
		ok("...never a URL's path or query", !fs.readFileSync(log, "utf8").includes("key=x"));
		eq("the guard log is private (0600)", (fs.statSync(log).mode & 0o777).toString(8), "600");
	}

	// ---- §5 the file guard -----------------------------------------------------------------------------
	console.log("§5 the file guard");
	{
		const dir = tmp("replica-files-");
		for (const f of ["service-account-key.json", ".env", ".env.local", ".env.example", "settings.env", "creds.json"]) fs.writeFileSync(path.join(dir, f), "x");
		const log = path.join(dir, "files.log");
		const child = `
			const fs = require("fs"), path = require("path");
			const replica = require(${JSON.stringify(MODE)});
			const env = { GOOGLE_APPLICATION_CREDENTIALS: path.join(${JSON.stringify(dir)}, "creds.json") };
			replica.installFileGuard(replica.makeRecorder(${JSON.stringify(log)}), env);
			const d = ${JSON.stringify(dir)};
			const out = {};
			const sync = (k, fn) => { try { fn(); out[k] = "READ"; } catch (e) { out[k] = e.code; } };
			sync("key readFileSync", () => fs.readFileSync(path.join(d, "service-account-key.json")));
			sync(".env readFileSync", () => fs.readFileSync(path.join(d, ".env")));
			sync(".env.local openSync", () => fs.openSync(path.join(d, ".env.local"), "r"));
			sync("credentials file readFileSync", () => fs.readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS));
			sync("key createReadStream", () => fs.createReadStream(path.join(d, "service-account-key.json")));
			sync(".env.example readFileSync", () => fs.readFileSync(path.join(d, ".env.example")));
			sync("settings.env readFileSync", () => fs.readFileSync(path.join(d, "settings.env")));
			fs.readFile(path.join(d, "service-account-key.json"), (e) => {
				out["key readFile"] = e ? e.code : "READ";
				fs.promises.readFile(path.join(d, ".env")).then(() => { out[".env promises.readFile"] = "READ"; }, (e) => { out[".env promises.readFile"] = e.code; })
					.then(() => process.stdout.write(JSON.stringify(out)));
			});`;
		const r = spawnSync(process.execPath, ["-e", child], { encoding: "utf8", timeout: 30000 });
		let res = {};
		try { res = JSON.parse(r.stdout); } catch { ok("the file-guard child ran", false, r.stderr.slice(0, 400)); }
		for (const k of ["key readFileSync", ".env readFileSync", ".env.local openSync", "credentials file readFileSync", "key createReadStream", "key readFile", ".env promises.readFile"]) eq(`${k} is refused`, res[k], "EACCES");
		for (const k of [".env.example readFileSync", "settings.env readFileSync"]) eq(`${k} is allowed`, res[k], "READ");
		eq("each refused read is in the log", fs.readFileSync(log, "utf8").trim().split("\n").length, 7);
	}

	// ---- §6 the banner --------------------------------------------------------------------------------------
	console.log("§6 the banner");
	{
		const once = replica.withBanner("<html><body class=\"x\"><div id=app></div></body></html>");
		ok("withBanner puts the banner first in <body>", /<body class="x"><div id="logisx-replica-banner"[^>]*>LOCAL COPY OF PRODUCTION/.test(once));
		eq("...once, however often it runs", replica.withBanner(once), once);
		const express = require(path.join(ROOT, "node_modules", "express"));
		const staticRoot = tmp("replica-static-");
		fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><html><head></head><body><div id=app></div></body></html>");
		fs.writeFileSync(path.join(staticRoot, "driver.html"), "<html><body>driver</body></html>");
		fs.mkdirSync(path.join(staticRoot, "assets"));
		fs.writeFileSync(path.join(staticRoot, "assets", "app.js"), "console.log(1)");
		const app = express();
		app.use(replica.bannerMiddleware(staticRoot));
		app.use(express.static(staticRoot));
		app.get("/api/thing", (req, res) => res.json({ ok: true }));
		app.get("*", (req, res) => res.sendFile(path.join(staticRoot, "index.html")));
		const srv = app.listen(0, "127.0.0.1");
		await new Promise((r) => srv.once("listening", r));
		const get = (p) => new Promise((resolve) => http.get({ host: "127.0.0.1", port: srv.address().port, path: p }, (res) => {
			let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
		}));
		for (const p of ["/", "/login", "/financials", "/track/123", "/driver.html", "/index.html"]) {
			const r = await get(p);
			ok(`${p} carries the banner`, r.status === 200 && (r.body.match(/logisx-replica-banner/g) || []).length === 1, r.status);
		}
		eq("an API answer is untouched", (await get("/api/thing")).body, JSON.stringify({ ok: true }));
		eq("a script is untouched", (await get("/assets/app.js")).body, "console.log(1)");
		ok("a path out of the static folder is not served as a page", !(await get("/..%2f..%2fetc%2fpasswd.html")).body.includes("root:"));
		srv.close();
	}

	// ---- §7 server.js in replica mode ------------------------------------------------------------------------
	console.log("§7 server.js booted in replica mode");
	const baseEnv = (h, cwd) => ({ PATH: process.env.PATH, HOME: h.home, TMPDIR: os.tmpdir(), PORT: "0", BIND_HOST: "127.0.0.1", SESSION_SECRET: crypto.randomBytes(16).toString("hex"), ...h.env });
	// A folder that holds a .env with a credential and a service-account key, as
	// a worktree does: the replica must read neither.
	const decoy = () => {
		const d = tmp("replica-cwd-");
		fs.writeFileSync(path.join(d, ".env"), "GEMINI_API_KEY=from-the-repo-env\nSPREADSHEET_ID=from-the-repo-env\n");
		fs.writeFileSync(path.join(d, "service-account-key.json"), "{}");
		return d;
	};
	// A replica runs on macOS only. The test child (never production code) is
	// preloaded with a shim that reports the platform, so every case below runs
	// as it would on a Mac, CI's Linux included, and the macOS rule itself is
	// tested by reporting another platform.
	const platformShim = (platform) => {
		const file = path.join(tmp("replica-shim-"), `platform-${platform}.cjs`);
		fs.writeFileSync(file, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)}, configurable: true, enumerable: true });\n`);
		return file;
	};
	const asMac = platformShim("darwin");
	const refused = (name, mutate, re, shim = asMac) => {
		const h = replicaHome();
		const env = baseEnv(h);
		mutate(env, h);
		const r = spawnSync(process.execPath, ["--require", shim, SERVER], { cwd: decoy(), env, encoding: "utf8", timeout: 20000 });
		ok(name, r.status === 1 && re.test(r.stderr) && !/listening/.test(r.stdout), { status: r.status, err: r.stderr.slice(0, 300) });
	};
	refused("NODE_ENV=production: refused before listening", (e) => { e.NODE_ENV = "production"; }, /REFUSING TO START[\s\S]*NODE_ENV is production/);
	refused("an outbound credential: refused before listening", (e) => { e.GEMINI_API_KEY = "x"; }, /outbound credentials are set: GEMINI_API_KEY/);
	refused("a database outside ~/LogisX-replica: refused before listening", (e) => { e.DATABASE_PATH = path.join(tmp("elsewhere-"), "app.db"); }, /DATABASE_PATH .* is not under/);
	refused("pm2 in the environment: refused before listening", (e) => { e.pm_id = "7"; }, /running under pm2/);
	refused("a start without replica:start's marker: refused before listening", (e) => { delete e[rules.LAUNCHER_ENV]; }, /not started by replica:start/);
	refused("a proxy setting: refused before listening", (e) => { e.HTTPS_PROXY = "http://127.0.0.1:9"; }, /proxy settings are set: HTTPS_PROXY/);
	refused("a database in the clean snapshot: refused before listening", (e, h) => { e.DATABASE_PATH = path.join(h.root, "clean", "app.db"); }, /DATABASE_PATH .* is not under .*work\/t1/);
	// The settings file is judged after it is read, which on a machine that is not
	// a Mac never happens (the start is refused first). So boot() itself is run
	// here with the platform given as macOS: the rest of its checks are real.
	const refusedAfterSettings = (name, settings, re) => {
		const h = replicaHome({ settings });
		const code = `require(${JSON.stringify(MODE)}).boot({ appDir: ${JSON.stringify(ROOT)}, env: process.env, platform: "darwin" }); console.log("BOOTED");`;
		const r = spawnSync(process.execPath, ["-e", code], { cwd: decoy(), env: baseEnv(h), encoding: "utf8", timeout: 20000 });
		ok(name, r.status === 1 && re.test(r.stderr) && !/BOOTED/.test(r.stdout), { status: r.status, err: r.stderr.slice(0, 300) });
	};
	refusedAfterSettings("a credential in the settings file: refused once the file is read", "GMAIL_APP_PASSWORD='x'\n", /outbound credentials are set: GMAIL_APP_PASSWORD/);
	refusedAfterSettings("a settings value that looks like a key: refused once the file is read", "SOME_SETTING='AIzaSyD3x9EXAMPLEEXAMPLE12345'\n", /settings file holds SOME_SETTING, which a replica does not take \(secret: value looks like a key\)/);
	refusedAfterSettings("a runtime setting in the settings file (NODE_OPTIONS): refused once the file is read", "NODE_OPTIONS='--max-old-space-size=64'\n", /settings file holds NODE_OPTIONS, which a replica does not take \(runtime: set by replica:start\)/);
	refused("off macOS: refused before listening", () => {}, /this is linux: a replica runs on a developer Mac \(macOS\) only/, platformShim("linux"));
	{
		// Replica mode is decided before dotenv: a LOCAL_REPLICA that only a .env
		// file sets must stop a normal run, which would otherwise hold that file's
		// credentials while someone believes it is a replica.
		const d = tmp("replica-dotenv-");
		fs.writeFileSync(path.join(d, ".env"), "LOCAL_REPLICA=1\nGEMINI_API_KEY=from-the-repo-env\n");
		const r = spawnSync(process.execPath, [SERVER], { cwd: d, env: { PATH: process.env.PATH, HOME: tmp("replica-home-"), PORT: "0" }, encoding: "utf8", timeout: 20000 });
		ok("a LOCAL_REPLICA set only by a .env file stops a normal run before it listens", r.status === 1 && /LOCAL_REPLICA=1 was set by a \.env file/.test(r.stderr) && !/Server running/.test(r.stdout), { status: r.status, err: r.stderr.slice(0, 300) });
	}

	{
		// The live boot, on every platform: the child reports macOS (the shim above).
		const settings = [
			"SPREADSHEET_ID='replica-test-main'",
			"ARCHIVE_SPREADSHEET_ID='replica-test-archive'",
			"PERIOD_FINALIZE_ENABLED='true'", "INVOICE_AUTOGEN_ENABLED='true'", "RATECON_RECONCILE_ENABLED='true'",
			"FUEL_EVENTS_ENABLED='true'", "ROUTEMATE_ENABLED='true'", "LINXUP_ENABLED='true'", "SCANKIT_ENABLED='true'",
			"GMAIL_USER='dispatch@example.test'",
		].join("\n") + "\n";
		const h = replicaHome({ settings });
		const cwd = decoy();
		const child = spawn(process.execPath, ["--require", asMac, SERVER], { cwd, env: baseEnv(h, cwd), stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		const port = await new Promise((resolve) => {
			const t = setTimeout(() => resolve(null), 45000);
			const check = () => { const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(t); resolve(Number(m[1])); } };
			child.stdout.on("data", check);
			child.once("exit", () => { clearTimeout(t); resolve(null); });
		});
		ok("a well-formed replica boots and listens on loopback", !!port, (err || out).slice(-600));
		if (port) {
			const get = (p) => new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: p }, (res) => {
				let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b, type: res.headers["content-type"] || "" }));
			}).on("error", (e) => resolve({ status: 0, body: e.message })));
			for (const p of ["/", "/login", "/dashboard"]) {
				const r = await get(p);
				ok(`GET ${p}: the page carries the LOCAL COPY OF PRODUCTION banner`, r.status === 200 && /id="logisx-replica-banner"[^>]*>LOCAL COPY OF PRODUCTION/.test(r.body), r.status);
			}
			const s = await get("/api/auth/session");
			ok("the API answers as usual (JSON, no banner)", s.status === 200 && /json/.test(s.type) && !s.body.includes("logisx-replica-banner"), s);
			await new Promise((r) => setTimeout(r, 1500));
		}
		child.kill("SIGTERM");
		await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
		const notStarted = [...out.matchAll(/\[replica\] scheduled job not started: (.+)/g)].map((m) => m[1]);
		ok("no scheduled job starts (each is named in the log)", notStarted.length >= 20, notStarted.length);
		for (const j of ["month-end close", "weekly invoice batch", "rate-con email reconcile", "fuel-event sweep", "Routemate live telemetry poll", "Routemate vehicle sync (at boot)", "ELD telemetry trim (at boot, then weekly)", "address geocode and load-coordinate backfill (at boot)"]) {
			ok(`...including "${j}", its flag on in the settings`, notStarted.includes(j));
		}
		ok("Google Sheets answer from the local copy", /Google Sheets connected — 1 tabs cached/.test(out), out.slice(-300));
		ok("the repo's .env is not loaded (the settings file is)", /\[replica\] settings: 10 from .*; the repo \.env is not loaded/.test(out) && !/injecting env/.test(out + err));
		const guard = fs.readFileSync(h.env.LOGISX_REPLICA_GUARD_LOG, "utf8");
		eq("the outbound guard log is empty: no connection, DNS query, .env or key read was attempted", guard, "");
		ok("nothing was refused on stderr either", !/\[replica-guard\] REFUSED/.test(err), err.slice(-300));
	}

	// ---- §8 outside replica mode ---------------------------------------------------------------------------------
	console.log("§8 outside replica mode nothing changes");
	{
		const child = `
			const net = require("net"), dns = require("dns"), fs = require("fs");
			const before = [net.Socket.prototype.connect, dns.lookup, dns.resolve4, globalThis.fetch, fs.readFileSync, fs.promises.readFile];
			const dotenv = require(${JSON.stringify(path.join(ROOT, "node_modules", "dotenv"))});
			const config = dotenv.config;
			const replica = require(${JSON.stringify(MODE)});
			const r = ["", "0", undefined, "false", "No", "OFF", " off ", "true", "yes"].map((v) => replica.boot({ appDir: ${JSON.stringify(ROOT)}, env: v === undefined ? {} : { LOCAL_REPLICA: v } }));
			const after = [net.Socket.prototype.connect, dns.lookup, dns.resolve4, globalThis.fetch, fs.readFileSync, fs.promises.readFile];
			replica.checkDotenvFlag({ LOCAL_REPLICA: "0" });
			process.stdout.write(JSON.stringify({ nulls: r.every((x) => x === null), same: before.every((f, i) => f === after[i]), dotenv: dotenv.config === config, active: replica.active() }));`;
		const r = spawnSync(process.execPath, ["-e", child], { encoding: "utf8", timeout: 20000 });
		let res = {};
		try { res = JSON.parse(r.stdout); } catch { ok("the child ran", false, r.stderr.slice(0, 300)); }
		eq("boot() is null when LOCAL_REPLICA is unset, empty, 0, false, no, off (any case), or any value but 1", res.nulls, true);
		ok("...the off values pass silently; a stray value is reported, never a reason to stop the process",
			(r.stderr.match(/replica mode is OFF/g) || []).length === 2 && /LOCAL_REPLICA is "true"/.test(r.stderr) && /LOCAL_REPLICA is "yes"/.test(r.stderr) && r.status === 0, r.stderr.slice(0, 300));
		eq("...and patches no socket, DNS, fetch or file function", res.same, true);
		eq("...and leaves dotenv alone", res.dotenv, true);
		eq("...and the PDF browser is told replica mode is off", res.active, false);
		const dataDirLine = SRC.match(/^const DATA_DIR = (.*);$/m)[1];
		eq("DATA_DIR evaluates to the app directory when REPLICA is null", new Function("REPLICA", "__dirname", `return ${dataDirLine};`)(null, "/app"), "/app");
		// The same sequence server.js runs (boot, dotenv, checkDotenvFlag), in an
		// environment like production's under pm2, with each LOCAL_REPLICA a .env
		// file could hold. Only LOCAL_REPLICA=1 from the .env stops the run.
		const dotenvRun = (dotenvValue, preEnv = {}) => {
			const d = tmp("replica-flag-");
			if (dotenvValue !== undefined) fs.writeFileSync(path.join(d, ".env"), `LOCAL_REPLICA=${dotenvValue}\n`);
			const code = `const r = require(${JSON.stringify(MODE)}); r.boot({ appDir: ${JSON.stringify(ROOT)} }); require(${JSON.stringify(path.join(ROOT, "node_modules", "dotenv"))}).config({ quiet: true }); r.checkDotenvFlag(process.env); console.log("CONTINUED");`;
			return spawnSync(process.execPath, ["-e", code], { cwd: d, env: { PATH: process.env.PATH, HOME: d, NODE_ENV: "production", pm_id: "3", PM2_HOME: "/root/.pm2", ...preEnv }, encoding: "utf8", timeout: 20000 });
		};
		for (const v of [undefined, "", "0", "false", "FALSE", "no", "Off"]) {
			const r = dotenvRun(v);
			ok(`a server-like run with ${v === undefined ? "no LOCAL_REPLICA" : `LOCAL_REPLICA=${JSON.stringify(v)} in its .env`} carries on, silently`, r.status === 0 && /CONTINUED/.test(r.stdout) && !/LOCAL_REPLICA/.test(r.stderr), { status: r.status, err: r.stderr.slice(0, 200) });
		}
		for (const v of ["true", "yes", "2"]) {
			const r = dotenvRun(v);
			ok(`a server-like run with LOCAL_REPLICA=${v} in its .env carries on, with a warning`, r.status === 0 && /CONTINUED/.test(r.stdout) && /LOCAL_REPLICA is ".*" \(from a \.env file\), not 1: replica mode is OFF/.test(r.stderr), { status: r.status, err: r.stderr.slice(0, 200) });
		}
		{
			const r = dotenvRun("1");
			ok("LOCAL_REPLICA=1 from a .env file is the one value that stops the run", r.status === 1 && !/CONTINUED/.test(r.stdout) && /LOCAL_REPLICA=1 was set by a \.env file/.test(r.stderr), { status: r.status, err: r.stderr.slice(0, 200) });
			const pre = dotenvRun("1", { LOCAL_REPLICA: "false" });
			ok("...and only when the environment did not already set the flag (dotenv does not override it)", pre.status === 0 && /CONTINUED/.test(pre.stdout), { status: pre.status, err: pre.stderr.slice(0, 200) });
		}
		eq("startsJob() evaluates to true when REPLICA is null", new Function("REPLICA", `${SRC.match(/function startsJob\(name\) \{[\s\S]*?\n\}/)[0]}\nreturn startsJob("x");`)(null), true);
	}

	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
