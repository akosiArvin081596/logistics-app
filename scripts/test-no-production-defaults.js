#!/usr/bin/env node
/**
 * A local run never reaches production by default: no production inbox,
 * broker AP inbox, n8n instance or workflow, or sheet is a default in
 * server.js, lib/ or scripts/. Each is a setting with no default, and a run
 * without it does less, says so, and reaches nothing.
 *
 *   §1 source: production's values (found by their SHA-256, so this file
 *      carries none of them) appear in server.js and lib/ only as email
 *      content (mailto links, contact text, the seller block printed on an
 *      invoice) and as lib/sheet-id.js's production-process sheet; nowhere
 *      as a fallback (`|| "…"`, `?? "…"`), a constant holding a recipient,
 *      instance or workflow, a sendEmail() recipient, a default parameter or
 *      an argument default. No script carries the n8n instance or workflow in
 *      code, and none defaults --sheet-id. The five admin notifications send
 *      to ADMIN_NOTIFY_EMAIL, each one guarded; the setting reads the
 *      environment only, trimmed.
 *   §2 server.js, booted (nodemailer and Google stubbed): without
 *      ADMIN_NOTIFY_EMAIL it starts and logs one [admin-notify] warning, once
 *      per start and never per request; a driver application still answers
 *      200 and mails the applicant, with no admin email; the investor RFI form
 *      answers 503 SEND_FAILED with its existing text and sends nothing.
 *      Without BISON_INVOICE_EMAIL / DEFAULT_INVOICE_EMAIL it logs one
 *      [invoice-draft] warning naming each missing one. With the settings,
 *      no warning, and the admin email and the RFI go to the named inbox.
 *   §3 each of the five admin sends, run on its own: skipped without the
 *      setting, one email to it with it.
 *   §4 invoice drafts: resolveInvoiceTo() answers "" for a missing setting,
 *      the rate-con's documents email still wins for a non-Bison broker, and a
 *      set value comes back byte for byte. POST /api/loads/:loadId/draft-invoice,
 *      lifted and run over an in-memory SQLite with every outbound effect
 *      stubbed, refuses a draft with an empty To (503
 *      INVOICE_RECIPIENT_UNCONFIGURED) before an invoice number is used or
 *      anything is rendered, drafted, recorded or audited; the ?dryRun=1
 *      preview still answers; a reviewer-typed recipient still drafts.
 *   §5 the n8n scripts: without N8N_BASE_URL or N8N_WORKFLOW_ID each exits 2
 *      with one line naming what is missing, before any network call; with
 *      both, every call goes to the named instance and workflow;
 *      verify-n8n-behaviour.js --fixture needs neither.
 *   §6 scripts/repair-job-tracking-addresses.js: --sheet-id is required (exit
 *      2 before any Google call), and production's ID is still labelled
 *      "(PRODUCTION)".
 *   §7 scripts name their target (source, scripts other than the test/check
 *      runners and fixtures): the production app's URL and production's app
 *      directory are never a fallback, a default parameter, an argument
 *      default or an environment assignment, nor a shell ${VAR:-…} default
 *      (except a variable named for production itself, replica:pull's
 *      LOGISX_PROD_APP_DIR, whose host has no default); no script carries a
 *      production Gmail message ID or the n8n Gmail credential in code.
 *   §8 each script that had such a default, run without its setting:
 *      geocode-loads.js (LOGISX_BASE_URL), replay-via-webhook-injection.js
 *      (the message ID argument and N8N_GMAIL_CREDENTIAL_ID), rescue-load.js
 *      (N8N_GMAIL_CREDENTIAL_ID, which the replay it hands over to needs) and
 *      secure-backups.sh (--app-dir / APP_DIR) exit 2 with one line naming
 *      what is missing, before any network call or command; with it, they run
 *      against what was named.
 *
 * Hermetic: every child runs in a fresh mkdtemp folder (no .env) with
 * googleapis and nodemailer replaced by recording stubs, fetch replaced by one
 * that records and refuses, and every outbound connection and DNS lookup
 * refused (loopback only, for the booted server's own listener). example.test
 * addresses and fake IDs only; a failure never prints a production value.
 *   node scripts/test-no-production-defaults.js
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
const readSource = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };
const SRC = readSource("server.js");

const ADMIN = "admin@example.test";
const BISON_TO = "bison-ap@example.test";
const DEFAULT_TO = "ap@example.test";
const SENDER = "sender@example.test";
const N8N_URL = "https://n8n.example.test";
const N8N_WF = "wf-under-test";
const TEST_SHEET = "sheet-under-test-nopd";

// ------------------------------------------------------------ production values
// Each production value by the SHA-256 of its lower-cased form (the workflow ID
// as written: n8n IDs are case-sensitive), so this file never carries one.
const PROD = [
	{ kind: "the production admin inbox", sha: "a5e715fcd75fd9bc36995eac648dc863c6ca2209556b4e7f1b4c870889eca8ea", form: "email" },
	{ kind: "the Bison AP inbox", sha: "464b6d567d9c0b17cfdef8f7c2cc7bb331e6d62280eb0d278f85493a3602e2e6", form: "email" },
	{ kind: "the default broker AP inbox", sha: "973365c0b982ce1a5fb42f03bb22749aec4d56223d29ac2398b185ff6c0c9392", form: "email" },
	{ kind: "the live n8n instance", sha: "b4b8a5f609108f05db993bc44c07445506b6e29c8ea6a53619b50b2929465ddf", form: "host" },
	{ kind: "the live n8n workflow", sha: "d29cdf5ad6f3e6e8dcc0c7c709d7e1ab245387b85d82e9a4aa5e59d0f7e6041a", form: "id16" },
];
const [INBOX, BISON_AP, DEFAULT_AP, N8N_HOST, N8N_WORKFLOW] = PROD;
// The production sheet is lib/sheet-id.js's own constant, read at run time.
const PROD_SHEET_ID = (() => {
	try { return String(require(path.join(ROOT, "lib", "sheet-id.js")).PRODUCTION_SPREADSHEET_ID || ""); } catch { return ""; }
})();
const SHEET = { kind: "the production sheet", form: "sheet" };
// What a script targets (§7, §8): the app, a Gmail message and the n8n Gmail
// credential by their SHA-256 too; production's app directory is lib/sheet-id.js's
// PRODUCTION_DIR, read at run time.
const APP_HOST = { kind: "the production app", sha: "b31e82745c41b0bcf550bfae447352961debb51712bf6483b6695c8088d38be4", form: "host" };
const GMAIL_MESSAGE = { kind: "a production Gmail message", sha: "81a05b65791d8578cec47f6121dad39d24e4295cd5ebc6d27645b47ab46ab3d3", form: "id16" };
const GMAIL_CREDENTIAL = { kind: "the n8n Gmail credential", sha: "5e3212b1c0d295cb61cede1ac5ded336c87f8cea044a89b839c3fe8e68dc87d0", form: "id16" };
const PROD_DIR = (() => {
	try { return String(require(path.join(ROOT, "lib", "sheet-id.js")).PRODUCTION_DIR || ""); } catch { return ""; }
})();
const APP_DIRECTORY = { kind: "the production app directory", form: "dir" };
const TARGETS = [APP_HOST, GMAIL_MESSAGE, GMAIL_CREDENTIAL, APP_DIRECTORY];

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const TOKEN_RE = {
	email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
	host: /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
	id16: /[A-Za-z0-9]+/g,
	sheet: /[A-Za-z0-9_-]+/g,
	dir: /\/[A-Za-z0-9_.\/-]+/g,
};
// Is `token` (one whole token of its form) the production value `p`? A path is
// production's when it is the app directory or anything under it.
function isProd(p, token) {
	if (p.form === "sheet") return !!PROD_SHEET_ID && token === PROD_SHEET_ID;
	if (p.form === "dir") return !!PROD_DIR && (token === PROD_DIR || token.startsWith(`${PROD_DIR}/`));
	if (p.form === "id16") return token.length === 16 && sha256(token) === p.sha;
	return sha256(token.toLowerCase()) === p.sha;
}
// The production values inside `text`, as [{ p, token }].
function prodIn(text) {
	const hits = [];
	for (const p of [...PROD, SHEET, ...TARGETS]) {
		for (const m of String(text).matchAll(TOKEN_RE[p.form])) if (isProd(p, m[0])) hits.push({ p, token: m[0] });
	}
	return hits;
}
// Is a literal's whole content the production value `p` (for the instance,
// also a URL on it)?
function isBare(p, content) {
	const c = String(content).trim();
	if (p.form === "host") {
		const url = c.match(/^https?:\/\/([^/\s]+)(?:\/|$)/i);
		return isProd(p, url ? url[1] : c);
	}
	return isProd(p, c);
}
// A failure never prints a production value.
const redact = (s) => prodIn(s).reduce((out, h) => out.split(h.token).join(`<${h.p.kind}>`), String(s));

// ------------------------------------------------------------------- runner
let pass = 0;
const failures = [];
function check(label, cond) {
	if (cond) { pass++; return; }
	failures.push(redact(label));
	console.log(`  FAIL  ${redact(label)}`);
}
// A section that throws is one failure, never a crash: the runner also runs
// against a tree from before the settings existed.
async function section(title, fn) {
	console.log(title);
	try { await fn(); } catch (e) { check(`${title}: threw ${e && e.message}`, false); }
}
const QUIET = { log() {}, warn() {}, error() {}, info() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the lexer
// String, template and regex literals and comments of a JS source, with
// absolute offsets. `code` is the text with every comment blanked (newlines
// kept). Literals inside a template's ${…} are listed too.
function lex(text) {
	const literals = [];
	const comments = [];
	let i = text.startsWith("#!") ? text.indexOf("\n") : 0;
	if (i < 0) i = text.length;
	const readString = (q) => {
		const s = i;
		i++;
		while (i < text.length && text[i] !== q && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
		i++;
		literals.push({ start: s, end: i, quote: q, content: text.slice(s + 1, i - 1) });
	};
	const readTemplate = () => {
		const s = i;
		i++;
		while (i < text.length && text[i] !== "`") {
			if (text[i] === "\\") { i += 2; continue; }
			if (text[i] === "$" && text[i + 1] === "{") { i += 2; readCode(true); i++; continue; }
			i++;
		}
		i++;
		literals.push({ start: s, end: i, quote: "`", content: text.slice(s + 1, i - 1) });
	};
	function readCode(inExpr) {
		let prev = "";
		let depth = 0;
		while (i < text.length) {
			const ch = text[i];
			if (inExpr && ch === "{") depth++;
			if (inExpr && ch === "}") { if (depth === 0) return; depth--; }
			if (ch === "/" && text[i + 1] === "/") {
				const e = text.indexOf("\n", i);
				const end = e === -1 ? text.length : e;
				comments.push([i, end]);
				i = end;
				continue;
			}
			if (ch === "/" && text[i + 1] === "*") {
				const e = text.indexOf("*/", i + 2);
				const end = e === -1 ? text.length : e + 2;
				comments.push([i, end]);
				i = end;
				continue;
			}
			if (ch === '"' || ch === "'") { readString(ch); prev = "a"; continue; }
			if (ch === "`") { readTemplate(); prev = "a"; continue; }
			if (ch === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
				i++;
				let inClass = false;
				while (i < text.length && (inClass || text[i] !== "/") && text[i] !== "\n") {
					if (text[i] === "\\") { i += 2; continue; }
					if (text[i] === "[") inClass = true;
					else if (text[i] === "]") inClass = false;
					i++;
				}
				i++;
				while (/[a-z]/.test(text[i] || "")) i++;
				prev = "a";
				continue;
			}
			if (/[\w$]/.test(ch)) {
				let j = i;
				while (j < text.length && /[\w$]/.test(text[j])) j++;
				prev = /^(return|typeof|case|in|of|new|delete|void|throw|else|do|yield|await)$/.test(text.slice(i, j)) ? "=" : "a";
				i = j;
				continue;
			}
			if (!/\s/.test(ch)) prev = ch === ")" || ch === "]" ? "a" : ch;
			i++;
		}
	}
	readCode(false);
	const chars = text.split("");
	for (const [a, b] of comments) for (let k = a; k < b; k++) if (chars[k] !== "\n") chars[k] = " ";
	return { literals, code: chars.join("") };
}
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

// The code before a literal, comments blanked and whitespace collapsed.
const before = (code, at) => code.slice(Math.max(0, at - 160), at).replace(/\s+/g, " ");
const SHAPES = {
	fallback: /(\|\||\?\?)\s*$/,
	constant: /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*$/,
	"default parameter": /[({,]\s*[A-Za-z_$][\w$]*\s*=\s*$/,
	recipient: /(\bsendEmail\(\s*$|\bto\s*(?::|===?|!==?|=)\s*$)/,
	"environment assignment": /process\.env\.[A-Z0-9_]+\s*=\s*$/,
	"argument default": /\barg\(\s*["'][\w-]+["']\s*,\s*$/,
};

// ------------------------------------------------------------- files to scan
function walk(dir, out) {
	let entries = [];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		if (e.name === "node_modules" || e.name.startsWith(".") || e.isSymbolicLink()) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else out.push(path.relative(ROOT, p));
	}
	return out;
}
const JS_RE = /\.(?:js|mjs|cjs)$/;
const APP_FILES = ["server.js", ...walk(path.join(ROOT, "lib"), []).filter((f) => JS_RE.test(f))];
const SCRIPT_FILES = walk(path.join(ROOT, "scripts"), []);
const SCRIPT_JS = SCRIPT_FILES.filter((f) => JS_RE.test(f));
const SCRIPT_SH = SCRIPT_FILES.filter((f) => /\.sh$/.test(f));

// ------------------------------------------------------- stubs for children
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-nopd-"));
const log = path.join(tmp, "calls.log");
const stub = path.join(tmp, "no-network.js");
fs.writeFileSync(stub, `"use strict";
const Module = require("module");
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const rows = [["Load ID", "Driver", "Job Status", "Truck", "Owner ID"]];
const op = (name) => async (params) => { note("google sheets " + name); return { data: { values: rows, sheets: [] } }; };
const driveOp = (name) => async () => { note("google drive " + name); return { data: { files: [] } }; };
const google = {
	options() {},
	auth: { GoogleAuth: class { constructor() { note("google auth"); } async getClient() { return {}; } } },
	sheets: () => ({ spreadsheets: { get: op("get"), batchUpdate: op("batchUpdate"), values: {
		get: op("values.get"), batchGet: op("values.batchGet"), update: op("values.update"),
		batchUpdate: op("values.batchUpdate"), append: op("values.append"), clear: op("values.clear") } } }),
	drive: () => ({ files: { list: driveOp("files.list"), get: driveOp("files.get"), create: driveOp("files.create") } }),
};
const nodemailer = {
	createTransport: () => ({ sendMail: async (m) => { note("mail " + JSON.stringify({ to: m.to, subject: m.subject })); return { messageId: "stub" }; } }),
};
const real = Module._load;
Module._load = function (request, ...rest) {
	if (request === "googleapis") return { google };
	if (request === "nodemailer") return nodemailer;
	return real.call(this, request, ...rest);
};
globalThis.fetch = async (url) => { note("network fetch " + String(url)); throw new Error("test: no network (fetch)"); };
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
const callLines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const mails = () => callLines().filter((l) => l.startsWith("mail ")).map((l) => JSON.parse(l.slice(5)));
const network = () => callLines().filter((l) => /^(network|google)/.test(l));
const childEnv = (cwd, env) => ({ PATH: process.env.PATH, HOME: cwd, TMPDIR: cwd, NODE_OPTIONS: `--require ${JSON.stringify(stub)}`, ...env });

// ------------------------------------------------------------- §2 helpers
function freePort() {
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.on("error", reject);
		s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
	});
}
async function bootServer(extra) {
	const cwd = fs.mkdtempSync(path.join(tmp, "srv-"));
	fs.rmSync(log, { force: true });
	const port = await freePort();
	const env = childEnv(cwd, {
		PORT: String(port), BIND_HOST: "127.0.0.1", NODE_ENV: "development", SESSION_SECRET: "s".repeat(48),
		SPREADSHEET_ID: TEST_SHEET, DATABASE_PATH: path.join(cwd, "app.db"),
		GMAIL_USER: SENDER, GMAIL_APP_PASSWORD: "app-password-under-test", ...extra,
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
async function post(port, url, body, headers = {}) {
	const res = await fetch(`http://127.0.0.1:${port}${url}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", ...headers },
		body: JSON.stringify(body),
		redirect: "manual",
	});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch { json = null; }
	return { status: res.status, json };
}
// Mail is sent after the response: wait for `want` lines, or give up.
async function mailsAfter(want, ms = 3000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline && !want(mails())) await delay(50);
	return mails();
}
const count = (text, re) => (String(text).match(new RegExp(re.source, "g")) || []).length;
const ADMIN_WARNING = /\[admin-notify\][^\n]*ADMIN_NOTIFY_EMAIL is not set/;
const DRAFT_WARNING = /\[invoice-draft\][^\n]*/;
const APPLY = Object.freeze({
	full_name: "Nopd Applicant", email: "applicant@example.test", phone: "(555) 010-0100", dob: "1990-01-01",
	address: "1 Test Way", ssn: "123-45-6789", drivers_license: "D1234567", position: "Company Driver", experience: "5",
	has_cdl: "Yes", work_authorized: "Yes", felony_convicted: "No", accident_history: "No", signature: "Nopd Applicant", skills: "",
});
const RFI = Object.freeze({ fullName: "Nopd Investor", email: "investor@example.test", consent: true });
const RFI_ORIGIN = "https://logisx.com";
const SEND_FAILED_TEXT = (readSource("lib/investor-rfi.js").match(/send_failed: "([^"]+)"/) || [])[1] || "";

// ------------------------------------------------------------- §4 helpers
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));
const INVOICE_ENV = ["BISON_INVOICE_EMAIL", "DEFAULT_INVOICE_EMAIL"];
function withInvoiceEnv(values, fn) {
	const saved = Object.fromEntries(INVOICE_ENV.map((k) => [k, process.env[k]]));
	for (const k of INVOICE_ENV) {
		if (values[k] === undefined) delete process.env[k];
		else process.env[k] = values[k];
	}
	const restore = () => {
		for (const k of INVOICE_ENV) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	};
	let out;
	try { out = fn(); } catch (e) { restore(); throw e; }
	if (out && typeof out.then === "function") return out.finally(restore);
	restore();
	return out;
}
const DRAFT_NEEDLE = '["/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice"],';
const DRAFT_SHEET = [
	["Load ID", "Status", "Email", "Broker Contact Name", "Driver", "Trailer", "Delivery Date", "  Payment  "],
	["563367203", "Delivered", "dispatch@acme-freight.example.test", "Jane Agent", "Driver A", "", "09/28/2026", "3000"],
	["30080873", "Delivered", "agent@bisontransport.com", "Bob Agent", "Driver B", "", "09/27/2026", "2500"],
];
function liftDraftRoute(src) {
	const lines = src.split("\n");
	const hits = lines.filter((l) => l.includes(DRAFT_NEEDLE)).length;
	if (hits !== 1) throw new Error(`expected 1 draft-invoice registration, found ${hits}`);
	let s = lines.findIndex((l) => l.includes(DRAFT_NEEDLE));
	while (s > 0 && !/^app\.post\(/.test(lines[s])) s--;
	let e = s;
	while (e < lines.length && lines[e] !== ");") e++;
	const route = lines.slice(s, e + 1).join("\n");
	const createAt = src.indexOf("CREATE TABLE IF NOT EXISTS load_invoice_drafts (");
	if (createAt < 0) throw new Error("no CREATE TABLE for load_invoice_drafts");
	const { closure } = require(path.join(ROOT, "scripts", "lib", "server-lift.js"));
	const helpers = closure(src, {
		roots: ["parseInvoiceOverrides", "parseSheet", "deduplicateLoads", "findCol", "latestDraftNotes", "invoiceIdAlreadyUsed", "safeAttachmentName", "mdyToIso", "sanitizeEvidenceText"],
		provided: ["db", "brokerInvoice", "console"],
		denied: ["app", "server", "io", "getSheets", "getDrive"],
	});
	return {
		route,
		helpers,
		createSql: src.slice(createAt, src.indexOf("`", createAt)),
		alters: [...src.matchAll(/db\.exec\("(ALTER TABLE load_invoice_drafts ADD COLUMN [^"]+)"\)/g)].map((m) => m[1]),
	};
}
// The route over a fresh in-memory database. Sheets, Drive, Gemini, Chromium,
// Gmail and n8n are stubs that record what they are handed.
function draftHarness(L) {
	const Database = require("better-sqlite3");
	const db = new Database(":memory:");
	db.exec(L.createSql);
	for (const a of L.alters) db.exec(a);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT, type TEXT, file_name TEXT, uploaded_at TEXT, deleted_at TEXT)");
	const addPod = db.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES (?, 'POD', ?, '2026-09-28T15:00:00Z')");
	for (const row of DRAFT_SHEET.slice(1)) addPod.run(row[0], `${row[0]}_POD.pdf`);
	const seen = { minted: 0, renders: 0, drafts: [], posts: [], audits: [] };
	const h = L.helpers;
	const helpers = new Function("db", "brokerInvoice", "console", `${h.text}\nreturn { ${h.names.join(", ")} };`)(db, brokerInvoice, QUIET);
	const scope = {
		...helpers,
		requireRole: () => () => {},
		refuseCrossSite: () => {},
		draftInvoiceLimiter: () => {},
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: DRAFT_SHEET } }) } } }),
		SPREADSHEET_ID: TEST_SHEET,
		brokerInvoice,
		db,
		fetchDocumentBytes: async () => Buffer.from("%PDF-1.4 pod"),
		buildRateConLoadCtx: () => ({}),
		getRateConBytes: async () => ({ buffer: null, candidates: [] }),
		GEMINI_API_KEY: "",
		runRateConGemini: async () => null,
		peekInvoiceNumber: () => "10092026-1",
		nextInvoiceNumber: () => { seen.minted++; return "10092026-1"; },
		renderHtmlToPdf: async () => { seen.renders++; return Buffer.from("%PDF-1.4 invoice"); },
		logAudit: (req, action) => seen.audits.push(action),
		appendGmailDraft: async (msg) => { seen.drafts.push(msg); },
		sentIfRendererBusy: () => false,
		REPLICA: null,
		process: { env: { GMAIL_USER: SENDER, GMAIL_APP_PASSWORD: "app-password-under-test" } },
		fetch: async (url) => { seen.posts.push(String(url)); throw new Error("test: no network"); },
		console: QUIET,
	};
	const registered = [];
	new Function("app", ...Object.keys(scope), L.route)({ post: (...args) => registered.push(args) }, ...Object.values(scope));
	if (registered.length !== 1) throw new Error(`expected 1 registration, got ${registered.length}`);
	const handler = registered[0][registered[0].length - 1];
	const call = async (loadId, { query = {}, body = {} } = {}) => {
		let out = { status: 0, body: null };
		const req = { params: { loadId }, query, body, session: { user: { id: 1, username: "super_admin", role: "Super Admin" } }, ip: "127.0.0.1" };
		const res = {
			statusCode: 200,
			headersSent: false,
			status(c) { this.statusCode = c; return this; },
			json(b) { out = { status: this.statusCode, body: b }; this.headersSent = true; return this; },
		};
		await handler(req, res);
		return out;
	};
	const records = () => db.prepare("SELECT COUNT(*) AS n FROM load_invoice_drafts").get().n;
	return { seen, call, records };
}

// ------------------------------------------------------------- §3 helpers
// The end of the call that opens at `open` (a "("), skipping literals.
function closeParen(text, open, literals) {
	const inside = new Map(literals.map((l) => [l.start, l.end]));
	let depth = 0;
	for (let k = open; k < text.length; k++) {
		if (inside.has(k)) { k = inside.get(k) - 1; continue; }
		if (text[k] === "(") depth++;
		else if (text[k] === ")") { depth--; if (depth === 0) return k; }
	}
	return -1;
}
// Every sendEmail(…) call in server.js: its statement text, its first
// argument, and what stands before it on its line.
function sendEmailCalls(src) {
	const { literals, code } = lex(src);
	const out = [];
	for (const m of code.matchAll(/\bsendEmail\(/g)) {
		const open = m.index + "sendEmail".length;
		if (/function\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;
		const close = closeParen(src, open, literals);
		if (close < 0) continue;
		const args = src.slice(open + 1, close);
		const first = args.slice(0, (() => {
			let depth = 0;
			for (let k = 0; k < args.length; k++) {
				if ("([{".includes(args[k])) depth++;
				else if (")]}".includes(args[k])) depth--;
				else if (args[k] === "," && depth === 0) return k;
			}
			return args.length;
		})()).trim();
		const lineStart = src.lastIndexOf("\n", m.index) + 1;
		out.push({ at: m.index, first, lead: src.slice(lineStart, m.index).trim(), statement: src.slice(lineStart, close + 2).trim() });
	}
	return out;
}
// One statement run with every free name stubbed: `values` by name, sendEmail
// recorded, anything else a function that reads as its own name.
function runStatement(statement, values) {
	const sent = [];
	const stubFor = (k) => { const f = () => String(k); f.toString = () => String(k); return f; };
	const scope = new Proxy({}, {
		has: () => true,
		get: (_, k) => {
			if (k === Symbol.unscopables) return undefined;
			if (k === "sendEmail") return (...a) => { sent.push(a); return Promise.resolve(true); };
			if (k === "failedDocs") return [];
			if (Object.prototype.hasOwnProperty.call(values, k)) return values[k];
			return stubFor(k);
		},
	});
	new Function("scope", `with (scope) { ${statement} }`)(scope);
	return sent;
}

// ------------------------------------------------------------- §5 helpers
const N8N_CREDENTIAL = { N8N_GMAIL_CREDENTIAL_ID: "gmail-credential-under-test" };
const MESSAGE_ID = "message-under-test";
// [script, its arguments, the other settings it needs (§8 runs without them)]
const N8N_SCRIPTS = [
	["patch-agent-guard.js", [], {}],
	["patch-awaiting-ratecon.js", [], {}],
	["patch-completeness-gate.js", [], {}],
	["patch-mark-read.js", [], {}],
	["patch-protect-dispatch-fields.js", [], {}],
	["stage-n8n-details-fix.js", [], {}],
	["rescue-load.js", ["123456"], N8N_CREDENTIAL],
	["replay-via-webhook-injection.js", [MESSAGE_ID], N8N_CREDENTIAL],
	["verify-n8n-behaviour.js", [], {}],
];
function runScript(rel, args, env) {
	const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
	fs.rmSync(log, { force: true });
	const r = spawnSync(process.execPath, [path.join(ROOT, rel), ...args], { cwd, env: childEnv(cwd, env), encoding: "utf8", timeout: 20_000 });
	return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: `${r.stdout || ""}${r.stderr || ""}`, calls: callLines() };
}

// ------------------------------------------------------------- §8 helpers
// A shell script under bash. With `stubbed`, every command it could read or
// change files or reach the network with is a stub on PATH that only records
// its name, so "nothing ran" is observable.
const STUB_BIN = path.join(tmp, "stub-bin");
fs.mkdirSync(STUB_BIN);
for (const cmd of ["chmod", "chown", "mv", "cp", "rm", "mkdir", "install", "find", "stat", "ls", "numfmt", "ssh", "scp", "rsync", "curl", "wget"]) {
	fs.writeFileSync(path.join(STUB_BIN, cmd), `#!/bin/sh\necho "command ${cmd}" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
}
function runShell(rel, args, env, { stubbed = true } = {}) {
	const cwd = fs.mkdtempSync(path.join(tmp, "sh-"));
	fs.rmSync(log, { force: true });
	const PATH = stubbed ? `${STUB_BIN}${path.delimiter}${process.env.PATH}` : process.env.PATH;
	const r = spawnSync("bash", [path.join(ROOT, rel), ...args], { cwd, env: { PATH, HOME: cwd, TMPDIR: cwd, ...env }, encoding: "utf8", timeout: 20_000 });
	return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: `${r.stdout || ""}${r.stderr || ""}`, calls: callLines() };
}
const isRunner = (f) => /^(test|check)-/.test(path.basename(f)) || f.split(path.sep).some((s) => s === "fixtures" || s === "artifacts");

(async () => {
	try {
		await section("§1 source", () => {
			check(`§1 production's sheet ID is readable from lib/sheet-id.js (${PROD_SHEET_ID ? "yes" : "no"})`, !!PROD_SHEET_ID);
			const files = [...APP_FILES, ...SCRIPT_JS];
			const lexed = new Map(files.map((f) => {
				const text = readSource(f);
				let l = { literals: [], code: text };
				try { l = lex(text); } catch { l = { literals: [], code: text }; }
				return [f, { text, ...l }];
			}));
			const hitsIn = (f) => {
				const { text, literals, code } = lexed.get(f);
				const out = [];
				for (const lit of literals) {
					for (const h of prodIn(lit.content)) {
						out.push({ f, line: lineOf(text, lit.start), p: h.p, bare: isBare(h.p, lit.content), before: before(code, lit.start) });
					}
				}
				return out;
			};
			const where = (list) => [...new Set(list.map((x) => `${x.f}:${x.line}`))].join(", ") || "none";
			const appHits = APP_FILES.flatMap(hitsIn);
			const scriptHits = SCRIPT_JS.flatMap(hitsIn);

			// server.js and lib/: the inbox only as email content, or as the seller
			// block lib/broker-invoice.js prints on an invoice.
			const inboxBare = appHits.filter((x) => x.p === INBOX && x.bare && !(x.f === path.join("lib", "broker-invoice.js") && /\bemail\s*:\s*$/.test(x.before)));
			check(`§1 server.js and lib/: no bare literal of the production admin inbox, only email content (${where(inboxBare)})`, inboxBare.length === 0);
			for (const p of [BISON_AP, DEFAULT_AP, N8N_HOST, N8N_WORKFLOW]) {
				const any = appHits.filter((x) => x.p === p);
				check(`§1 server.js and lib/: ${p.kind} is in no code at all (${where(any)})`, any.length === 0);
			}
			const sheetInApp = appHits.filter((x) => x.p === SHEET && !(x.f === path.join("lib", "sheet-id.js") && /\bconst PRODUCTION_SPREADSHEET_ID\s*=\s*$/.test(x.before)));
			check(`§1 server.js and lib/: the production sheet only as lib/sheet-id.js's PRODUCTION_SPREADSHEET_ID (${where(sheetInApp)})`, sheetInApp.length === 0);

			// Everywhere: no production value as a default or a recipient. A
			// script's constant naming the production sheet is a refusal list and
			// stays allowed.
			const all = [...appHits, ...scriptHits].filter((x) => x.bare);
			for (const p of [...PROD, SHEET]) {
				for (const [shape, re] of Object.entries(SHAPES)) {
					if (p === SHEET && shape === "constant") continue;
					const bad = all.filter((x) => x.p === p && re.test(x.before));
					check(`§1 ${p.kind} is never a ${shape} in server.js, lib/ or scripts/ (${where(bad)})`, bad.length === 0);
				}
			}

			// No script carries the n8n instance or workflow in code.
			for (const p of [N8N_HOST, N8N_WORKFLOW]) {
				const inScripts = scriptHits.filter((x) => x.p === p);
				check(`§1 scripts/: ${p.kind} is in no code, only in comments (${where(inScripts)})`, inScripts.length === 0);
			}
			const shellBad = [];
			for (const f of SCRIPT_SH) {
				readSource(f).split("\n").forEach((line, n) => {
					const codePart = line.replace(/(^|\s)#.*$/, "");
					const hs = prodIn(codePart).filter((h) => !TARGETS.includes(h.p));
					if (hs.some((h) => h.p === N8N_HOST || h.p === N8N_WORKFLOW)) shellBad.push(`${f}:${n + 1}`);
					if (hs.length && /\$\{[A-Za-z_][\w]*:?[-=]/.test(codePart) && hs.some((h) => new RegExp(`:?[-=]${h.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(codePart))) shellBad.push(`${f}:${n + 1}`);
				});
			}
			check(`§1 scripts/*.sh: no n8n instance or workflow in code, no production value as a \${VAR:-…} default (${[...new Set(shellBad)].join(", ") || "none"})`, shellBad.length === 0);

			// The sheet by name: no --sheet-id default and no fallback to the
			// production constant.
			const argDefault = [];
			const prodFallback = [];
			for (const f of [...APP_FILES, ...SCRIPT_JS]) {
				const { text, code } = lexed.get(f);
				for (const m of code.matchAll(/\barg\(\s*["']sheet-id["']\s*,\s*([^)]*)\)/g)) {
					if (!/^(""|''|undefined)$/.test(m[1].trim())) argDefault.push(`${f}:${lineOf(text, m.index)}`);
				}
				for (const m of code.matchAll(/(\|\||\?\?)\s*(?:[\w$]+\.)*PRODUCTION_(?:SPREADSHEET|SHEET)_ID\b/g)) prodFallback.push(`${f}:${lineOf(text, m.index)}`);
			}
			check(`§1 no script defaults --sheet-id (${argDefault.join(", ") || "none"})`, argDefault.length === 0);
			check(`§1 nothing falls back to the production sheet constant (${prodFallback.join(", ") || "none"})`, prodFallback.length === 0);

			// The five admin notifications, each guarded on the setting.
			const calls = sendEmailCalls(SRC);
			const literalTo = calls.filter((c) => /^["'`]/.test(c.first));
			check(`§1 no sendEmail() in server.js has a literal recipient (${literalTo.map((c) => `server.js:${lineOf(SRC, c.at)}`).join(", ") || "none"})`, literalTo.length === 0);
			const admin = calls.filter((c) => c.first === "ADMIN_NOTIFY_EMAIL");
			check(`§1 five admin notifications send to ADMIN_NOTIFY_EMAIL (found ${admin.length})`, admin.length === 5);
			const unguarded = admin.filter((c) => c.lead !== "if (ADMIN_NOTIFY_EMAIL)");
			check(`§1 …each one guarded by if (ADMIN_NOTIFY_EMAIL) (${admin.length ? unguarded.map((c) => `server.js:${lineOf(SRC, c.at)}`).join(", ") || "all are" : "none found"})`,
				admin.length > 0 && unguarded.length === 0);
			const alerts = calls.filter((c) => /GMAIL_USER/.test(c.first) || c.first === "adminEmail");
			check(`§1 the operational alerts still go to GMAIL_USER (${alerts.length} sends)`, alerts.length >= 4);

			// The settings read the environment only.
			const def = SRC.match(/\nconst ADMIN_NOTIFY_EMAIL = ([^;]+);/);
			check("§1 server.js declares ADMIN_NOTIFY_EMAIL once", !!def && SRC.split("\nconst ADMIN_NOTIFY_EMAIL = ").length === 2);
			if (def) {
				const value = (env) => { try { return new Function("process", `return ${def[1]};`)({ env }); } catch (e) { return `threw ${e.message}`; } };
				check("§1 ADMIN_NOTIFY_EMAIL unset: empty", value({}) === "");
				check("§1 ADMIN_NOTIFY_EMAIL blank: empty", value({ ADMIN_NOTIFY_EMAIL: "  \t" }) === "");
				check("§1 ADMIN_NOTIFY_EMAIL set: the value, trimmed", value({ ADMIN_NOTIFY_EMAIL: ` ${ADMIN}\n` }) === ADMIN);
			}
			const exported = Object.keys(brokerInvoice).filter((k) => /^(BISON|DEFAULT)_INVOICE_EMAIL$/.test(k));
			check(`§1 lib/broker-invoice.js exports no AP inbox value (${exported.join(", ") || "none"})`, exported.length === 0);
			check("§1 server.js passes ADMIN_NOTIFY_EMAIL to the investor RFI middleware",
				SRC.includes("investorRfi.createInvestorRfiMiddleware({ sendEmail, to: ADMIN_NOTIFY_EMAIL })"));
		});

		await section("§2 server.js, booted", async () => {
			const s = await bootServer({});
			try {
				check("§2 no settings: the server starts", s.up);
				check(`§2 no settings: one [admin-notify] warning at start (got ${count(s.output(), ADMIN_WARNING)})`, count(s.output(), ADMIN_WARNING) === 1);
				const draftWarn = s.output().match(DRAFT_WARNING);
				check("§2 no settings: one [invoice-draft] warning naming both AP settings",
					count(s.output(), DRAFT_WARNING) === 1 && !!draftWarn && /BISON_INVOICE_EMAIL/.test(draftWarn[0]) && /DEFAULT_INVOICE_EMAIL/.test(draftWarn[0]));
				const a = s.up ? await post(s.port, "/api/public/apply", APPLY) : { status: 0, json: null };
				check(`§2 no ADMIN_NOTIFY_EMAIL: a driver application still answers 200 { success, id } (got ${a.status})`,
					a.status === 200 && a.json && a.json.success === true && Number.isInteger(Number(a.json.id)));
				const m1 = await mailsAfter((ms) => ms.some((x) => x.to === APPLY.email));
				check("§2 …the applicant is still mailed", m1.some((x) => x.to === APPLY.email));
				await delay(300);
				const adminMail = mails().filter((x) => /^New Driver Application/.test(x.subject || ""));
				check(`§2 …and no admin email is sent (${adminMail.map((x) => x.to).join(", ") || "none"})`, adminMail.length === 0);
				const r = s.up ? await post(s.port, "/api/public/investor-rfi", RFI, { Origin: RFI_ORIGIN }) : { status: 0, json: null };
				check(`§2 no ADMIN_NOTIFY_EMAIL: the investor RFI answers 503 SEND_FAILED with its existing text (got ${r.status} ${r.json && r.json.code})`,
					r.status === 503 && r.json && r.json.code === "SEND_FAILED" && !!SEND_FAILED_TEXT && r.json.error === SEND_FAILED_TEXT);
				await delay(300);
				const rfiMail = mails().filter((x) => /Investor RFI/.test(x.subject || ""));
				check(`§2 …and sends nothing (${rfiMail.map((x) => x.to).join(", ") || "none"})`, rfiMail.length === 0);
				check(`§2 still one [admin-notify] warning after the requests: once per start, never per request (got ${count(s.output(), ADMIN_WARNING)})`, count(s.output(), ADMIN_WARNING) === 1);
				check(`§2 no connection and no Google call beyond the stubbed sheet reads (${network().filter((l) => !/^google (sheets|auth)/.test(l)).join("; ") || "none"})`,
					network().filter((l) => !/^google (sheets|auth)/.test(l)).length === 0);
			} finally {
				await s.stop();
			}

			const b = await bootServer({ ADMIN_NOTIFY_EMAIL: ADMIN, BISON_INVOICE_EMAIL: BISON_TO, DEFAULT_INVOICE_EMAIL: DEFAULT_TO });
			try {
				check("§2 all settings: the server starts", b.up);
				check("§2 all settings: no [admin-notify] and no [invoice-draft] warning", b.up && !ADMIN_WARNING.test(b.output()) && !DRAFT_WARNING.test(b.output()));
				const a = b.up ? await post(b.port, "/api/public/apply", APPLY) : { status: 0, json: null };
				check(`§2 all settings: a driver application answers 200 (got ${a.status})`, a.status === 200 && a.json && a.json.success === true);
				const ms = await mailsAfter((list) => list.some((x) => /^New Driver Application/.test(x.subject || "")) && list.some((x) => x.to === APPLY.email));
				const adminMail = ms.filter((x) => /^New Driver Application/.test(x.subject || ""));
				check(`§2 …the applicant is mailed, and one admin email goes to ADMIN_NOTIFY_EMAIL (${adminMail.map((x) => x.to).join(", ") || "none"})`,
					ms.some((x) => x.to === APPLY.email) && adminMail.length === 1 && adminMail[0].to === ADMIN);
				const r = b.up ? await post(b.port, "/api/public/investor-rfi", RFI, { Origin: RFI_ORIGIN }) : { status: 0, json: null };
				check(`§2 all settings: the investor RFI answers 200 { ok: true } (got ${r.status})`, r.status === 200 && r.json && r.json.ok === true);
				const rfiMail = (await mailsAfter((list) => list.some((x) => /Investor RFI/.test(x.subject || "")))).filter((x) => /Investor RFI/.test(x.subject || ""));
				check(`§2 …one email, to ADMIN_NOTIFY_EMAIL (${rfiMail.map((x) => x.to).join(", ") || "none"})`, rfiMail.length === 1 && rfiMail[0].to === ADMIN);
				check(`§2 all settings: no connection (${network().filter((l) => /^network/.test(l)).join("; ") || "none"})`, !network().some((l) => /^network/.test(l)));
			} finally {
				await b.stop();
			}

			const c = await bootServer({ ADMIN_NOTIFY_EMAIL: "   ", DEFAULT_INVOICE_EMAIL: DEFAULT_TO });
			try {
				check("§2 a blank ADMIN_NOTIFY_EMAIL, only DEFAULT_INVOICE_EMAIL: the server starts", c.up);
				check(`§2 …a blank ADMIN_NOTIFY_EMAIL counts as unset: one [admin-notify] warning (got ${count(c.output(), ADMIN_WARNING)})`, count(c.output(), ADMIN_WARNING) === 1);
				const w = (c.output().match(DRAFT_WARNING) || [""])[0];
				check("§2 …one [invoice-draft] warning, naming BISON_INVOICE_EMAIL only",
					count(c.output(), DRAFT_WARNING) === 1 && /BISON_INVOICE_EMAIL/.test(w) && !/DEFAULT_INVOICE_EMAIL/.test(w));
			} finally {
				await c.stop();
			}
		});

		await section("§3 the five admin sends, each run on its own", () => {
			const admin = sendEmailCalls(SRC).filter((c) => c.first === "ADMIN_NOTIFY_EMAIL");
			check(`§3 the five sends are found (got ${admin.length})`, admin.length === 5);
			for (const c of admin) {
				const label = (c.statement.match(/`([^`$]*)/) || [, `server.js:${lineOf(SRC, c.at)}`])[1].trim() || `server.js:${lineOf(SRC, c.at)}`;
				const skipped = runStatement(c.statement, { ADMIN_NOTIFY_EMAIL: "" });
				check(`§3 "${label}": without the setting, nothing is sent (${skipped.length})`, skipped.length === 0);
				const sent = runStatement(c.statement, { ADMIN_NOTIFY_EMAIL: ADMIN });
				check(`§3 "${label}": with it, one email to it (${sent.map((a) => a[0]).join(", ") || "none"})`, sent.length === 1 && sent[0][0] === ADMIN);
			}
		});

		await section("§4 invoice drafts", async () => {
			const R = (ctx, env) => withInvoiceEnv(env, () => brokerInvoice.resolveInvoiceTo(ctx));
			const bisonCtx = { brokerEmail: "agent@bisontransport.com" };
			const otherCtx = { brokerEmail: "dispatch@acme-freight.example.test", brokerContactName: "Jane Agent" };
			check("§4 resolveInvoiceTo, unset: a Bison load's To is empty", R(bisonCtx, {}).email === "");
			check("§4 resolveInvoiceTo, unset: another broker's To is empty", R(otherCtx, {}).email === "");
			check("§4 resolveInvoiceTo, unset: the rate-con's documents email still wins for another broker",
				R({ ...otherCtx, documentsEmail: "billing@acme-freight.example.test" }, {}).email === "billing@acme-freight.example.test");
			check("§4 resolveInvoiceTo, set: a Bison load never takes the rate-con's address",
				R({ ...bisonCtx, documentsEmail: "billing@acme-freight.example.test" }, { BISON_INVOICE_EMAIL: BISON_TO, DEFAULT_INVOICE_EMAIL: DEFAULT_TO }).email === BISON_TO);
			const MIXED_BISON = "Bison-AP.Team@Example.test";
			const MIXED_DEFAULT = "QuickPay@Example.test";
			const both = { BISON_INVOICE_EMAIL: MIXED_BISON, DEFAULT_INVOICE_EMAIL: MIXED_DEFAULT };
			const b = R(bisonCtx, both);
			const o = R(otherCtx, both);
			check(`§4 resolveInvoiceTo, set: the values come back byte for byte, case kept (${b.email}, ${o.email})`,
				b.email === MIXED_BISON && b.name === "Bison Transport" && o.email === MIXED_DEFAULT);
			check("§4 resolveInvoiceTo: a setting that is not an email address counts as unset",
				R(otherCtx, { DEFAULT_INVOICE_EMAIL: "not-an-address" }).email === "");
			const missing = typeof brokerInvoice.missingInvoiceToSettings === "function"
				? (env) => brokerInvoice.missingInvoiceToSettings(env).join(",")
				: () => "no missingInvoiceToSettings()";
			check("§4 missingInvoiceToSettings(): both, one, none",
				missing({}) === "BISON_INVOICE_EMAIL,DEFAULT_INVOICE_EMAIL" && missing({ BISON_INVOICE_EMAIL: BISON_TO }) === "DEFAULT_INVOICE_EMAIL" &&
				missing({ BISON_INVOICE_EMAIL: BISON_TO, DEFAULT_INVOICE_EMAIL: DEFAULT_TO }) === "");

			const L = liftDraftRoute(SRC);
			const nothingMade = (h) => h.seen.minted === 0 && h.seen.renders === 0 && h.seen.drafts.length === 0 &&
				h.seen.posts.length === 0 && h.seen.audits.length === 0 && h.records() === 0;
			await withInvoiceEnv({}, async () => {
				const h = draftHarness(L);
				const r = await h.call("563367203");
				check(`§4 unset, another broker: the draft is refused 503 INVOICE_RECIPIENT_UNCONFIGURED, naming DEFAULT_INVOICE_EMAIL (got ${r.status} ${r.body && r.body.code})`,
					r.status === 503 && r.body && r.body.code === "INVOICE_RECIPIENT_UNCONFIGURED" && /DEFAULT_INVOICE_EMAIL/.test(r.body.error || ""));
				check(`§4 …no invoice number used, nothing rendered, drafted, recorded or audited (minted ${h.seen.minted}, drafts ${h.seen.drafts.map((d) => d.to).join(", ") || "none"})`, nothingMade(h));
				const hb = draftHarness(L);
				const rb = await hb.call("30080873", { body: { orderNumber: "7007280", poNumber: "4471" } });
				check(`§4 unset, a Bison load: refused 503, naming BISON_INVOICE_EMAIL (got ${rb.status} ${rb.body && rb.body.code})`,
					rb.status === 503 && rb.body && rb.body.code === "INVOICE_RECIPIENT_UNCONFIGURED" && /BISON_INVOICE_EMAIL/.test(rb.body.error || ""));
				check("§4 …and nothing made", nothingMade(hb));
				const hd = draftHarness(L);
				const rd = await hd.call("563367203", { query: { dryRun: "1" } });
				check(`§4 unset: the ?dryRun=1 preview still answers 200, with an empty recipient (got ${rd.status} ${JSON.stringify(rd.body && rd.body.to)})`,
					rd.status === 200 && rd.body && rd.body.dryRun === true && rd.body.to === "");
				check("§4 …and uses no invoice number", hd.seen.minted === 0 && hd.seen.drafts.length === 0);
				const ht = draftHarness(L);
				const rt = await ht.call("563367203", { body: { recipientEmail: "billing@acme-freight.example.test" } });
				check(`§4 unset: a recipient the reviewer typed still drafts (got ${rt.status}, ${ht.seen.drafts.map((d) => d.to).join(", ") || "no draft"})`,
					rt.status === 200 && ht.seen.drafts.length === 1 && ht.seen.drafts[0].to === "billing@acme-freight.example.test");
			});
			await withInvoiceEnv({ BISON_INVOICE_EMAIL: BISON_TO }, async () => {
				const h = draftHarness(L);
				const r = await h.call("563367203");
				check(`§4 only BISON_INVOICE_EMAIL set, another broker: refused 503 (got ${r.status})`, r.status === 503 && nothingMade(h));
			});
			await withInvoiceEnv({ BISON_INVOICE_EMAIL: BISON_TO, DEFAULT_INVOICE_EMAIL: DEFAULT_TO }, async () => {
				const h = draftHarness(L);
				const r = await h.call("563367203");
				check(`§4 set, another broker: one draft, to DEFAULT_INVOICE_EMAIL (got ${r.status}, ${h.seen.drafts.map((d) => d.to).join(", ") || "no draft"})`,
					r.status === 200 && h.seen.drafts.length === 1 && h.seen.drafts[0].to === DEFAULT_TO && h.seen.minted === 1);
				const hb = draftHarness(L);
				const rb = await hb.call("30080873", { body: { orderNumber: "7007280", poNumber: "4471" } });
				check(`§4 set, a Bison load: one draft, to BISON_INVOICE_EMAIL (got ${rb.status}, ${hb.seen.drafts.map((d) => d.to).join(", ") || "no draft"})`,
					rb.status === 200 && hb.seen.drafts.length === 1 && hb.seen.drafts[0].to === BISON_TO);
			});
		});

		await section("§5 the n8n scripts", () => {
			const KEY = { N8N_API_KEY: "n8n-key-under-test" };
			for (const [name, args, needs] of N8N_SCRIPTS) {
				const rel = path.join("scripts", name);
				const cases = [
					["neither setting", {}, ["N8N_BASE_URL", "N8N_WORKFLOW_ID"]],
					["no N8N_WORKFLOW_ID", { N8N_BASE_URL: N8N_URL }, ["N8N_WORKFLOW_ID"]],
					["no N8N_BASE_URL", { N8N_WORKFLOW_ID: N8N_WF }, ["N8N_BASE_URL"]],
				];
				for (const [label, env, names] of cases) {
					const r = runScript(rel, args, { ...KEY, ...needs, ...env });
					const lines = r.stderr.split("\n").filter((l) => l.trim());
					check(`§5 ${name}, ${label}: exit 2 (got ${r.code})`, r.code === 2);
					check(`§5 ${name}, ${label}: one line, naming ${names.join(" and ")} (${redact(lines.join(" | ")).slice(0, 160)})`,
						lines.length === 1 && names.every((n) => lines[0].includes(n)) && ["N8N_BASE_URL", "N8N_WORKFLOW_ID"].filter((n) => !names.includes(n)).every((n) => !lines[0].includes(`${n} is`)));
					check(`§5 ${name}, ${label}: before any network call (${r.calls.join("; ") || "none"})`, r.calls.length === 0);
				}
				const r = runScript(rel, args, { ...KEY, ...needs, N8N_BASE_URL: N8N_URL, N8N_WORKFLOW_ID: N8N_WF });
				check(`§5 ${name}, both set: not refused for them (exit ${r.code})`, r.code !== 2 && !/N8N_(BASE_URL|WORKFLOW_ID)[^\n]*not set/.test(r.out));
				const fetches = r.calls.filter((l) => l.startsWith("network fetch ")).map((l) => l.slice("network fetch ".length));
				const other = r.calls.filter((l) => !l.startsWith("network fetch "));
				check(`§5 ${name}, both set: every call goes to the named instance, and names the named workflow (${fetches.join("; ") || "none"})`,
					other.length === 0 && fetches.every((u) => u.startsWith(`${N8N_URL}/api/v1/`)) &&
					(name === "stage-n8n-details-fix.js" ? r.code === 3 && r.out.includes(`/workflows/${N8N_WF}`) : fetches.length >= 1 && fetches[0].includes(N8N_WF)));
			}
			const fixture = path.join(tmp, "workflow-fixture.json");
			fs.writeFileSync(fixture, JSON.stringify({ id: "fixture-under-test", name: "fixture", active: false, nodes: [], connections: {} }));
			const f = runScript(path.join("scripts", "verify-n8n-behaviour.js"), ["--fixture", fixture], {});
			check(`§5 verify-n8n-behaviour.js --fixture: needs neither setting (exit ${f.code})`, f.code !== 2 && !/not set/.test(f.out));
			check(`§5 …and makes no network call (${f.calls.join("; ") || "none"})`, f.calls.length === 0);
		});

		await section("§6 scripts/repair-job-tracking-addresses.js", () => {
			const script = path.join("scripts", "repair-job-tracking-addresses.js");
			const checkout = () => {
				const d = fs.mkdtempSync(path.join(tmp, "root-"));
				fs.symlinkSync(SERVER, path.join(d, "server.js"));
				fs.symlinkSync(path.join(ROOT, "lib"), path.join(d, "lib"));
				return d;
			};
			const run = (args, env = {}) => {
				const root = checkout();
				return runScript(script, [`--db=${path.join(root, "none.db")}`, ...args], { LOGISX_ROOT: root, ...env });
			};
			// With every other input present, so nothing but --sheet-id can stop it.
			const READY = { GEMINI_API_KEY: "fake-gemini-key-nopd", RATECON_DRIVE_FOLDER_ID: "folder-under-test-nopd" };
			for (const [label, args] of [["no --sheet-id", []], ["a bare --sheet-id", ["--sheet-id"]], ["--sheet-id= (empty)", ["--sheet-id="]]]) {
				const r = run(args, READY);
				check(`§6 ${label}: refused, exit 2 (got ${r.code})`, r.code === 2 && /--sheet-id=<id> is required/.test(r.out));
				check(`§6 ${label}: before any Google call or connection (${r.calls.join("; ") || "none"})`, r.calls.length === 0);
				check(`§6 ${label}: no sheet is named in its output`, !/\n\s*sheet\s{2,}/.test(`\n${r.stdout}`));
			}
			const t = run([`--sheet-id=${TEST_SHEET}`]);
			check("§6 --sheet-id=<a test sheet>: not refused for it", !/--sheet-id=<id> is required/.test(t.out) && t.out.includes(`sheet     ${TEST_SHEET}`));
			check("§6 …not labelled (PRODUCTION)", !/\(PRODUCTION\)/.test(t.out));
			check(`§6 …no Google call before its other refusals (${t.calls.join("; ") || "none"})`, t.calls.length === 0);
			const p = run([`--sheet-id=${PROD_SHEET_ID}`]);
			check("§6 --sheet-id=<production's>: labelled (PRODUCTION)", !!PROD_SHEET_ID && /sheet\s+\S+\s+\(PRODUCTION\)/.test(p.out));
			check(`§6 …and no Google call before its other refusals (${p.calls.join("; ") || "none"})`, p.calls.length === 0);
		});

		await section("§7 scripts name their target", () => {
			check(`§7 production's app directory is readable from lib/sheet-id.js (${PROD_DIR ? "yes" : "no"})`, !!PROD_DIR);
			const hits = [];
			for (const f of SCRIPT_JS) {
				const text = readSource(f);
				let l = { literals: [], code: text };
				try { l = lex(text); } catch { l = { literals: [], code: text }; }
				for (const lit of l.literals) {
					for (const h of prodIn(lit.content)) {
						if (!TARGETS.includes(h.p)) continue;
						hits.push({ f, line: lineOf(text, lit.start), p: h.p, bare: isBare(h.p, lit.content), before: before(l.code, lit.start), runner: isRunner(f) });
					}
				}
			}
			const where = (list) => [...new Set(list.map((x) => `${x.f}:${x.line}`))].join(", ") || "none";
			// A constant naming production (a refusal list, a label) stays allowed.
			for (const p of [APP_HOST, APP_DIRECTORY]) {
				for (const shape of ["fallback", "default parameter", "argument default", "environment assignment"]) {
					const bad = hits.filter((x) => !x.runner && x.p === p && x.bare && SHAPES[shape].test(x.before));
					check(`§7 scripts/: ${p.kind} is never a ${shape} (${where(bad)})`, bad.length === 0);
				}
			}
			for (const p of [GMAIL_MESSAGE, GMAIL_CREDENTIAL]) {
				const any = hits.filter((x) => x.p === p);
				check(`§7 scripts/: ${p.kind} is in no code (${where(any)})`, any.length === 0);
			}
			const shellBad = [];
			for (const f of SCRIPT_SH.filter((s) => !isRunner(s))) {
				readSource(f).split("\n").forEach((line, n) => {
					const codePart = line.replace(/(^|\s)#.*$/, "");
					for (const m of codePart.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?[-=]([^}]*)\}/g)) {
						if (/PROD/.test(m[1])) continue;
						if (prodIn(m[2]).some((h) => h.p === APP_HOST || h.p === APP_DIRECTORY)) shellBad.push(`${f}:${n + 1}`);
					}
				});
			}
			check(`§7 scripts/*.sh: neither ${APP_HOST.kind} nor ${APP_DIRECTORY.kind} is a \${VAR:-…} default, but for a variable named for production (${shellBad.join(", ") || "none"})`,
				shellBad.length === 0);
		});

		await section("§8 each script that had a production default, run without its setting", () => {
			const geocode = path.join("scripts", "geocode-loads.js");
			for (const [label, args, env] of [
				["no LOGISX_BASE_URL", ["cookie-under-test"], {}],
				["a blank LOGISX_BASE_URL", ["cookie-under-test"], { LOGISX_BASE_URL: " \t" }],
				["no LOGISX_BASE_URL and no cookie", [], {}],
			]) {
				const r = runScript(geocode, args, env);
				check(`§8 geocode-loads.js, ${label}: exit 2 (got ${r.code})`, r.code === 2);
				check(`§8 geocode-loads.js, ${label}: says LOGISX_BASE_URL is needed (${redact(r.stderr.split("\n")[0] || "").slice(0, 160)})`,
					/LOGISX_BASE_URL is not set/.test(r.stderr));
				check(`§8 geocode-loads.js, ${label}: before any network call (${r.calls.join("; ") || "none"})`, r.calls.length === 0);
			}
			const SERVER_URL = "https://logisx.example.test";
			const g = runScript(geocode, ["cookie-under-test"], { LOGISX_BASE_URL: `${SERVER_URL}/` });
			const gf = g.calls.filter((l) => l.startsWith("network fetch ")).map((l) => l.slice("network fetch ".length));
			check(`§8 geocode-loads.js, LOGISX_BASE_URL set: not refused for it (exit ${g.code})`, g.code !== 2 && !/LOGISX_BASE_URL is not set/.test(g.out));
			check(`§8 …every call goes to the named server (${gf.join("; ") || "none"})`,
				gf.length >= 1 && gf.every((u) => u.startsWith(`${SERVER_URL}/api/`)) && g.calls.length === gf.length);

			const N8N = { N8N_API_KEY: "n8n-key-under-test", N8N_BASE_URL: N8N_URL, N8N_WORKFLOW_ID: N8N_WF };
			const replay = path.join("scripts", "replay-via-webhook-injection.js");
			const rescue = path.join("scripts", "rescue-load.js");
			for (const [rel, label, args, env, want] of [
				[replay, "no message ID", [], N8N_CREDENTIAL, /name the Gmail message to replay/],
				[replay, "a blank message ID", ["  "], N8N_CREDENTIAL, /name the Gmail message to replay/],
				[replay, "no N8N_GMAIL_CREDENTIAL_ID", [MESSAGE_ID], {}, /N8N_GMAIL_CREDENTIAL_ID is not set/],
				[replay, "a blank N8N_GMAIL_CREDENTIAL_ID", [MESSAGE_ID], { N8N_GMAIL_CREDENTIAL_ID: "  " }, /N8N_GMAIL_CREDENTIAL_ID is not set/],
				[rescue, "no N8N_GMAIL_CREDENTIAL_ID", ["123456"], {}, /N8N_GMAIL_CREDENTIAL_ID is not set/],
			]) {
				const name = path.basename(rel);
				const r = runScript(rel, args, { ...N8N, ...env });
				const lines = r.stderr.split("\n").filter((l) => l.trim());
				check(`§8 ${name}, ${label}: exit 2 (got ${r.code})`, r.code === 2);
				check(`§8 ${name}, ${label}: one line, naming what is missing (${redact(lines.join(" | ")).slice(0, 160)})`, lines.length === 1 && want.test(lines[0]));
				check(`§8 ${name}, ${label}: before any network call (${r.calls.join("; ") || "none"})`, r.calls.length === 0);
			}

			const secure = path.join("scripts", "secure-backups.sh");
			for (const [label, args, env] of [
				["no --app-dir or APP_DIR", [], {}],
				["no --app-dir or APP_DIR, --apply", ["--apply"], {}],
				["no --app-dir or APP_DIR, --apply --adopt-strays", ["--apply", "--adopt-strays"], {}],
				["a blank APP_DIR, --apply", ["--apply"], { APP_DIR: "  " }],
				["an empty --app-dir=, --apply", ["--app-dir=", "--apply"], {}],
			]) {
				const r = runShell(secure, args, env);
				const lines = r.stderr.split("\n").filter((l) => l.trim());
				check(`§8 secure-backups.sh, ${label}: exit 2 (got ${r.code})`, r.code === 2);
				check(`§8 secure-backups.sh, ${label}: one line naming --app-dir and APP_DIR (${redact(lines.join(" | ")).slice(0, 160)})`,
					lines.length === 1 && lines[0].includes("--app-dir") && lines[0].includes("APP_DIR"));
				check(`§8 secure-backups.sh, ${label}: before it reads or changes anything (${r.calls.join("; ") || "no command"}, ${r.stdout.trim() ? "a report" : "no report"})`,
					r.calls.length === 0 && !r.stdout.trim());
			}
			// Named, a dry run of a scratch tree: it reads what it was given and changes nothing.
			const tree = fs.mkdtempSync(path.join(tmp, "app-"));
			const backups = path.join(tree, "backups");
			fs.mkdirSync(backups);
			fs.chmodSync(backups, 0o755);
			const snap = path.join(backups, "app.db.20260101_020000.gz");
			fs.writeFileSync(snap, "snapshot");
			fs.chmodSync(snap, 0o644);
			const envSnaps = path.join(tmp, "env-snapshots-under-test");
			for (const [label, args, env] of [
				["--app-dir=<a scratch tree>", [`--app-dir=${tree}`, `--env-snapshots-dir=${envSnaps}`], {}],
				["APP_DIR=<a scratch tree>", [`--env-snapshots-dir=${envSnaps}`], { APP_DIR: tree }],
			]) {
				const r = runShell(secure, args, env, { stubbed: false });
				check(`§8 secure-backups.sh, ${label}: a dry run of that directory (exit ${r.code})`,
					r.code === 0 && r.out.includes(`app dir:       ${tree}`) && /DRY RUN/.test(r.out) && /WOULD\s+chmod 600 app\.db\./.test(r.out));
				check(`§8 secure-backups.sh, ${label}: …that changes nothing`,
					(fs.statSync(snap).mode & 0o777) === 0o644 && (fs.statSync(backups).mode & 0o777) === 0o755 && !fs.existsSync(envSnaps));
			}
		});
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) process.exit(1);
})().catch((e) => {
	fs.rmSync(tmp, { recursive: true, force: true });
	console.error(redact(e && e.stack));
	process.exit(1);
});
