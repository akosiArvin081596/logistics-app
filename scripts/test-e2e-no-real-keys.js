#!/usr/bin/env node
// The browser harness (scripts/e2e/) runs on made-up settings and a Google stand-in,
// never on a real settings file or a Google key:
//   1. prep-worktree.sh links only the two node_modules folders, and no script in
//      scripts/e2e links, copies or loads the main checkout's settings file or key
//      (read from the scripts' text: prep-worktree.sh itself is never run here).
//   2. boot-server.sh refuses a worktree holding either file (an empty dummy, or a
//      dangling link, in a temporary directory), before it starts anything.
//   3. boot-server.sh's settings (on the server's command line; there is no settings
//      file, and scripts/e2e holds none) and the Sheets fixture hold made-up values
//      only: no secret-shaped value (this runner's own patterns, each shown to catch a
//      planted sample, plus gitleaks --redact where it is installed).
//   4. fake-google.cjs: googleapis answers the stand-in, Sheets read and write the
//      work copy of the fixture (never the fixture itself), Drive refuses, the key
//      file is never read, dotenv loads nothing, and a read of a settings file or a
//      key is refused before the disk is touched.
//   5. boot-server.sh boots a stub server.js (a temporary worktree, a made-up
//      database file) that reads the fixture through the stand-in and answers on
//      127.0.0.1; it is stopped by its recorded PID.
// Nothing here reads a real settings file or key, and no value is printed.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const E2E = path.join(REPO, "scripts", "e2e");
const BOOT = path.join(E2E, "boot-server.sh");
const PREP = path.join(E2E, "prep-worktree.sh");
const FAKE = path.join(E2E, "fake-google.cjs");
const FIXTURE = path.join(E2E, "fixtures", "e2e-sheets.json");
const KEY_NAME = "service-account-key.json";
const SETTINGS_NAME = ".env";
const PRODUCTION_SHEET = require(path.join(REPO, "lib", "sheet-id.js")).PRODUCTION_SPREADSHEET_ID;

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

const tempDirs = [];
function tempDir(tag) {
	const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `e2e-no-keys-${tag}-`));
	fs.chmodSync(d, 0o700);
	tempDirs.push(d);
	return d;
}

// A script's code lines: comment lines dropped (# for shell, // and * for JS).
function codeLines(text, kind) {
	return String(text || "").split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => {
		const t = line.trim();
		if (!t) return false;
		if (kind === "sh") return !t.startsWith("#");
		return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
	});
}
const namesSettings = (s) => /(^|[^\w.])\.env(?![\w-])/.test(s);
const namesKey = (s) => s.includes(KEY_NAME);

// ---------------------------------------------------------------- 1. the scripts' text
function scriptsText() {
	console.log("scripts/e2e: what is linked, copied or loaded");
	const prep = read(PREP);
	ok("prep-worktree.sh exists", prep !== null);
	const prepCode = codeLines(prep, "sh");
	const named = prepCode.filter(({ line }) => namesSettings(line) || namesKey(line)).map(({ n }) => n);
	eq("prep-worktree.sh: no code line names the settings file or the key", named, []);
	const linked = prepCode.map(({ line }) => line.trim().match(/^link\s+(\S+)\s*$/)).filter(Boolean).map((m) => m[1]);
	eq("prep-worktree.sh links exactly node_modules and client/node_modules", linked, ["node_modules", "client/node_modules"]);

	const boot = read(BOOT);
	ok("boot-server.sh exists", boot !== null);
	const bootCode = codeLines(boot, "sh");
	const refusalLine = "for f in .env service-account-key.json; do";
	const bootNamed = bootCode.filter(({ line }) => (namesSettings(line) || namesKey(line)) && line.trim() !== refusalLine).map(({ n }) => n);
	eq("boot-server.sh: the settings file and the key are named only in its refusal", bootNamed, []);
	ok("boot-server.sh refuses a worktree holding either file", bootCode.some(({ line }) => line.trim() === refusalLine));
	eq("boot-server.sh never loads dotenv", bootCode.filter(({ line }) => /dotenv/.test(line)).map(({ n }) => n), []);
	ok("boot-server.sh preloads fake-google.cjs into the server", /FAKE_GOOGLE="\$HERE\/fake-google\.cjs"/.test(boot || "") && /PRELOAD="--require \\"\$FAKE_GOOGLE\\""/.test(boot || ""));
	const envFiles = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.name === "node_modules") continue;
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/^\.env(\.(?!example$).+)?$|.\.env$/i.test(e.name)) envFiles.push(path.relative(E2E, p));
		}
	};
	walk(E2E);
	eq("scripts/e2e holds no settings (.env-named) file", envFiles, []);

	// Every other harness script: no code line names the key, joins a path to the
	// settings file, or parses one with dotenv.
	const offenders = [];
	for (const f of fs.readdirSync(E2E)) {
		const p = path.join(E2E, f);
		if (!fs.statSync(p).isFile() || f === "boot-server.sh" || f === "prep-worktree.sh") continue;
		const kind = f.endsWith(".sh") ? "sh" : /\.(c|m)?js$/.test(f) ? "js" : null;
		if (!kind) continue;
		for (const { line, n } of codeLines(read(p), kind)) {
			if (namesKey(line) || /['"]\.env['"]/.test(line) || /appRequire\(\s*['"]dotenv['"]\s*\)|dotenv['"]\s*\)\s*\.(parse|config)\b/.test(line)) offenders.push(`${f}:${n}`);
		}
	}
	eq("no other scripts/e2e script names the key or reads a settings file", offenders, []);
	const parity = read(path.join(E2E, "payout-parity.mjs")) || "";
	ok("payout-parity.mjs links only the two node_modules folders", /const LINKS = \['node_modules', 'client\/node_modules'\]/.test(parity));
	const setup = read(path.join(E2E, "setup-db.cjs")) || "";
	ok("setup-db.cjs removes the run's Sheets copy with the database", /\["", "-wal", "-shm", "\.sheets\.json"\]/.test(setup));
}

// ---------------------------------------------------------------- 2. boot-server.sh refuses
function fakeWorktree(root) {
	const wt = path.join(root, "wt");
	fs.mkdirSync(path.join(wt, "node_modules"), { recursive: true });
	fs.mkdirSync(path.join(wt, "client", "dist"), { recursive: true });
	fs.writeFileSync(path.join(wt, "server.js"), "process.exit(3)\n");
	return wt;
}
function bootEnv(work) {
	return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || os.tmpdir(), NODE_BIN: process.execPath, E2E_WORK_DIR: work };
}
function runBoot(wt, port, db, work) {
	return spawnSync("bash", [BOOT, wt, String(port), db], { env: bootEnv(work), encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
}
function refusals() {
	console.log("boot-server.sh: a worktree holding the settings file or the key");
	const cases = [
		[`an empty ${SETTINGS_NAME}`, (wt) => fs.writeFileSync(path.join(wt, SETTINGS_NAME), ""), SETTINGS_NAME],
		[`an empty ${KEY_NAME}`, (wt) => fs.writeFileSync(path.join(wt, KEY_NAME), ""), KEY_NAME],
		[`a dangling link named ${SETTINGS_NAME}`, (wt) => fs.symlinkSync(path.join(wt, "no-such-target"), path.join(wt, SETTINGS_NAME)), SETTINGS_NAME],
	];
	for (const [label, plant, name] of cases) {
		const root = tempDir("refuse");
		const work = path.join(root, "work");
		fs.mkdirSync(work, { mode: 0o700 });
		const db = path.join(work, "e2e.db");
		fs.writeFileSync(db, "");
		const wt = fakeWorktree(root);
		plant(wt);
		const r = runBoot(wt, 39871, db, work);
		const out = `${r.stdout}${r.stderr}`;
		eq(`${label}: refused with exit 2`, r.status, 2);
		ok(`${label}: the refusal names the file`, out.includes(`refusing: ${wt} holds ${name}`), out.split("\n").filter((l) => /refusing/.test(l)).slice(0, 2).join(" | "));
		ok(`${label}: nothing was started (no pid file, no Sheets copy)`, !fs.existsSync(path.join(work, "server-39871.pid")) && !fs.existsSync(`${db}.sheets.json`));
	}
}

// ---------------------------------------------------------------- 3. made-up values only
const SECRET_SHAPES = [
	["a Google API key", /AIza[0-9A-Za-z_-]{35}/],
	["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["a service-account field", /"(private_key|private_key_id|client_email|client_x509_cert_url)"\s*:/],
	["an OAuth access token", /ya29\.[0-9A-Za-z_-]{20,}/],
	["an AWS access key id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
	["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
	["a Slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}/],
	["a JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
	["a long opaque token (32+ characters, a Google sheet id's shape)", /[A-Za-z0-9_-]{32,}/],
	["a long run of digits", /\d{12,}/],
	["a phone number", /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/],
	["a mail address outside example.test and .invalid", /[\w.+-]+@(?![\w-]+\.example\.test\b|example\.test\b|[\w.-]+\.invalid\b)[\w-]+(\.[\w-]+)+/],
];
function secretShapes(text) {
	const found = SECRET_SHAPES.filter(([, re]) => re.test(text)).map(([what]) => what);
	if (text.includes(PRODUCTION_SHEET)) found.push("the production sheet id");
	return found;
}
function fixtureBooks() {
	try { return Object.keys(JSON.parse(fs.readFileSync(FIXTURE, "utf8")).spreadsheets || {}); } catch { return []; }
}
function gitleaks(file) {
	const bin = ["/opt/homebrew/bin/gitleaks", "/usr/local/bin/gitleaks", "/usr/bin/gitleaks"].find((b) => fs.existsSync(b));
	if (!bin) return null;
	const r = spawnSync(bin, ["dir", "--redact", "--no-banner", "--no-color", "--exit-code", "1", file], { encoding: "utf8", timeout: 60_000 });
	return r.status;
}
function madeUpValues() {
	console.log("boot-server.sh's settings and the Sheets fixture: made-up values only");
	// The checks themselves: each pattern catches a planted, invented sample.
	const rand = (n) => crypto.randomBytes(n).toString("base64url").replace(/[^A-Za-z0-9]/g, "x").slice(0, n);
	const samples = {
		"a Google API key": `AIza${rand(35)}`,
		"a service-account field": "\"client_email\": \"x\"",
		"a long opaque token (32+ characters, a Google sheet id's shape)": rand(44),
		"a phone number": "(555) 010-0199",
		"a mail address outside example.test and .invalid": "person@mail.test-domain.com",
	};
	for (const [what, sample] of Object.entries(samples)) ok(`the check catches ${what}`, secretShapes(sample).includes(what));
	ok("the check passes example.test and .invalid addresses", secretShapes("admin@example.test e2e-fake@logisx.invalid").length === 0);

	// boot-server.sh's settings: every NAME=value assignment in its code lines (shell
	// variables and the server's command line), and the server's command line itself.
	const boot = read(BOOT) || "";
	const code = codeLines(boot, "sh").map(({ line }) => line).join("\n");
	const assigned = new Map(); // name -> raw values (quotes kept)
	for (const m of code.matchAll(/(?<![\w$.-])([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s;"'`)]*)/g)) {
		if (!assigned.has(m[1])) assigned.set(m[1], []);
		assigned.get(m[1]).push(m[2]);
	}
	const unquote = (v) => v.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
	const literal = (name) => { const v = assigned.get(name) || []; return v.length === 1 && !v[0].includes("$") ? unquote(v[0]) : null; };
	const literals = [...assigned.entries()].flatMap(([, vs]) => vs).filter((v) => !v.includes("$")).map(unquote);
	eq("boot-server.sh: no secret-shaped literal value", [...new Set(literals.flatMap(secretShapes))], []);
	const sheet = literal("SHEET");
	ok("boot-server.sh: the sheet is the fixture's made-up book", /^e2e-[a-z0-9-]+$/.test(sheet || "") && fixtureBooks().includes(sheet));
	ok("boot-server.sh: the archive book is made up", /^e2e-[a-z0-9-]+$/.test(literal("ARCHIVE_SHEET") || ""));
	eq("boot-server.sh: no Drive folder", literal("DRIVE_FOLDER"), "");
	ok("boot-server.sh: the session value is made up", /^e2e-made-up-[a-z0-9-]+$/.test(literal("SESSION_VALUE") || ""));

	const block = (code.match(/\nenv PORT=[\s\S]*?nohup /) || [""])[0];
	ok("boot-server.sh: the server's command line found", block.length > 0);
	const passed = new Map([...block.matchAll(/(?<![\w$.-])([A-Z][A-Z0-9_]*)=("[^"]*"|[^\s"\\]*)/g)].map((m) => [m[1], m[2]]));
	const wants = { SPREADSHEET_ID: "\"$SHEET\"", ARCHIVE_SPREADSHEET_ID: "\"$ARCHIVE_SHEET\"", GOOGLE_DRIVE_FOLDER_ID: "\"$DRIVE_FOLDER\"", SESSION_SECRET: "\"$SESSION_VALUE\"", GOOGLE_APPLICATION_CREDENTIALS: "" };
	eq("boot-server.sh passes the made-up settings to the server (and no Google credentials path)",
		Object.fromEntries(Object.keys(wants).map((k) => [k, passed.get(k)])), wants);
	// Every key, secret, token, password or credential the server gets is blank, a
	// made-up e2e- value, or the caller's own invented E2E_ value.
	const madeUp = (raw) => raw === "" || raw === "\"\"" || /^"?e2e-[\w.@-]*"?$/.test(raw) || /^"\$\{E2E_[A-Z0-9_]+:-\}"$/.test(raw);
	const resolves = (raw) => {
		const ref = raw.match(/^"\$([A-Z][A-Z0-9_]*)"$/);
		if (!ref) return madeUp(raw);
		const vs = assigned.get(ref[1]) || [];
		return vs.length > 0 && vs.every(madeUp);
	};
	const secretSettings = [...passed.entries()].filter(([k]) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/.test(k));
	ok("boot-server.sh passes some key, secret or password settings (the check has something to check)", secretSettings.length >= 5);
	eq("boot-server.sh: every key, secret, token or password setting is blank or made up", secretSettings.filter(([, v]) => !resolves(v)).map(([k]) => k), []);

	const fixtureText = read(FIXTURE);
	ok("the Sheets fixture exists", fixtureText !== null);
	if (fixtureText !== null) {
		eq("the fixture: no secret-shaped value", secretShapes(fixtureText), []);
		const doc = JSON.parse(fixtureText);
		eq("the fixture: one made-up book", Object.keys(doc.spreadsheets || {}), ["e2e-made-up-sheet"]);
		const jt = doc.spreadsheets["e2e-made-up-sheet"].sheets.find((s) => s.properties.title === "Job Tracking");
		const idCol = jt.values[0].indexOf("Load ID");
		ok("the fixture: every Job Tracking load id is a QA- id", jt.values.slice(1).every((r) => /^QA-/.test(r[idCol])));
	}
	for (const [label, file] of [["boot-server.sh", BOOT], ["the Sheets fixture", FIXTURE], ["fake-google.cjs", FAKE]]) {
		if (!fs.existsSync(file)) continue;
		const status = gitleaks(file);
		if (status === null) { console.log(`  note gitleaks is not installed here; ${label} was checked by the patterns above`); continue; }
		eq(`gitleaks --redact finds nothing in ${label}`, status, 0);
	}
}

// ---------------------------------------------------------------- 4. the stand-in
async function standIn() {
	console.log("fake-google.cjs: the stand-in");
	ok("fake-google.cjs exists", fs.existsSync(FAKE));
	if (!fs.existsSync(FAKE)) return;
	const root = tempDir("fake");
	const copy = path.join(root, "e2e.db.sheets.json");
	fs.copyFileSync(FIXTURE, copy);
	const fixtureHash = crypto.createHash("sha256").update(fs.readFileSync(FIXTURE)).digest("hex");
	const { createFakeGoogle } = require(FAKE);
	const { google } = createFakeGoogle({ sheetsFile: copy });
	const authClient = await new google.auth.GoogleAuth({ keyFile: path.join(root, KEY_NAME), scopes: [] }).getClient();
	ok("GoogleAuth.getClient() answers without a key file", !!authClient);
	const sheets = google.sheets({ version: "v4", auth: authClient });
	const got = await sheets.spreadsheets.values.get({ spreadsheetId: "e2e-made-up-sheet", range: "Job Tracking!B1:B3" });
	eq("Sheets read the fixture copy", got.data.values, [["Load ID"], ["QA-E2E-1001"], ["QA-E2E-1002"]]);
	await sheets.spreadsheets.values.update({ spreadsheetId: "e2e-made-up-sheet", range: "Job Tracking!C2", valueInputOption: "USER_ENTERED", requestBody: { values: [["Flatbed"]] } });
	ok("a write lands in the copy", JSON.parse(fs.readFileSync(copy, "utf8")).spreadsheets["e2e-made-up-sheet"].sheets[0].values[1][2] === "Flatbed");
	eq("a write never touches the committed fixture", crypto.createHash("sha256").update(fs.readFileSync(FIXTURE)).digest("hex"), fixtureHash);
	let notFound = null;
	try { await sheets.spreadsheets.get({ spreadsheetId: PRODUCTION_SHEET }); } catch (e) { notFound = e.code; }
	eq("any other book answers 404 (the production sheet included)", notFound, 404);
	let driveCode = null;
	try { await google.drive({ version: "v3", auth: authClient }).files.list({ q: "x" }); } catch (e) { driveCode = e.code; }
	eq("Drive refuses every call (403)", driveCode, 403);

	// Installed by E2E_FAKE_SHEETS_FILE, as boot-server.sh preloads it: a child process.
	const probe = path.join(root, "probe-settings.txt");
	fs.writeFileSync(probe, "E2E_DOTENV_PROBE=loaded\n");
	const code = `
		const fs = require("fs"), path = require("path");
		const out = {};
		require("dotenv").config({ path: ${JSON.stringify(probe)} });
		out.dotenvLoaded = process.env.E2E_DOTENV_PROBE === "loaded";
		for (const [k, name] of [["key", ${JSON.stringify(KEY_NAME)}], ["settings", ${JSON.stringify(SETTINGS_NAME)}]]) {
			try { fs.readFileSync(path.join(${JSON.stringify(root)}, name)); out[k] = "read"; } catch (e) { out[k] = e.code; }
		}
		const { google } = require("googleapis");
		google.sheets({ version: "v4" }).spreadsheets.values.get({ spreadsheetId: "e2e-made-up-sheet", range: "Carrier Database!A2" })
			.then((r) => { out.cell = r.data.values; console.log("RESULT " + JSON.stringify(out)); });
	`;
	const r = spawnSync(process.execPath, ["--require", FAKE, "-e", code], {
		cwd: REPO, encoding: "utf8", timeout: 30_000,
		env: { PATH: process.env.PATH, HOME: process.env.HOME, E2E_FAKE_SHEETS_FILE: copy },
	});
	const line = String(r.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
	const res = line ? JSON.parse(line.slice(7)) : {};
	ok("installed: it says so in one log line", String(r.stdout || "").includes(require(FAKE).READY_LINE));
	eq("installed: dotenv loads nothing", res.dotenvLoaded, false);
	eq("installed: a read of the key file is refused before the disk (EACCES, not ENOENT)", res.key, "EACCES");
	eq("installed: a read of a settings file is refused before the disk", res.settings, "EACCES");
	eq("installed: require(\"googleapis\") is the stand-in, on the copy", res.cell, [["QA E2E Driver One"]]);
	ok("installed: the refusals are logged", /\[fake-google\] REFUSED/.test(String(r.stderr || "")));
}

// ---------------------------------------------------------------- 5. a boot on the stand-in
function freePort() {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
	});
}
function getJson(port) {
	return new Promise((resolve) => {
		const req = http.get({ host: "127.0.0.1", port, path: "/api/auth/session", timeout: 5000 }, (res) => {
			let body = "";
			res.on("data", (d) => { body += d; });
			res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
		});
		req.on("error", () => resolve(null));
		req.on("timeout", () => { req.destroy(); resolve(null); });
	});
}
const STUB_SERVER = `
const http = require("http");
const { google } = require("googleapis");
(async () => {
	const auth = new google.auth.GoogleAuth({ keyFile: "./${KEY_NAME}", scopes: [] });
	const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
	const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: "Job Tracking!B2" });
	let drive = null;
	try { await google.drive({ version: "v3" }).files.list({}); } catch (e) { drive = e.code; }
	const answer = JSON.stringify({ cell: r.data.values, drive, sheetIsFixture: process.env.SPREADSHEET_ID === "e2e-made-up-sheet",
		gmailBlank: process.env.GMAIL_APP_PASSWORD === "", mapsBlank: process.env.GOOGLE_MAPS_API_KEY === "" });
	http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(answer); })
		.listen(Number(process.env.PORT), process.env.BIND_HOST);
})();
`;
async function bootOnStandIn() {
	console.log("boot-server.sh: a stub server.js boots on the stand-in");
	const root = tempDir("boot");
	const work = path.join(root, "work");
	fs.mkdirSync(work, { mode: 0o700 });
	const db = path.join(work, "e2e.db");
	fs.writeFileSync(db, "");
	const wt = fakeWorktree(root);
	fs.writeFileSync(path.join(wt, "server.js"), STUB_SERVER);
	const port = await freePort();
	const pidFile = path.join(work, `server-${port}.pid`);
	try {
		const r = runBoot(wt, port, db, work);
		eq("boot-server.sh exits 0 (ready)", r.status, 0);
		ok("it reports the stand-in in place", String(r.stdout || "").includes("fake-google: googleapis is a stand-in"));
		ok("it made the run's Sheets copy beside the database", fs.existsSync(`${db}.sheets.json`));
		const answer = await getJson(port);
		eq("the server read the fixture through the stand-in", answer && answer.cell, [["QA-E2E-1001"]]);
		eq("the server's Drive refused (403)", answer && answer.drive, 403);
		ok("the server's SPREADSHEET_ID is the fixture's made-up book", !!(answer && answer.sheetIsFixture));
		ok("the server's Gmail password and Maps key are blank", !!(answer && answer.gmailBlank && answer.mapsBlank));
	} finally {
		// Stop exactly the process boot-server.sh recorded.
		const pid = Number((read(pidFile) || "").split("\n")[0]);
		if (Number.isInteger(pid) && pid > 0) {
			try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
		}
	}
}

(async () => {
	try {
		scriptsText();
		refusals();
		madeUpValues();
		await standIn();
		await bootOnStandIn();
	} catch (e) {
		failures++;
		console.log(`  FAIL unexpected error: ${e && e.message}`);
	} finally {
		for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
	}
	console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
	process.exit(failures ? 1 : 0);
})();
