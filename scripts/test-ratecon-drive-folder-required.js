#!/usr/bin/env node
/**
 * The rate-con Drive folder comes from RATECON_DRIVE_FOLDER_ID and nowhere
 * else. There is no default in code: unset or blank, the rate-con Drive
 * features are off, nothing calls Drive, the server still starts, and it logs
 * one warning naming the setting.
 *
 *   §1 source: no folder ID is written in server.js, lib/ or scripts/ (the one
 *      production uses is found by its SHA-256, so this file does not carry it
 *      either); no `RATECON_DRIVE_FOLDER_ID || "<literal>"` fallback anywhere;
 *      server.js reads the setting from the environment only, trimmed; every
 *      server.js reference to it is a known shape, so a new Drive use fails
 *      here until it is checked.
 *   §2 server.js, booted: unset or blank, it starts, logs the warning exactly
 *      once (not again per request), and POST /api/admin/ratecon-index answers
 *      503 with no Drive call; set, no warning, and the route lists exactly the
 *      configured folder.
 *   §3 the other paths, lifted from server.js and run: getRateConBytes() (the
 *      draft-invoice lookup, by file name and by content) and the
 *      POST /api/loads/from-ratecon mirror make no Drive call without the
 *      setting and use the configured ID with it; the local rate-con archive is
 *      written either way.
 *   §4 scripts/repair-job-tracking-addresses.js refuses without the setting
 *      (exit 2, naming it) before any Google call, and reads it from its
 *      LOGISX_ROOT .env (after dotenv, not before).
 *   §5 a replica: getDrive() refuses before any Google client is built, and
 *      every Drive call in server.js is made on getDrive()'s client.
 *
 * Hermetic: every child runs in a fresh mkdtemp folder (no .env, no service
 * account key) with googleapis replaced by a recording stub and every outbound
 * connection refused (loopback only, for the booted server's own listener), so
 * nothing reaches Google or the network even if a check regresses. Fake folder
 * IDs only.
 *   node scripts/test-ratecon-drive-folder-required.js
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");
// SHA-256 of the folder ID production's .env names. Only the digest is kept,
// so this runner can find the ID without carrying it.
const PROD_FOLDER_SHA256 = "8d4eb17c3cff0b3ebe5d92ca6d56a18cda1b7059e6ae3932f89c4267f47157a2";
const PROD_FOLDER_LENGTH = 33;
const FOLDER = "folder-under-test-r2";
const TEST_SHEET = "sheet-under-test-r2";
const WARNING_RE = /RATECON_DRIVE_FOLDER_ID is not set/;

// The windows of `text` that are production's folder ID, by digest.
function prodFolderAt(text) {
	const hits = [];
	for (const m of String(text).matchAll(/[A-Za-z0-9_-]{33,}/g)) {
		for (let i = 0; i + PROD_FOLDER_LENGTH <= m[0].length; i++) {
			const w = m[0].slice(i, i + PROD_FOLDER_LENGTH);
			if (crypto.createHash("sha256").update(w).digest("hex") === PROD_FOLDER_SHA256) hits.push(w);
		}
	}
	return hits;
}
// A failure never prints production's folder ID, whatever the code under test did.
const redact = (s) => prodFolderAt(s).reduce((out, id) => out.split(id).join("<production folder>"), String(s));

let pass = 0;
const failures = [];
function check(label, cond) {
	if (cond) { pass++; return; }
	failures.push(redact(label));
	console.log(`  FAIL  ${redact(label)}`);
}
const readSource = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };
const QUIET = { log() {}, warn() {}, error() {}, info() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-ratecon-folder-"));
const log = path.join(tmp, "calls.log");
const stub = path.join(tmp, "no-network.js");
fs.writeFileSync(stub, `"use strict";
const Module = require("module");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const rows = [["Load ID", "Driver", "Job Status", "Truck", "Owner ID"]];
const op = (name) => async (params) => { note("sheets " + name + " " + (params && params.spreadsheetId)); return { data: { values: rows, sheets: [] } }; };
const driveOp = (name) => async (params) => { note("drive " + name + " " + JSON.stringify(params || {})); return { data: { files: [], id: "drive-file-under-test" } }; };
const google = {
	options() {},
	auth: { GoogleAuth: class { constructor() { note("google auth"); } async getClient() { return {}; } } },
	sheets: () => ({ spreadsheets: { get: op("get"), batchUpdate: op("batchUpdate"), values: {
		get: op("values.get"), batchGet: op("values.batchGet"), update: op("values.update"),
		batchUpdate: op("values.batchUpdate"), append: op("values.append"), clear: op("values.clear") } } }),
	drive: () => { note("drive client"); return { files: { list: driveOp("files.list"), get: driveOp("files.get"), create: driveOp("files.create"),
		update: driveOp("files.update"), delete: driveOp("files.delete"), copy: driveOp("files.copy") },
		permissions: { create: driveOp("permissions.create") } }; },
};
const real = Module._load;
Module._load = function (request, ...rest) { return request === "googleapis" ? { google } : real.call(this, request, ...rest); };
const loopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const a = Array.isArray(args[0]) ? args[0] : args;
	const o = a[0] && typeof a[0] === "object" ? a[0] : { port: a[0], host: a[1] };
	if (o.path || loopback(o.host || "localhost")) return connect.apply(this, args);
	note("network connect " + o.host);
	throw new Error("test: no network (connect " + o.host + ")");
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
	if (loopback(host)) return lookup.call(dns, host, ...rest);
	note("network dns " + host);
	throw new Error("test: no network (dns " + host + ")");
};
`);
const callLines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const childEnv = (cwd, env) => ({ PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, NODE_OPTIONS: `--require ${JSON.stringify(stub)}`, ...env });

// ---------------------------------------------------------------- §2 helpers
function freePort() {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.on("error", reject);
		s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
	});
}
// server.js in its own empty folder, with its own database, the stub preloaded.
async function bootServer(extra) {
	const cwd = fs.mkdtempSync(path.join(tmp, "srv-"));
	fs.rmSync(log, { force: true });
	const port = await freePort();
	const env = childEnv(cwd, {
		PORT: String(port), BIND_HOST: "127.0.0.1", NODE_ENV: "development", SESSION_SECRET: "s".repeat(48),
		SPREADSHEET_ID: TEST_SHEET, DATABASE_PATH: path.join(cwd, "app.db"), ...extra,
	});
	const child = spawn(process.execPath, [SERVER], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (d) => { out += d; });
	child.stderr.on("data", (d) => { out += d; });
	const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
	const deadline = Date.now() + 20_000;
	while (!/Server running at/.test(out) && child.exitCode === null && Date.now() < deadline) await delay(25);
	const stop = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		const done = await Promise.race([exited.then(() => true), delay(5000).then(() => false)]);
		if (!done) child.kill("SIGKILL");
	};
	return { port, up: /Server running at/.test(out), output: () => out, stop };
}
async function request(port, method, url, { cookie, body } = {}) {
	const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
	if (cookie) headers.Cookie = cookie;
	const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch { /* not JSON */ }
	const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
	return { status: res.status, json, cookie: set.map((c) => c.split(";")[0]).join("; ") };
}
// First-time setup on the fresh database signs the new Super Admin in.
async function signIn(port) {
	const r = await request(port, "POST", "/api/auth/setup", { body: { username: "rc-folder-admin", password: "rc-folder-pass-0123456789" } });
	return r.status === 200 ? r.cookie : "";
}

// ---------------------------------------------------------------- §3 helpers
// A top-level function from server.js, by its body's braces.
function extractFn(name) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const hits = needles.reduce((n, nd) => n + (SRC.split(nd).length - 1), 0);
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needles.find((nd) => SRC.includes(nd))) + 1;
	const bodyOpen = SRC.indexOf(") {", start);
	let depth = 0;
	for (let j = bodyOpen + 2; j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}
function extractConstLine(name) {
	const needle = `\nconst ${name} = `;
	if (SRC.split(needle).length - 1 !== 1) throw new Error(`expected exactly 1 declaration of ${name} in server.js`);
	const start = SRC.indexOf(needle) + 1;
	return SRC.slice(start, SRC.indexOf("\n", start));
}
// A Drive client that records each call.
function recordingDrive() {
	const calls = [];
	const drive = {
		files: {
			list: async (p) => { calls.push({ op: "list", q: p.q }); return { data: { files: [], nextPageToken: null } }; },
			get: async (p) => { calls.push({ op: "get", fileId: p.fileId }); return { data: new ArrayBuffer(0) }; },
			create: async (p) => { calls.push({ op: "create", parents: p.requestBody && p.requestBody.parents }); return { data: { id: "drive-file-under-test", name: "x.pdf" } }; },
		},
	};
	return { calls, getDrive: async () => { calls.push({ op: "getDrive" }); return drive; } };
}
function liftGetRateConBytes(folder) {
	const rc = require(path.join(ROOT, "lib", "ratecon-drive-index.js"));
	const d = recordingDrive();
	const deps = {
		db: { prepare: () => ({ all: () => [] }) },
		fetchDocumentBytes: async () => null,
		RATECON_DRIVE_FOLDER_ID: folder,
		getDrive: d.getDrive,
		rcIndexShared: rc,
		rateconScanMissedRecently: () => false,
		rememberRateConScanMiss: () => {},
		rememberRateConMatch: () => {},
		require: (p) => { if (p === "./lib/ratecon-drive-index.js") return rc; throw new Error(`unexpected require(${p})`); },
		brokerInvoice: { extractPdfText: () => "" },
		RATECON_CONTENT_WINDOW_DAYS: 21,
		RATECON_CONTENT_MAX_FILES: 40,
		RATECON_CONTENT_CONCURRENCY: 6,
		console: QUIET,
		Buffer,
	};
	const body = [extractConstLine("RATECON_DOC_TYPES"), extractConstLine("normLoadKey"), extractFn("getRateConBytes"), "return getRateConBytes;"].join("\n");
	const names = Object.keys(deps);
	return { getRateConBytes: new Function(...names, body)(...names.map((n) => deps[n])), calls: d.calls };
}
// POST /api/loads/from-ratecon's rate-con archive step (the local copy, then
// the Drive mirror), lifted from the route and run on its own.
const ARCHIVE_FROM = "\t\tlet rateconArchived = false;\n";
const ARCHIVE_TO = "\t\t// ---- 8) load_coordinates + audit trail + dispatch notification ----";
function liftArchive(folder) {
	const from = SRC.indexOf(ARCHIVE_FROM);
	const to = SRC.indexOf(ARCHIVE_TO, from);
	if (from < 0 || to < 0 || SRC.split(ARCHIVE_FROM).length !== 2) throw new Error("could not locate from-ratecon's archive step");
	const dataDir = fs.mkdtempSync(path.join(tmp, "data-"));
	const d = recordingDrive();
	const sql = [];
	const deps = {
		path, fs, DATA_DIR: dataDir, Buffer, require, console: QUIET,
		db: { prepare: (s) => ({ run: () => { sql.push(s.trim().split(/\s+/)[0]); return { changes: 1 }; } }) },
		getDrive: d.getDrive,
		RATECON_DRIVE_FOLDER_ID: folder,
	};
	const names = Object.keys(deps);
	const run = new Function(...names, `return async (pdfBase64, loadId, warnings) => {\n${SRC.slice(from, to)}\nreturn rateconArchived;\n};`)(...names.map((n) => deps[n]));
	return { run, calls: d.calls, sql, dataDir };
}

(async () => {
	try {
		console.log("§1 source");
		{
			const files = [];
			const walk = (dir) => {
				for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
					if (e.name === "node_modules") continue;
					const p = path.join(dir, e.name);
					if (e.isDirectory()) walk(p);
					else files.push(path.relative(ROOT, p));
				}
			};
			walk(path.join(ROOT, "scripts"));
			walk(path.join(ROOT, "lib"));
			files.push("server.js");
			const naming = files.filter((f) => prodFolderAt(readSource(f)).length > 0);
			check(`§1 production's rate-con folder ID is in no file of server.js, lib/ or scripts/ (${naming.join(", ") || "none"})`, naming.length === 0);
			const fallback = /RATECON_DRIVE_FOLDER_ID\b[^\n;]{0,40}(\|\||\?\?)\s*["'`][^"'`\s]{8,}/;
			// This file holds the pattern itself.
			const withFallback = files.filter((f) => f !== "scripts/test-ratecon-drive-folder-required.js" && fallback.test(readSource(f)));
			check(`§1 no RATECON_DRIVE_FOLDER_ID fallback to a literal (${withFallback.join(", ") || "none"})`, withFallback.length === 0);

			const def = SRC.match(/\nconst RATECON_DRIVE_FOLDER_ID = ([^;]+);/);
			check("§1 server.js declares RATECON_DRIVE_FOLDER_ID once", !!def && SRC.split("\nconst RATECON_DRIVE_FOLDER_ID = ").length === 2);
			const value = (env) => { try { return new Function("process", `return ${def[1]};`)({ env }); } catch (e) { return `threw ${e.message}`; } };
			if (def) {
				check("§1 unset: empty", value({}) === "");
				check("§1 blank: empty", value({ RATECON_DRIVE_FOLDER_ID: "   " }) === "");
				check("§1 set: the value, trimmed", value({ RATECON_DRIVE_FOLDER_ID: `  ${FOLDER}\n` }) === FOLDER);
			}
			// Every reference outside comments is one of these. A new one fails here
			// until it is checked to skip Drive when the setting is empty.
			const SHAPES = [
				/^const RATECON_DRIVE_FOLDER_ID = String\(process\.env\.RATECON_DRIVE_FOLDER_ID \?\? ""\)\.trim\(\);$/,
				/^if \(!RATECON_DRIVE_FOLDER_ID\) \{$/,
				/^if \(!RATECON_DRIVE_FOLDER_ID\) return res\.status\(503\)\.json\(\{ error: "No rate-con Drive folder is configured\." \}\);$/,
				/^if \(RATECON_DRIVE_FOLDER_ID && safe\) \{$/,
				/^if \(!candidates\.length && RATECON_DRIVE_FOLDER_ID && safe && loadCtx && !rateconScanMissedRecently\(scanMissKey\)\) \{$/,
				/^if \(RATECON_DRIVE_FOLDER_ID\) \{$/,
				/^q: `'\$\{RATECON_DRIVE_FOLDER_ID\}' in parents and trashed = false`,$/,
				/^q: `'\$\{RATECON_DRIVE_FOLDER_ID\}' in parents and trashed = false and name contains '\$\{safe\}'`,$/,
				/^parents: \[RATECON_DRIVE_FOLDER_ID\],$/,
			];
			const refs = SRC.split("\n").map((l, i) => ({ n: i + 1, l: l.trim() }))
				.filter((x) => /RATECON_DRIVE_FOLDER_ID/.test(x.l) && !/^(\/\/|\*)/.test(x.l) && !/^"/.test(x.l));
			const unknown = refs.filter((x) => !SHAPES.some((re) => re.test(x.l)));
			check(`§1 every server.js reference to the setting is a known shape (${unknown.map((x) => `${x.n}: ${redact(x.l).slice(0, 70)}`).join(" | ") || "none unknown"})`, unknown.length === 0);
		}

		console.log("§2 server.js, booted");
		for (const [label, extra] of [["unset", {}], ["blank", { RATECON_DRIVE_FOLDER_ID: "   " }]]) {
			const s = await bootServer(extra);
			try {
				check(`§2 ${label}: the server starts`, s.up);
				const atBoot = callLines();
				check(`§2 ${label}: no Drive call at start (${atBoot.filter((c) => /^drive/.test(c)).join("; ") || "none"})`, !atBoot.some((c) => /^drive/.test(c)));
				check(`§2 ${label}: the warning is logged once at start`, (s.output().match(new RegExp(WARNING_RE.source, "g")) || []).length === 1);
				const cookie = s.up ? await signIn(s.port) : "";
				check(`§2 ${label}: signed in as the first Super Admin`, !!cookie);
				const r = cookie ? await request(s.port, "POST", "/api/admin/ratecon-index", { cookie, body: {} }) : { status: 0 };
				check(`§2 ${label}: POST /api/admin/ratecon-index answers 503 (got ${r.status})`, r.status === 503 && /No rate-con Drive folder is configured/.test((r.json && r.json.error) || ""));
				const drive = callLines().filter((c) => /^(drive|network)/.test(c));
				check(`§2 ${label}: …with no Drive call and no connection (${drive.join("; ") || "none"})`, drive.length === 0);
				check(`§2 ${label}: still one warning after the request (once per start, never per request)`, (s.output().match(new RegExp(WARNING_RE.source, "g")) || []).length === 1);
			} finally {
				await s.stop();
			}
		}
		{
			const s = await bootServer({ RATECON_DRIVE_FOLDER_ID: FOLDER });
			try {
				check("§2 set: the server starts", s.up);
				check("§2 set: no warning", s.up && !WARNING_RE.test(s.output()));
				const cookie = s.up ? await signIn(s.port) : "";
				check("§2 set: signed in as the first Super Admin", !!cookie);
				if (cookie) await request(s.port, "POST", "/api/admin/ratecon-index", { cookie, body: {} });
				const lists = callLines().filter((c) => /^drive files\.list /.test(c)).map((c) => JSON.parse(c.slice("drive files.list ".length)).q);
				check(`§2 set: POST /api/admin/ratecon-index lists the configured folder, and only it (${lists.join("; ") || "no list"})`,
					lists.length > 0 && lists.every((q) => q.startsWith(`'${FOLDER}' in parents`)));
				check("§2 set: no connection", !callLines().some((c) => /^network/.test(c)));
			} finally {
				await s.stop();
			}
		}

		console.log("§3 the draft-invoice lookup and the from-ratecon mirror");
		{
			const ctx = { totalRate: "$1,500.00", assignedDate: "2026-09-01", pickupAddress: "Irving, TX", dropoffAddress: "Laredo, TX" };
			for (const [label, folder] of [["unset", ""]]) {
				const g = liftGetRateConBytes(folder);
				const got = await g.getRateConBytes("7007280", {}, ctx, { persist: false });
				check(`§3 getRateConBytes(), ${label}: no Drive call (${JSON.stringify(g.calls)})`, g.calls.length === 0);
				check(`§3 getRateConBytes(), ${label}: answers "nothing found" as before`, got.buffer === null && got.candidates.length === 0);
			}
			{
				const g = liftGetRateConBytes(FOLDER);
				await g.getRateConBytes("7007280", {}, ctx, { persist: false });
				const qs = g.calls.filter((c) => c.op === "list").map((c) => c.q);
				check(`§3 getRateConBytes(), set: searches the configured folder by name (${qs.join(" | ")})`, qs.some((q) => q === `'${FOLDER}' in parents and trashed = false and name contains '7007280'`));
				check("§3 getRateConBytes(), set: …and by content", qs.some((q) => q === `'${FOLDER}' in parents and trashed = false`));
				check("§3 getRateConBytes(), set: every list names the configured folder", qs.length >= 2 && qs.every((q) => q.startsWith(`'${FOLDER}' in parents`)));
			}
			const pdf = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");
			{
				const a = liftArchive("");
				const warnings = [];
				const archived = await a.run(pdf, "RC-7001", warnings);
				check("§3 from-ratecon, unset: the rate-con is archived locally", archived === true && fs.existsSync(path.join(a.dataDir, "uploads", "rate-cons", "RC-7001.pdf")));
				check(`§3 from-ratecon, unset: no Drive call (${JSON.stringify(a.calls)})`, a.calls.length === 0);
				check("§3 from-ratecon, unset: no warning to the dispatcher", warnings.length === 0);
			}
			{
				const a = liftArchive(FOLDER);
				const warnings = [];
				const archived = await a.run(pdf, "RC-7002", warnings);
				const creates = a.calls.filter((c) => c.op === "create");
				check("§3 from-ratecon, set: the rate-con is archived locally", archived === true && fs.existsSync(path.join(a.dataDir, "uploads", "rate-cons", "RC-7002.pdf")));
				check(`§3 from-ratecon, set: mirrored into the configured folder (${JSON.stringify(creates)})`, creates.length === 1 && JSON.stringify(creates[0].parents) === JSON.stringify([FOLDER]));
				check("§3 from-ratecon, set: the Drive copy's ID is kept on the documents row", a.sql.includes("UPDATE"));
			}
		}

		console.log("§4 scripts/repair-job-tracking-addresses.js");
		{
			const script = path.join(ROOT, "scripts", "repair-job-tracking-addresses.js");
			const run = (root, args = []) => {
				const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
				fs.rmSync(log, { force: true });
				const r = spawnSync(process.execPath, [script, `--sheet-id=${TEST_SHEET}`, `--db=${path.join(cwd, "none.db")}`, ...args],
					{ cwd, env: childEnv(cwd, { LOGISX_ROOT: root, GEMINI_API_KEY: "fake-gemini-key-r2" }), encoding: "utf8", timeout: 20_000 });
				return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls: callLines() };
			};
			// A checkout of its own (LOGISX_ROOT): the shipped server.js and lib/,
			// linked, and a .env only when a case writes one.
			const checkout = () => {
				const d = fs.mkdtempSync(path.join(tmp, "root-"));
				fs.symlinkSync(SERVER, path.join(d, "server.js"));
				fs.symlinkSync(path.join(ROOT, "lib"), path.join(d, "lib"));
				return d;
			};
			const r = run(checkout());
			check(`§4 without the setting: refuses (exit ${r.code}), naming it`, r.code === 2 && WARNING_RE.test(r.out));
			check(`§4 …before any Google call or connection (${r.calls.join("; ") || "none"})`, r.calls.length === 0);
			const named = checkout();
			fs.writeFileSync(path.join(named, ".env"), `RATECON_DRIVE_FOLDER_ID=${FOLDER}\n`);
			const n = run(named);
			check("§4 with the setting in LOGISX_ROOT's .env: not refused for it", !WARNING_RE.test(n.out));
			check(`§4 …and no Drive call without a row selection (${n.calls.filter((c) => /^drive/.test(c)).join("; ") || "none"})`, !n.calls.some((c) => /^drive/.test(c)));
			check(`§4 …and no connection (${n.calls.filter((c) => /^network/.test(c)).join("; ") || "none"})`, !n.calls.some((c) => /^network/.test(c)));
		}

		console.log("§5 replica");
		{
			const lift = (replica) => {
				const built = [];
				const offs = [];
				const deps = {
					REPLICA: replica ? { off: (what) => offs.push(what) } : null,
					auth: { getClient: async () => { built.push("auth client"); return {}; } },
					google: { drive: () => { built.push("drive client"); return { files: {} }; } },
				};
				const names = Object.keys(deps);
				const getDrive = new Function(...names, `let driveClient = null;\n${extractFn("getDrive")}\nreturn getDrive;`)(...names.map((n) => deps[n]));
				return { getDrive, built, offs };
			};
			const r = lift(true);
			let err = null;
			try { await r.getDrive(); } catch (e) { err = e; }
			check("§5 a replica: getDrive() refuses (REPLICA_OUTBOUND_OFF)", !!err && err.code === "REPLICA_OUTBOUND_OFF");
			check(`§5 …before any Google client is built (${r.built.join(", ") || "none"})`, r.built.length === 0);
			check("§5 …and says Drive is off", JSON.stringify(r.offs) === JSON.stringify(["Google Drive"]));
			const control = lift(false);
			await control.getDrive();
			check("§5 control: outside a replica getDrive() builds the client", control.built.includes("drive client"));
			const bindings = [...SRC.matchAll(/\b(?:const|let|var) drive = ([^;\n]+)/g)].map((m) => m[1].trim());
			check(`§5 every Drive client in server.js comes from getDrive() (${bindings.filter((b) => b !== "await getDrive()").join(" | ") || "all do"})`,
				bindings.length >= 4 && bindings.every((b) => b === "await getDrive()"));
			check("§5 the only Google Drive client is built in getDrive()", (SRC.match(/google\.drive\(/g) || []).length === 1 && extractFn("getDrive").includes("google.drive("));
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((e) => {
	fs.rmSync(tmp, { recursive: true, force: true });
	console.error(e);
	process.exit(1);
});
