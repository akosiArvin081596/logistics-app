#!/usr/bin/env node
// T-bytes: after this tree's change to lib/pdf-browser.js, a stored investor
// statement is still served from its file, byte for byte, through the real
// route, and Chromium never starts for it.
//
//   §1 the premise: the five template files' bytes differ from the recorded
//      ones (the computed hash moved), and PINS maps the new value back to the
//      hash the stored statements were filed under
//   §2 a cache hit through server.js, imported (LOGISX_IMPORT_ONLY=1) from an
//      export of this tree over a made-up database: a Super Admin's
//      GET /api/investor/payouts/<month>/statement?as_user_id=<investor>
//      answers the stored file byte for byte; the stored name and the file are
//      unchanged; the browser launcher never ran
//   §3 two negative controls, each made by editing a file in its own export,
//      never through a runtime hook: the PINS entry removed; one byte added to
//      lib/payout-statement.js. Each misses the cache and starts the launcher.
//   §4 the R-report (scripts/statement-cache-report.js) on that database: the
//      statement is served now and after; under the unpinned hash it is
//      "served now but not after"; a missing file is counted; no --db, no read
//   §5 the R-report's fingerprint and name query are server.js's
//
// Made-up data only (example.test). Google, mail and the network are stubbed
// in the import; the browser is a stand-in that only records that it was
// started. Temp folders only, removed at the end.
//
//   node scripts/test-statement-bytes.js      # exits 1 on any failure

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const MODULE_REL = path.join("lib", "statement-template-hash.js");
const REPORT = path.join(ROOT, "scripts", "statement-cache-report.js");
const PERIOD = "2026-08";
const STORED_PDF = Buffer.from("%PDF-1.4\n% made-up stored statement for T-bytes\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
	if (cond) { pass++; return; }
	failures.push(name);
	console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
}
function eq(name, got, want) {
	ok(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-tbytes-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

// The hash every stored statement is filed under: T-pin's RECORDED, read from
// that runner so there is one place to change it.
const RECORDED = (fs.readFileSync(path.join(__dirname, "test-statement-template-pin.js"), "utf8").match(/\nconst RECORDED = "([0-9a-f]{12})";/) || [])[1] || "";

// server.js's fingerprint and its version constant, lifted as text.
const SRC = serverSource();
function liftFunction(src, head) {
	const at = src.indexOf(head);
	if (at < 0) return "";
	const end = src.indexOf("\n}\n", at);
	return end < 0 ? "" : src.slice(at, end + 2);
}
const FINGERPRINT_SRC = liftFunction(SRC, "function statementFingerprint(row, who) {");
const VERSION_SRC = (SRC.match(/\nconst STATEMENT_TEMPLATE_VERSION = \d+;/) || [""])[0].trim();

// An export of this tree: its own copy of server.js, lib/ and what lib/ reads
// at load, with node_modules linked, so the app's data folder is the export.
let exportCount = 0;
function exportTree(edit) {
	const dir = path.join(TMP, `export-${++exportCount}`);
	fs.mkdirSync(dir);
	for (const f of ["server.js", "package.json", "logo.png", "logo.avif"]) {
		if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
	}
	for (const d of ["lib", "routes", "onboarding-templates"]) {
		if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
	}
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
	for (const d of ["home", "tmp"]) fs.mkdirSync(path.join(dir, d));
	if (edit) edit(dir);
	return dir;
}

// The stand-in browser: records that it was started, then exits.
const LAUNCHER_DIR = fs.mkdtempSync(path.join(TMP, "launcher-"));
const LAUNCH_LOG = path.join(LAUNCHER_DIR, "launches.log");
const LAUNCHER = path.join(LAUNCHER_DIR, "chrome");
fs.writeFileSync(LAUNCHER, `#!${process.execPath}\nrequire("fs").appendFileSync(${JSON.stringify(LAUNCH_LOG)}, "launch\\n");\nprocess.exit(1);\n`, { mode: 0o755 });

// The import, in a child: stubs first, then server.js, the made-up rows, one
// sign-in and one download. It writes what it saw to result.json.
const CHILD = path.join(TMP, "tbytes-child.js");
fs.writeFileSync(CHILD, `"use strict";
const Module = require("module");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const path = require("path");
const crypto = require("crypto");
const [exportDir, setupFile] = process.argv.slice(2);
const setup = JSON.parse(fs.readFileSync(setupFile, "utf8"));
const result = { steps: [] };
const finish = (code) => { fs.writeFileSync(path.join(exportDir, "result.json"), JSON.stringify(result)); process.exit(code); };
process.on("uncaughtException", (e) => { result.error = String(e && e.stack || e); finish(1); });

// Google answers with an empty Job Tracking sheet; mail goes nowhere.
const rows = [["Load ID", "Driver", "Job Status", "Truck", "Owner ID"]];
const op = async () => ({ data: { values: rows, sheets: [] } });
const google = {
	options() {},
	auth: { GoogleAuth: class { async getClient() { return {}; } } },
	sheets: () => ({ spreadsheets: { get: op, batchUpdate: op, values: { get: op, batchGet: op, update: op, batchUpdate: op, append: op, clear: op } } }),
	drive: () => ({ files: { list: async () => ({ data: { files: [] } }), get: op, create: op } }),
};
const nodemailer = { createTransport: () => ({ sendMail: async () => ({ messageId: "made-up" }) }) };
const realLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "googleapis") return { google };
	if (request === "nodemailer") return nodemailer;
	return realLoad.call(this, request, ...rest);
};
// Loopback only.
globalThis.fetch = async () => { throw new Error("test: no network (fetch)"); };
const loopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const a = Array.isArray(args[0]) ? args[0] : args;
	const o = a[0] && typeof a[0] === "object" ? a[0] : { port: a[0], host: a[1] };
	if (o.path || loopback(o.host || "localhost")) return connect.apply(this, args);
	throw new Error("test: no network (connect)");
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
	if (loopback(host)) return lookup.call(dns, host, ...rest);
	throw new Error("test: no network (dns)");
};

(async () => {
	const { server } = require(path.join(exportDir, "server.js"));
	const Database = require(path.join(exportDir, "node_modules", "better-sqlite3"));
	const bcrypt = require(path.join(exportDir, "node_modules", "bcryptjs"));
	const db = new Database(setup.database);
	const hash = bcrypt.hashSync(setup.password, 4);
	const admin = db.prepare("INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, 'Super Admin', ?)").run("tbytes-admin", hash, "tbytes-admin@example.test").lastInsertRowid;
	const investor = db.prepare("INSERT INTO users (username, password_hash, role, email, company_name) VALUES (?, ?, 'Investor', ?, ?)").run("tbytes-investor", hash, "tbytes-investor@example.test", "Made-Up Holdings LLC").lastInsertRowid;
	const payoutId = db.prepare(\`INSERT INTO investor_payouts (owner_id, period, amount, due_date, status, paid_at, paid_by, finalized_at, finalized_amount)
		VALUES (?, ?, 1234.56, '2026-09-25', 'paid', '2026-09-25T15:00:00Z', 'tbytes-admin', '2026-09-15T05:00:00Z', 1234.56)\`).run(investor, setup.period).lastInsertRowid;
	// The stored statement, named the way the route names it under the hash
	// the stored statements were filed under.
	const row = db.prepare("SELECT * FROM investor_payouts WHERE id = ?").get(payoutId);
	const who = db.prepare(\`SELECT COALESCE(NULLIF(TRIM(i.full_name),''), NULLIF(TRIM(u.company_name),''), u.username) AS name,
	        COALESCE(NULLIF(TRIM(u.company_name),''), NULLIF(TRIM(i.carrier_name),''), '') AS company
	   FROM users u LEFT JOIN investors i ON i.user_id = u.id WHERE u.id = ?\`).get(investor);
	const fingerprint = new Function("crypto", "STATEMENT_TEMPLATE_HASH", \`\${setup.versionSrc}\\n\${setup.fingerprintSrc}\\nreturn statementFingerprint;\`)(crypto, setup.recorded);
	const name = \`payout-\${row.owner_id}-\${row.period}-\${fingerprint(row, who)}.pdf\`;
	const dir = path.join(exportDir, "storage", "payout-statements");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, name), Buffer.from(setup.storedPdf, "base64"), { mode: 0o600 });
	db.prepare("UPDATE investor_payouts SET statement_pdf_file_name = ? WHERE id = ?").run(name, payoutId);
	result.name = name;
	result.investor = Number(investor);
	result.admin = Number(admin);

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = \`http://127.0.0.1:\${server.address().port}\`;
	const http = require("http");
	const request = (method, url, { body, cookie } = {}) => new Promise((resolve, reject) => {
		const data = body ? JSON.stringify(body) : null;
		const req = http.request(base + url, { method, headers: { "X-Requested-With": "XMLHttpRequest", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
	const login = await request("POST", "/api/auth/login", { body: { username: "tbytes-admin", password: setup.password } });
	result.login = login.status;
	const cookie = (login.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
	const got = await request("GET", \`/api/investor/payouts/\${setup.period}/statement?as_user_id=\${investor}\`, { cookie });
	result.status = got.status;
	result.contentType = got.headers["content-type"] || "";
	result.sha = crypto.createHash("sha256").update(got.body).digest("hex");
	result.storedSha = crypto.createHash("sha256").update(Buffer.from(setup.storedPdf, "base64")).digest("hex");
	result.nameAfter = db.prepare("SELECT statement_pdf_file_name AS n FROM investor_payouts WHERE id = ?").get(payoutId).n;
	result.fileAfter = fs.existsSync(path.join(dir, name)) ? crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex") : null;
	server.close();
	db.close();
	finish(0);
})().catch((e) => { result.error = String(e && e.stack || e); finish(1); });
`);

function runScenario(label, dir) {
	fs.rmSync(LAUNCH_LOG, { force: true });
	const setupFile = path.join(dir, "tbytes-setup.json");
	fs.writeFileSync(setupFile, JSON.stringify({
		database: path.join(dir, "scratch.db"),
		password: "made-up-password-tbytes-0001",
		period: PERIOD,
		recorded: RECORDED,
		versionSrc: VERSION_SRC,
		fingerprintSrc: FINGERPRINT_SRC,
		storedPdf: STORED_PDF.toString("base64"),
	}));
	const run = spawnSync(process.execPath, [CHILD, dir, setupFile], {
		cwd: dir,
		encoding: "utf8",
		timeout: 50000,
		maxBuffer: 32 * 1024 * 1024,
		env: {
			PATH: process.env.PATH || "/usr/bin:/bin",
			LOGISX_IMPORT_ONLY: "1",
			DATABASE_PATH: path.join(dir, "scratch.db"),
			SPREADSHEET_ID: "made-up-tbytes-sheet",
			SESSION_SECRET: "made-up-tbytes-session-value-not-a-secret",
			NODE_ENV: "test",
			HOME: path.join(dir, "home"),
			TMPDIR: path.join(dir, "tmp"),
			PUPPETEER_EXECUTABLE_PATH: LAUNCHER,
		},
	});
	let result = null;
	try { result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")); } catch { /* reported below */ }
	const launches = fs.existsSync(LAUNCH_LOG) ? fs.readFileSync(LAUNCH_LOG, "utf8").split("\n").filter(Boolean).length : 0;
	const output = `${run.stdout || ""}${run.stderr || ""}`;
	ok(`${label}: the import ran and reported (exit ${run.status})`, !!result && !result.error && run.status === 0,
		(result && result.error) || output.split("\n").slice(-12).join("\n"));
	return { result: result || {}, launches, output };
}

console.log("§1 the premise");
let mod = null;
try { mod = require(path.join(ROOT, MODULE_REL)); } catch (e) { mod = null; }
ok("§1 RECORDED is read from T-pin", /^[0-9a-f]{12}$/.test(RECORDED), RECORDED);
ok("§1 server.js's fingerprint and version are found", FINGERPRINT_SRC.includes("STATEMENT_TEMPLATE_HASH") && /^const STATEMENT_TEMPLATE_VERSION = \d+;$/.test(VERSION_SRC));
const computed = mod ? mod.computeStatementTemplateHash() : "";
const effective = mod ? mod.effectiveStatementTemplateHash() : "";
ok("§1 this tree's template bytes differ from the recorded ones (the computed hash moved)", !!computed && computed !== RECORDED, computed);
eq("§1 PINS maps the new value back to the stored hash", mod && Object.hasOwn(mod.PINS, computed) ? mod.PINS[computed] : null, RECORDED);
eq("§1 so the effective hash is still the stored one", effective, RECORDED);

console.log("§2 a cache hit, through the route");
const hitDir = exportTree();
const hit = runScenario("§2", hitDir);
eq("§2 the sign-in answers 200", hit.result.login, 200);
eq("§2 the download answers 200 with a PDF", [hit.result.status, String(hit.result.contentType).split(";")[0]], [200, "application/pdf"]);
eq("§2 the bytes are the stored file's, byte for byte", hit.result.sha, sha(STORED_PDF));
eq("§2 the stored name is unchanged", hit.result.nameAfter, hit.result.name);
eq("§2 the stored file is still there, unchanged", hit.result.fileAfter, sha(STORED_PDF));
eq("§2 the browser launcher never ran", hit.launches, 0);

console.log("§3 negative controls (edits to an export, never a runtime hook)");
const unpinnedDir = exportTree((dir) => {
	const file = path.join(dir, MODULE_REL);
	const text = fs.readFileSync(file, "utf8");
	const at = text.indexOf("const PINS = Object.freeze({");
	const end = at >= 0 ? text.indexOf("});", at) : -1;
	if (at >= 0 && end > at) fs.writeFileSync(file, `${text.slice(0, at)}const PINS = Object.freeze({${text.slice(end)}`);
});
{
	const copy = require(path.join(unpinnedDir, MODULE_REL));
	eq("§3 the PINS entry removed: the export's PINS is empty", Object.keys(copy.PINS), []);
	const r = runScenario("§3 the PINS entry removed", unpinnedDir);
	ok("§3 the PINS entry removed: the cache misses and the launcher starts", r.launches >= 1, `launches ${r.launches}, status ${r.result.status}`);
	eq("§3 ...the stand-in exits, so that download fails rather than serving the stored file", r.result.status, 500);
}
const byteDir = exportTree((dir) => fs.appendFileSync(path.join(dir, "lib", "payout-statement.js"), "\n"));
{
	const r = runScenario("§3 one byte added to lib/payout-statement.js", byteDir);
	ok("§3 one byte added to lib/payout-statement.js: the cache misses and the launcher starts", r.launches >= 1, `launches ${r.launches}, status ${r.result.status}`);
	eq("§3 ...and that download fails too", r.result.status, 500);
}

console.log("§4 the R-report");
const report = (args) => {
	const r = spawnSync(process.execPath, [REPORT, ...args], { encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH || "/usr/bin:/bin" } });
	const count = (label) => {
		const m = (r.stdout || "").match(new RegExp(`^  ${label.replace(/[()]/g, "\\$&")}:\\s+(\\d+)$`, "m"));
		return m ? Number(m[1]) : null;
	};
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, count };
};
const db = path.join(hitDir, "scratch.db");
const statements = path.join(hitDir, "storage", "payout-statements");
{
	const r = report(["--db", db, "--statements-dir", statements, "--now-hash", RECORDED, "--after-hash", effective || "000000000000"]);
	eq("§4 under this tree's effective hash: exit 0", r.code, 0);
	eq("§4 ...one stored statement, served from its file now and after",
		[r.count("stored statements"), r.count("served from file now"), r.count("served from file after")], [1, 1, 1]);
	eq("§4 ...none served now but not after, none missing", [r.count("served now but not after (must be 0)"), r.count("stored files missing, empty or unreadable")], [0, 0]);
	ok("§4 ...counts only: no file name, month or name printed", !/payout-\d|2026-08|tbytes|Made-Up/.test(r.out), r.out);
}
{
	const r = report(["--db", db, "--statements-dir", statements, "--now-hash", RECORDED, "--after-hash", computed || "000000000000"]);
	eq("§4 under the unpinned hash: exit 1", r.code, 1);
	eq("§4 ...the statement is served now but not after", r.count("served now but not after (must be 0)"), 1);
}
{
	const empty = fs.mkdtempSync(path.join(TMP, "no-files-"));
	const r = report(["--db", db, "--statements-dir", empty, "--now-hash", RECORDED, "--after-hash", RECORDED]);
	eq("§4 a stored file that is gone: counted, and served neither now nor after", [r.count("stored files missing, empty or unreadable"), r.count("served from file now")], [1, 0]);
}
for (const [label, args] of [
	["no --db", ["--statements-dir", statements, "--now-hash", RECORDED, "--after-hash", RECORDED]],
	["no --statements-dir", ["--db", db, "--now-hash", RECORDED, "--after-hash", RECORDED]],
	["a hash that isn't 12 hex", ["--db", db, "--statements-dir", statements, "--now-hash", "made-up", "--after-hash", RECORDED]],
	["a database that doesn't exist", ["--db", path.join(TMP, "missing.db"), "--statements-dir", statements, "--now-hash", RECORDED, "--after-hash", RECORDED]],
]) {
	const r = report(args);
	eq(`§4 ${label}: exit 2`, r.code, 2);
	ok(`§4 ${label}: no counts printed`, !/stored statements:/.test(r.out), r.out);
}
ok("§4 a database that doesn't exist is not created", !fs.existsSync(path.join(TMP, "missing.db")));

console.log("§5 the R-report is server.js's rule");
{
	let reportSrc = "";
	try { reportSrc = fs.readFileSync(REPORT, "utf8"); } catch { /* each check below then fails on its own */ }
	ok("§5 scripts/statement-cache-report.js is there", !!reportSrc);
	const theirs = liftFunction(reportSrc, "function statementFingerprint(row, who, hash) {");
	const theirVersion = (reportSrc.match(/\nconst STATEMENT_TEMPLATE_VERSION = \d+;/) || [""])[0].trim();
	eq("§5 the same template version", theirVersion, VERSION_SRC);
	let reportFp = null;
	let serverFp = null;
	try {
		reportFp = new Function("crypto", `${theirVersion}\n${theirs}\nreturn statementFingerprint;`)(crypto);
		serverFp = (hash) => new Function("crypto", "STATEMENT_TEMPLATE_HASH", `${VERSION_SRC}\n${FINGERPRINT_SRC}\nreturn statementFingerprint;`)(crypto, hash);
	} catch (e) {
		ok("§5 both fingerprints compile", false, e.message);
	}
	if (reportFp && serverFp) {
		const rows = [
			{ owner_id: 7, period: "2026-08", status: "paid", paid_at: "2026-09-25T15:00:00Z", paid_by: "made-up", amount: 1234.56, adjustment: 0, adjustment_note: "", adjusted_at: "", finalized_at: "2026-09-15T05:00:00Z", finalized_amount: 1234.56, finalized_breakdown: "" },
			{ owner_id: 12, period: "2026-07", status: "owed", paid_at: null, paid_by: null, amount: 10, adjustment: -2.5, adjustment_note: "made-up note", adjusted_at: "2026-08-02", finalized_at: "", finalized_amount: null, finalized_breakdown: "{\"a\":1}" },
		];
		const whos = [{ name: "Made-Up Holdings LLC", company: "" }, { name: "made-up", company: "Made-Up Co" }, null];
		let same = true;
		for (const row of rows) for (const who of whos) for (const hash of [RECORDED, computed, null]) {
			if (reportFp(row, who, hash) !== serverFp(hash)(row, who)) same = false;
		}
		ok("§5 the same fingerprint for every made-up row, name and hash", same);
	}
	const norm = (s) => s.replace(/\s+/g, " ").trim();
	const whoSql = (src) => (src.match(/SELECT COALESCE\(NULLIF\(TRIM\(i\.full_name\),''\)[\s\S]*?WHERE u\.id = \?/) || [""])[0];
	ok("§5 the same name query as the route", !!whoSql(SRC) && norm(whoSql(SRC)) === norm(whoSql(reportSrc)));
	ok("§5 the same file-name shape as the route", (SRC.match(/\nconst STATEMENT_FILE_RE = (\/[^\n]+\/);/) || [])[1] === (reportSrc.match(/\nconst STATEMENT_FILE_RE = (\/[^\n]+\/);/) || [])[1]);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
