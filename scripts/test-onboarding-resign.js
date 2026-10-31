#!/usr/bin/env node
/**
 * Request a fresh signature (ONBOARDING_RESIGN_ENABLED): a Super Admin asks a
 * driver to sign one policy document again; the signed original stays as history.
 *
 *   §1 flag off: both request routes answer 404 FEATURE_OFF for every role and
 *      for no session (the gate runs first); a signed document with a request
 *      planted in the database still answers "Already signed" and nothing moves;
 *      the Drivers page answer carries no request keys
 *   §2 who may ask: Super Admin only (Dispatcher, Driver, Investor 403; no
 *      session 401); the CSRF header and a cross-site request are refused; the
 *      limiter's 31st request answers 429
 *   §3 the request: it writes the request, one notice (no reason, no requester)
 *      and one audit row, emits one live refresh to the driver's room only, and
 *      leaves the file, the evidence and `signed` exactly as they were; the
 *      Drivers page shows it to a Super Admin
 *   §4 the refusals: a reason under 10 characters, the contractor agreement and
 *      the W-9 (clear words), an unknown document, an unsigned one, an open
 *      request, an original missing, misnamed or not matching its digest, a bad
 *      id and a non-driver account; each writes nothing
 *   §5 the cancel: it clears the request and audits; nothing open is a 409
 *   §6 the fresh signature: consent is required; the original is copied into
 *      the archive byte for byte (its old sha256) before anything is written,
 *      its evidence goes into the history entry word for word, the new file and
 *      evidence carry today's date, the request is cleared, `signed` stays 1,
 *      and the completion step never runs (no email, no sheet, no directory);
 *      the evidence route shows the history; with the flag on and no request a
 *      signed document still answers "Already signed"; a request planted on the
 *      contractor agreement is never opened (bank details are not touched)
 *   §7 failures keep the original: a render failure, a cut-off value, a write
 *      that fails after the file was written (restored from the archive), an
 *      archive that can't be made, the request withdrawn mid-render, a save that
 *      fails, a second tap while the first is saving, and a missing original:
 *      the live file and its evidence are as they were, and no history is added
 *   §8 privacy: the reason and the requester reach no driver or dispatcher
 *      answer (GET /api/onboarding/:userId, the driver's documents, the Drivers
 *      page for a Dispatcher), only a yes/no
 *   §9 the pin: the middleware order, the flag's read shape, the limiter, the
 *      live event, the lib names no mailer or sheet, the fresh branch returns
 *      before the completion step, the strip list, the file name
 *  §10 mutants, each required to flip its section: the archive taken after the
 *      write; the restore removed; Dispatcher added to the roles; the gate after
 *      the role check; the scope refusal removed; the staff-only columns not
 *      stripped (server and lib); the completion step called; the flag ignored
 *      by the sign route; the reason check removed; the request clearing
 *      `signed`; the commit's re-check removed; the in-flight lock removed
 *
 * Runs the shipped code: the routes and every helper they use (requireRole,
 * refuseCrossSite, logAudit, the signed-artifact functions) are lifted from
 * server.js through serverSource() and scripts/lib/server-lift.js and run on
 * express (127.0.0.1, port 0) over an in-memory SQLite whose tables come from
 * server.js's own CREATE text, with a scratch data folder for the signed files
 * and the evidence archive. The renderer, the completion step and the live
 * socket are recorders; nothing that sends mail or writes a sheet is lifted.
 * Made-up people, addresses from the documentation ranges, no real data.
 *
 * Run: node scripts/test-onboarding-resign.js   # exits 1 on failure
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const { closure, indexDeclarations, liftRoute } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");

const ROOT = process.env.SERVER_ROOT ? path.resolve(process.env.SERVER_ROOT) : path.join(__dirname, "..");
const SRC = serverSource();
const LIB_FILE = path.join(ROOT, "lib", "onboarding-resign.js");
const LIB_TEXT = fs.existsSync(LIB_FILE) ? fs.readFileSync(LIB_FILE, "utf8") : "";
// Loaded from its text, so a mutant is the same module with one change.
function loadLib(text) {
	if (!text) return null;
	const mod = { exports: {} };
	new Function("module", "exports", "require", "__filename", "__dirname", text)(mod, mod.exports, require, LIB_FILE, path.dirname(LIB_FILE));
	return mod.exports;
}
let realLib = null;
try { realLib = loadLib(LIB_TEXT); } catch { realLib = null; }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-resign-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── reporting ─────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function checker(print) {
	const c = { failed: [] };
	c.ok = (name, cond, detail) => {
		if (cond) { if (print) { passed++; console.log(`  ok    ${name}`); } return; }
		c.failed.push(name);
		if (print) { failures.push(name); console.log(`  FAIL  ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
	};
	c.eq = (name, actual, expected) => c.ok(name, JSON.stringify(actual) === JSON.stringify(expected),
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	return c;
}
const MAIN = checker(true);
const quietErrors = [];
const QUIET = { log() {}, info() {}, warn() {}, error: (...a) => quietErrors.push(a.map(String).join(" ")) };

// ── made-up people and documents ──────────────────────────────────────────────
const PEOPLE = [
	{ id: 90101, username: "sa.example", role: "Super Admin", driver_name: "" },
	{ id: 90201, username: "dispatch.example", role: "Dispatcher", driver_name: "" },
	{ id: 90301, username: "investor.example", role: "Investor", driver_name: "" },
	{ id: 90102, username: "casey.example", role: "Driver", driver_name: "Casey Example" },
	{ id: 90103, username: "robin.sample", role: "Driver", driver_name: "Robin Sample" },
	{ id: 90105, username: "jordan.placeholder", role: "Driver", driver_name: "Jordan Placeholder" },
	// An account that once drove and is staff now: it has documents, no driver app.
	{ id: 90108, username: "former.driver", role: "Dispatcher", driver_name: "Former Driver" },
];
const SESSIONS = {
	sa: { id: 90101, username: "sa.example", role: "Super Admin" },
	dispatcher: { id: 90201, username: "dispatch.example", role: "Dispatcher" },
	investor: { id: 90301, username: "investor.example", role: "Investor" },
	casey: { id: 90102, username: "casey.example", role: "Driver", driverName: "Casey Example" },
	robin: { id: 90103, username: "robin.sample", role: "Driver", driverName: "Robin Sample" },
};
const DIRECTORY = [[501, "Casey Example"], [502, "Robin Sample"]];
const DOC_NAMES = {
	contractor_agreement: "Contractor Agreement",
	equipment_policy: "Contracted Provider Equipment Policy",
	w9: "W-9 Tax Form",
	mobile_policy: "LogisX Inc. Mobile Policy",
	substance_policy: "Substance Policy and Procedure",
};
const CONSENT = "I have read and agree to the terms of this document";
const OLD = {
	signedAt: "2026-01-05T15:04:05.000Z",
	ip: "203.0.113.10",
	ipSource: "proxy",
	agent: "Made-up Browser 1.0",
	effectiveDate: "January 5, 2026",
};
const REASON = "Made-up reason: the printed name was cut off in its box.";
const NEW_AGENT = "Made-up Phone Browser 2.0";
const today = () => new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const originalBytes = (docKey, userId) => Buffer.concat([
	Buffer.from(`%PDF-1.7\n% made-up signed original: ${docKey} for user ${userId}\n`), Buffer.alloc(3000, 0x20), Buffer.from("\n%%EOF\n")]);
const fileName = (docKey, userId) => `${docKey}-${userId}-signed.pdf`;
const urlOf = (docKey, userId) => `/uploads/onboarding-signed/${fileName(docKey, userId)}`;

// Who holds what. `file`: "valid" (on disk, its digest stored), "grandfathered"
// (on disk, evidence_version 0 and no digest), "missing" (no file), "mismatch"
// (on disk, another digest stored), "misnamed" (the row points at another name).
const DOCS = [
	[90102, "mobile_policy", 1, "valid"],
	[90102, "equipment_policy", 1, "grandfathered"],
	[90102, "substance_policy", 1, "missing"],
	[90102, "contractor_agreement", 1, "valid"],
	[90102, "w9", 1, "valid"],
	[90103, "mobile_policy", 1, "valid"],
	[90103, "equipment_policy", 0, "none"],
	[90105, "mobile_policy", 1, "mismatch"],
	[90105, "substance_policy", 1, "misnamed"],
	[90108, "mobile_policy", 1, "valid"],
];

// ── lifting ───────────────────────────────────────────────────────────────────
const REQUEST_HEAD = 'app.post("/api/admin/onboarding/:userId/documents/:docKey/request-signature",';
const CANCEL_HEAD = 'app.post("/api/admin/onboarding/:userId/documents/:docKey/cancel-signature-request",';
const SIGN_HEAD = 'app.post("/api/onboarding/:userId/documents/:docKey/sign",';
const ROUTE_PREFIXES = [
	REQUEST_HEAD,
	CANCEL_HEAD,
	SIGN_HEAD,
	'app.get("/api/onboarding/:userId",',
	'app.get("/api/drivers-directory/:id/documents",',
	'app.get("/api/admin/onboarding-evidence/:scope/:ownerId",',
];
const requestUrl = (userId, docKey) => `/api/admin/onboarding/${userId}/documents/${docKey}/request-signature`;
const cancelUrl = (userId, docKey) => `/api/admin/onboarding/${userId}/documents/${docKey}/cancel-signature-request`;
const signUrl = (userId, docKey) => `/api/onboarding/${userId}/documents/${docKey}/sign`;
// Supplied by the world. The completion step and the dispatch notice are
// recorders; the renderer is the world's stand-in. A lifted piece that reaches a
// mailer or the sheet sync stops the run.
const PROVIDED = ["db", "app", "io", "require", "console", "DATA_DIR", "ONBOARDING_RESIGN_ENABLED", "renderPolicy", "fillW9Form",
	"checkAndCompleteOnboarding", "emitDispatchNotice", "onboardingSignLimiter"];
const DENIED = ["server", "sheets", "getSheets", "getDrive", "transporter", "sendEmail", "syncDriverToCarrierSheet", "jtCacheInvalidate"];

function linesStarting(src, prefix) { return src.split("\n").filter((l) => l.startsWith(prefix)); }
function lineStarting(src, prefix) {
	const hits = linesStarting(src, prefix);
	if (hits.length !== 1) throw new Error(`expected one line starting ${prefix}, found ${hits.length}`);
	return hits[0];
}
function execBlock(src, marker) {
	const at = src.indexOf(marker);
	if (at < 0) throw new Error(`server.js has no ${marker}`);
	const open = src.lastIndexOf("db.exec(`", at);
	const close = src.indexOf("`);", at);
	if (open < 0 || close < 0) throw new Error(`could not cut the db.exec holding ${marker}`);
	return src.slice(open + "db.exec(`".length, close);
}
function evidenceColumns(src) {
	const m = /for \(const t of \["onboarding_documents", "investor_onboarding_documents"\]\) \{\n\tfor \(const col of \[([\s\S]*?)\]\) \{/.exec(src);
	if (!m) throw new Error("no signing-evidence column list in server.js");
	return [...m[1].matchAll(/"([a-z0-9_]+ [^"]*)"/g)].map((x) => x[1]);
}
// A route the source does not register is left out (the old code has neither
// request route), so the sections still run there and fail on what is missing.
// auditConfidentialRead is a root because the identifier scan reads a name that
// opens a line under a comment ending in "." as a property, and the evidence route
// calls it just there.
function liftAll(src) {
	return closure(src, {
		roots: ["stripSigningEvidence", "auditConfidentialRead"].filter((n) => indexDeclarations(src).decls.has(n)),
		routes: ROUTE_PREFIXES.filter((p) => linesStarting(src, p).length === 1).map((p) => lineStarting(src, p)),
		provided: PROVIDED,
		denied: DENIED,
	});
}
function mutate(text, from, to) {
	const n = text.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 90)}`);
	return text.replace(from, () => to);
}

// ── a world ───────────────────────────────────────────────────────────────────
const USERS_DDL = `CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
	driver_name TEXT DEFAULT '', email TEXT DEFAULT '', company_name TEXT DEFAULT '')`;
const APPS_DDL = `CREATE TABLE job_applications (id INTEGER PRIMARY KEY, full_name TEXT DEFAULT '', email TEXT DEFAULT '',
	address TEXT DEFAULT '', ssn TEXT DEFAULT '', drivers_license TEXT DEFAULT '', cdl_front TEXT DEFAULT '', cdl_back TEXT DEFAULT '',
	medical_card TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`;
const DIRECTORY_DDL = "CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY, driver_name TEXT NOT NULL, status TEXT DEFAULT 'active')";

function seed(db, signedDir) {
	const u = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, ?, ?)");
	for (const p of PEOPLE) u.run(p.id, p.username, p.role, p.driver_name);
	const d = db.prepare("INSERT INTO drivers_directory (id, driver_name) VALUES (?, ?)");
	for (const [id, name] of DIRECTORY) d.run(id, name);
	for (const p of PEOPLE.filter((x) => x.driver_name)) {
		const appId = p.id - 90000;
		db.prepare("INSERT INTO job_applications (id, full_name, address) VALUES (?, ?, ?)").run(appId, p.driver_name, "100 Example Way, Sampletown, TX 75001");
		db.prepare("INSERT INTO driver_onboarding (user_id, application_id, driver_name, status) VALUES (?, ?, ?, ?)")
			.run(p.id, appId, p.driver_name, p.id === 90103 ? "documents_signed" : "fully_onboarded");
	}
	const ins = db.prepare(`INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signature_text, signed_at, signed_pdf_url,
		signed_ip, signed_ip_source, signed_user_agent, consent_agreed, consent_text, artifact_sha256, artifact_bytes, effective_date, evidence_version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const [userId, docKey, signed, file] of DOCS) {
		const name = PEOPLE.find((p) => p.id === userId).driver_name;
		const bytes = originalBytes(docKey, userId);
		if (["valid", "grandfathered", "mismatch", "misnamed"].includes(file)) fs.writeFileSync(path.join(signedDir, fileName(docKey, userId)), bytes);
		if (!signed) { ins.run(userId, docKey, DOC_NAMES[docKey], 0, "", "", "", "", "", "", 0, "", "", 0, "", 0); continue; }
		const legacy = file === "grandfathered";
		const storedSha = file === "mismatch" ? sha(Buffer.from("made-up other bytes")) : legacy ? "" : sha(bytes);
		const url = file === "misnamed" ? "/uploads/onboarding-signed/made-up-other-name.pdf" : urlOf(docKey, userId);
		ins.run(userId, docKey, DOC_NAMES[docKey], 1, name, OLD.signedAt, url,
			legacy ? "" : OLD.ip, legacy ? "" : OLD.ipSource, legacy ? "" : OLD.agent, legacy ? 0 : 1, legacy ? "" : CONSENT,
			storedSha, legacy ? 0 : bytes.length, legacy ? "" : OLD.effectiveDate, legacy ? 0 : 1);
	}
}

// The renderer's stand-in: a made-up PDF naming what it was handed. `mode`
// picks a failure; `hold` (a promise) keeps it rendering; `during` runs inside it.
function makeRenderer(state) {
	return async (docKey, data) => {
		state.calls.push({ docKey, ...data, signatureImage: data.signatureImage ? "[image]" : null });
		state.started = true;
		if (state.during) await state.during();
		if (state.hold) await state.hold;
		if (state.mode === "throw") throw new Error("made-up renderer crash");
		if (state.mode === "cutoff") throw Object.assign(new Error("a required box is too narrow"), { code: "DOCUMENT_FIELDS_UNFILLED", clippedLabels: ["Printed Name"] });
		if (state.mode === "tiny") return Buffer.from("%PDF-1.7\n% made-up truncated output\n");
		return Buffer.concat([Buffer.from(`%PDF-1.7\n% made-up fresh copy: ${docKey}\n% signed ${data.signatureText}\n% effective ${data.effectiveDate}\n`),
			Buffer.alloc(2500, 0x20), Buffer.from("\n%%EOF\n")]);
	};
}

async function world({ src = SRC, flag = true, lib = realLib } = {}) {
	const dataDir = fs.mkdtempSync(path.join(TMP, "w-"));
	const signedDir = path.join(dataDir, "uploads", "onboarding-signed");
	const archiveDir = path.join(dataDir, "evidence-archive", "signed-artifacts");
	fs.mkdirSync(signedDir, { recursive: true });
	const db = new Database(":memory:");
	db.exec(USERS_DDL);
	db.exec(APPS_DDL);
	db.exec(DIRECTORY_DDL);
	for (const t of ["audit_trail", "notifications", "dispatch_notifications", "driver_onboarding", "onboarding_documents", "onboarding_doc_alerts"]) {
		db.exec(execBlock(src, `CREATE TABLE IF NOT EXISTS ${t} (`));
	}
	for (const col of ["signed_pdf_url TEXT DEFAULT ''", "signing_error TEXT DEFAULT ''", "signing_failed_at TEXT DEFAULT ''", ...evidenceColumns(src)]) {
		db.exec(`ALTER TABLE onboarding_documents ADD COLUMN ${col}`);
	}
	const missingColumns = lib && typeof lib.ensureColumns === "function" ? lib.ensureColumns(db) : ["(no lib)"];
	seed(db, signedDir);
	const lifted = liftAll(src);
	const render = { calls: [], mode: "ok", hold: null, during: null, started: false };
	const completion = [];
	const emits = [];
	const dispatchNotices = [];
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		const s = SESSIONS[req.get("x-test-user")];
		req.session = s ? { user: { ...s } } : {};
		next();
	});
	const scope = {
		db,
		app,
		io: { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) },
		require: (m) => {
			if (m === "./lib/onboarding-resign") { if (!lib) throw new Error("lib/onboarding-resign.js is missing"); return lib; }
			return require(m.startsWith("./lib/") ? path.join(ROOT, m) : m);
		},
		console: QUIET,
		DATA_DIR: dataDir,
		ONBOARDING_RESIGN_ENABLED: flag,
		renderPolicy: makeRenderer(render),
		fillW9Form: async () => null,
		checkAndCompleteOnboarding: async (userId) => { completion.push(userId); return { status: "documents_signed" }; },
		emitDispatchNotice: (n) => dispatchNotices.push(n),
		onboardingSignLimiter: (req, res, next) => next(),
	};
	const names = Object.keys(scope);
	const fns = new Function(...names, `${lifted.text}\nreturn { stripSigningEvidence: typeof stripSigningEvidence === "function" ? stripSigningEvidence : null };`)(...names.map((n) => scope[n]));
	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const call = (method, url, { user, body, csrf = true, headers: extra = {} } = {}) => new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const headers = { "user-agent": NEW_AGENT, ...extra };
		if (user) headers["x-test-user"] = user;
		if (data !== null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
		if (csrf && method !== "GET") headers["x-requested-with"] = "XMLHttpRequest";
		const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: url, headers }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { text += chunk; });
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(text); } catch { json = null; }
				resolve({ status: res.statusCode, body: json, text });
			});
		});
		req.on("error", reject);
		if (data !== null) req.write(data);
		req.end();
	});
	const close = () => new Promise((resolve) => { server.close(() => { db.close(); resolve(); }); });
	return { db, call, close, fns, render, completion, emits, dispatchNotices, signedDir, archiveDir, dataDir, missingColumns, lib };
}

const docRow = (db, userId, docKey) => db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? AND doc_key = ?").get(userId, docKey);
const EVIDENCE_KEYS = ["signed", "signature_text", "signed_at", "signed_pdf_url", "signed_ip", "signed_ip_source", "signed_user_agent",
	"consent_agreed", "consent_text", "artifact_sha256", "artifact_bytes", "effective_date", "evidence_version", "superseded_artifacts"];
const evidenceOf = (row) => Object.fromEntries(EVIDENCE_KEYS.map((k) => [k, row ? row[k] : undefined]));
const auditRows = (db) => db.prepare("SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail ORDER BY id").all();
const notices = (db) => db.prepare("SELECT driver_name, type, title, body, metadata FROM notifications ORDER BY id").all();
const fileBytes = (w, docKey, userId) => { try { return fs.readFileSync(path.join(w.signedDir, fileName(docKey, userId))); } catch { return null; } };
const archiveFiles = (w) => { try { return fs.readdirSync(w.archiveDir).sort(); } catch { return []; } };
const answer = (r) => [r.status, r.body && r.body.code];
const leaks = (text, values) => values.filter((v) => String(text).includes(v));
const signBody = (name = "Casey Example") => ({ signatureText: name, consent: { agreed: true, text: CONSENT } });
const plantRequest = (db, userId, docKey) => db.prepare(
	"UPDATE onboarding_documents SET resign_requested_at = ?, resign_requested_by = ?, resign_reason = ? WHERE user_id = ? AND doc_key = ?"
).run("2026-10-30T12:00:00.000Z", "sa.example", REASON, userId, docKey);
const history = (row) => { try { return JSON.parse(row.superseded_artifacts || "[]"); } catch { return null; } };

// Waits at most `ms` for the stand-in renderer to start; false when it never does
// (code that answers "Already signed" never renders), so a section fails, never hangs.
async function renderStarted(w, ms = 3000) {
	const until = Date.now() + ms;
	while (!w.render.started) {
		if (Date.now() > until) return false;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return true;
}

// Runs one section on a fresh world, so a throw (a missing lift on the old
// code) is a failure of that section, never a crash.
async function inWorld(c, label, opts, fn) {
	let w = null;
	try {
		w = await world(opts);
		await fn(w);
	} catch (err) {
		c.ok(`${label} ran`, false, `threw: ${err && err.message}`);
	} finally {
		if (w) await w.close();
	}
}

// ── §1 flag off ───────────────────────────────────────────────────────────────
async function flagOffSection(c, { src = SRC, lib = realLib } = {}) {
	await inWorld(c, "§1", { src, lib, flag: false }, async (w) => {
		for (const url of [requestUrl(90102, "mobile_policy"), cancelUrl(90102, "mobile_policy")]) {
			for (const who of ["sa", "dispatcher", "investor", "casey", null]) {
				const r = await w.call("POST", url, { user: who, body: { reason: REASON } });
				c.eq(`§1 POST ${url.split("/").pop()} as ${who || "no session"}: 404 FEATURE_OFF`, answer(r), [404, "FEATURE_OFF"]);
			}
			const cross = await w.call("POST", url, { user: "sa", body: { reason: REASON }, headers: { "sec-fetch-site": "cross-site" } });
			c.eq(`§1 POST ${url.split("/").pop()} cross-site: still 404 FEATURE_OFF (the gate runs first)`, answer(cross), [404, "FEATURE_OFF"]);
		}
		plantRequest(w.db, 90102, "mobile_policy");
		const before = evidenceOf(docRow(w.db, 90102, "mobile_policy"));
		const bytes = fileBytes(w, "mobile_policy", 90102);
		const r = await w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
		c.eq("§1 a signed document with a request planted: 200 \"Already signed\"", [r.status, r.body && r.body.message], [200, "Already signed"]);
		c.eq("§1 ...its evidence is as it was", evidenceOf(docRow(w.db, 90102, "mobile_policy")), before);
		c.ok("§1 ...its file is as it was", Buffer.isBuffer(bytes) && bytes.equals(fileBytes(w, "mobile_policy", 90102)));
		c.eq("§1 ...nothing rendered, archived, completed or noticed", [w.render.calls.length, archiveFiles(w).length, w.completion.length, notices(w.db).length, w.emits.length], [0, 0, 0, 0, 0]);
		c.eq("§1 nothing audited", auditRows(w.db).length, 0);
		const docs = await w.call("GET", "/api/drivers-directory/501/documents", { user: "sa" });
		c.ok("§1 the Drivers page answer has no userId and no request keys",
			docs.status === 200 && !("userId" in docs.body) && docs.body.documents.every((d) => !("resign" in d) && !("resignable" in d)), docs.body);
		c.eq("§1 ...and the same document keys as before", Object.keys((docs.body.documents || [])[0] || {}),
			["doc_key", "doc_name", "signed", "signature_text", "signed_at", "signed_pdf_url"]);
		if (w.fns.stripSigningEvidence && w.lib) {
			const rows = w.db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? ORDER BY id").all(90102);
			c.eq("§1 the driver's documents: what the stripper alone answers (no resign_requested key)",
				w.lib.driverDocs(rows, { enabled: false, strip: w.fns.stripSigningEvidence }), w.fns.stripSigningEvidence(rows));
		} else c.ok("§1 the driver's documents view exists", false, "no lib or stripper");
	});
}

// ── §2 who may ask ────────────────────────────────────────────────────────────
async function rolesSection(c, { src = SRC, lib = realLib } = {}) {
	await inWorld(c, "§2", { src, lib }, async (w) => {
		for (const [label, url] of [["request", requestUrl(90102, "mobile_policy")], ["cancel", cancelUrl(90102, "mobile_policy")]]) {
			for (const [who, status] of [["dispatcher", 403], ["investor", 403], ["casey", 403], [null, 401]]) {
				const r = await w.call("POST", url, { user: who, body: { reason: REASON } });
				c.eq(`§2 ${label} as ${who || "no session"}: ${status}`, r.status, status);
			}
			const noHeader = await w.call("POST", url, { user: "sa", body: { reason: REASON }, csrf: false });
			c.eq(`§2 ${label} without the CSRF header: 403 CSRF_HEADER_REQUIRED`, answer(noHeader), [403, "CSRF_HEADER_REQUIRED"]);
			const cross = await w.call("POST", url, { user: "sa", body: { reason: REASON }, headers: { "sec-fetch-site": "cross-site" } });
			c.eq(`§2 ${label} cross-site: 403 CROSS_SITE_REFUSED`, answer(cross), [403, "CROSS_SITE_REFUSED"]);
		}
		c.eq("§2 the refused calls wrote nothing", [docRow(w.db, 90102, "mobile_policy").resign_requested_at, notices(w.db).length, w.emits.length], ["", 0, 0]);
		const ok = await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: REASON } });
		c.eq("§2 a Super Admin's request: 200", ok.status, 200);
	});
	await inWorld(c, "§2 limiter", { src, lib }, async (w) => {
		let last = null;
		for (let i = 0; i < 31; i++) last = await w.call("POST", cancelUrl(90102, "mobile_policy"), { user: "sa" });
		c.eq("§2 the 31st request in 15 minutes from one account: 429", last.status, 429);
	});
}

// ── §3 the request ────────────────────────────────────────────────────────────
async function requestSection(c, { src = SRC, lib = realLib } = {}) {
	await inWorld(c, "§3", { src, lib }, async (w) => {
		const before = evidenceOf(docRow(w.db, 90102, "mobile_policy"));
		const bytes = fileBytes(w, "mobile_policy", 90102);
		const r = await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: `  ${REASON}  ` } });
		c.eq("§3 200 with the document and when", [r.status, r.body && r.body.success, r.body && r.body.docKey, typeof (r.body && r.body.requestedAt)], [200, true, "mobile_policy", "string"]);
		const row = docRow(w.db, 90102, "mobile_policy");
		c.eq("§3 the request is stored: when, by whom, why (trimmed)", [row.resign_requested_at === r.body.requestedAt, row.resign_requested_by, row.resign_reason], [true, "sa.example", REASON]);
		c.eq("§3 the evidence and `signed` are exactly as they were", evidenceOf(row), before);
		c.ok("§3 the signed file is byte for byte as it was", Buffer.isBuffer(bytes) && bytes.equals(fileBytes(w, "mobile_policy", 90102)));
		c.eq("§3 nothing is rendered or archived yet", [w.render.calls.length, archiveFiles(w).length], [0, 0]);
		const n = notices(w.db);
		c.eq("§3 one notice, to the driver, of the new type, naming the document only",
			n.map((x) => [x.driver_name, x.type, x.title, JSON.parse(x.metadata)]),
			[["casey example", "resign-requested", "Please sign again: LogisX Inc. Mobile Policy", { docKey: "mobile_policy" }]]);
		c.eq("§3 ...the notice carries no reason and no requester", leaks(JSON.stringify(n), [REASON, "sa.example", "printed name"]), []);
		const noticeId = w.db.prepare("SELECT id FROM notifications").get().id;
		c.eq("§3 one live refresh, to the driver's room only, with the document key and the notice id",
			w.emits, [{ room: "driver:casey example", event: "onboarding-resign-requested", payload: { docKey: "mobile_policy", notificationId: noticeId } }]);
		const a = auditRows(w.db);
		c.eq("§3 one audit row, by the Super Admin, on the document",
			a.map((x) => [x.username, x.action, x.entity, x.entity_id]), [["sa.example", "request_fresh_signature", "onboarding_document", String(row.id)]]);
		c.ok("§3 ...naming the driver, the document and the reason", a.length === 1 && a[0].details.includes("90102") && a[0].details.includes("LogisX Inc. Mobile Policy") && a[0].details.includes(REASON), a[0] && a[0].details);
		c.eq("§3 the completion step never ran", w.completion.length, 0);
		const docs = await w.call("GET", "/api/drivers-directory/501/documents", { user: "sa" });
		const mobile = (docs.body.documents || []).find((d) => d.doc_key === "mobile_policy") || {};
		c.eq("§3 the Drivers page shows the request to a Super Admin, with the account to send it to",
			[docs.body.userId, mobile.resignable, mobile.resign && mobile.resign.reason, mobile.resign && mobile.resign.requestedBy], [90102, false, REASON, "sa.example"]);
		const offered = Object.fromEntries((docs.body.documents || []).map((d) => [d.doc_key, d.resignable]));
		c.eq("§3 ...and which other documents may be asked for (signed policies only)", offered,
			{ mobile_policy: false, equipment_policy: true, substance_policy: true, contractor_agreement: false, w9: false });
		const robin = await w.call("POST", requestUrl(90103, "mobile_policy"), { user: "sa", body: { reason: REASON } });
		c.eq("§3 another driver's request reaches that driver's room only", [robin.status, w.emits.map((e) => e.room)], [200, ["driver:casey example", "driver:robin sample"]]);
	});
}

// ── §4 the refusals ───────────────────────────────────────────────────────────
async function refusalsSection(c, { src = SRC, lib = realLib } = {}) {
	await inWorld(c, "§4", { src, lib }, async (w) => {
		const cases = [
			["a reason of 9 characters", requestUrl(90102, "mobile_policy"), { reason: "Too short" }, [400, "RESIGN_REASON_REQUIRED"]],
			["a reason of spaces", requestUrl(90102, "mobile_policy"), { reason: "             " }, [400, "RESIGN_REASON_REQUIRED"]],
			["no reason", requestUrl(90102, "mobile_policy"), {}, [400, "RESIGN_REASON_REQUIRED"]],
			["a reason that isn't text", requestUrl(90102, "mobile_policy"), { reason: ["Made-up reason in a list"] }, [400, "RESIGN_REASON_REQUIRED"]],
			["the contractor agreement", requestUrl(90102, "contractor_agreement"), { reason: REASON }, [409, "RESIGN_NOT_OFFERED"]],
			["the W-9", requestUrl(90102, "w9"), { reason: REASON }, [409, "RESIGN_NOT_OFFERED"]],
			["an unknown document", requestUrl(90102, "made_up_policy"), { reason: REASON }, [404, "UNKNOWN_DOC_KEY"]],
			["an unsigned document", requestUrl(90103, "equipment_policy"), { reason: REASON }, [409, "NOT_SIGNED"]],
			["an original missing from disk", requestUrl(90102, "substance_policy"), { reason: REASON }, [409, "ORIGINAL_MISSING"]],
			["an original under another name", requestUrl(90105, "substance_policy"), { reason: REASON }, [409, "ORIGINAL_MISSING"]],
			["an original that doesn't match its digest", requestUrl(90105, "mobile_policy"), { reason: REASON }, [409, "ORIGINAL_MISMATCH"]],
			["a bad account id", requestUrl("9x", "mobile_policy"), { reason: REASON }, [400, "INVALID_USER_ID"]],
			["an account that isn't a driver", requestUrl(90108, "mobile_policy"), { reason: REASON }, [409, "NO_DRIVER_ACCOUNT"]],
			["a missing account", requestUrl(90999, "mobile_policy"), { reason: REASON }, [409, "NO_DRIVER_ACCOUNT"]],
			["a driver with no such document", requestUrl(90103, "substance_policy"), { reason: REASON }, [404, "DOCUMENT_NOT_FOUND"]],
		];
		for (const [label, url, body, want] of cases) {
			const r = await w.call("POST", url, { user: "sa", body });
			c.eq(`§4 ${label}: ${want.join(" ")}`, answer(r), want);
		}
		const words = await w.call("POST", requestUrl(90102, "contractor_agreement"), { user: "sa", body: { reason: REASON } });
		c.ok("§4 the contractor agreement's refusal says why (bank details)", /bank details/.test(words.body && words.body.error), words.body);
		const w9 = await w.call("POST", requestUrl(90102, "w9"), { user: "sa", body: { reason: REASON } });
		c.ok("§4 the W-9's refusal says why (SSN)", /SSN/.test(w9.body && w9.body.error), w9.body);
		const open = w.db.prepare("SELECT COUNT(*) AS n FROM onboarding_documents WHERE COALESCE(resign_requested_at, '') <> ''").get().n;
		c.eq("§4 the refusals wrote nothing (no request, notice, live event or audit row)", [open, notices(w.db).length, w.emits.length, auditRows(w.db).length], [0, 0, 0, 0]);
		const first = await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: REASON } });
		const again = await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: `${REASON} Again.` } });
		c.eq("§4 a second request while one is open: 409 RESIGN_ALREADY_REQUESTED", [first.status, ...answer(again)], [200, 409, "RESIGN_ALREADY_REQUESTED"]);
		c.eq("§4 ...the first request's reason stands, one notice", [docRow(w.db, 90102, "mobile_policy").resign_reason, notices(w.db).length], [REASON, 1]);
		const grand = await w.call("POST", requestUrl(90102, "equipment_policy"), { user: "sa", body: { reason: REASON } });
		c.eq("§4 a grandfathered original (no stored digest) may be asked for", grand.status, 200);
	});
}

// ── §5 the cancel ─────────────────────────────────────────────────────────────
async function cancelSection(c, { src = SRC, lib = realLib } = {}) {
	await inWorld(c, "§5", { src, lib }, async (w) => {
		const none = await w.call("POST", cancelUrl(90102, "mobile_policy"), { user: "sa" });
		c.eq("§5 nothing open: 409 NO_OPEN_REQUEST", answer(none), [409, "NO_OPEN_REQUEST"]);
		const missing = await w.call("POST", cancelUrl(90103, "substance_policy"), { user: "sa" });
		c.eq("§5 no such document: 404 DOCUMENT_NOT_FOUND", answer(missing), [404, "DOCUMENT_NOT_FOUND"]);
		await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: REASON } });
		const before = evidenceOf(docRow(w.db, 90102, "mobile_policy"));
		const r = await w.call("POST", cancelUrl(90102, "mobile_policy"), { user: "sa" });
		c.eq("§5 a withdrawn request: 200", [r.status, r.body && r.body.success], [200, true]);
		const row = docRow(w.db, 90102, "mobile_policy");
		c.eq("§5 ...the request columns are cleared", [row.resign_requested_at, row.resign_requested_by, row.resign_reason, row.resign_error, row.resign_failed_at], ["", "", "", "", ""]);
		c.eq("§5 ...the document is untouched", evidenceOf(row), before);
		const a = auditRows(w.db).map((x) => [x.action, x.entity, x.entity_id]);
		c.eq("§5 ...one cancel audit row after the request's", a, [["request_fresh_signature", "onboarding_document", String(row.id)], ["cancel_fresh_signature", "onboarding_document", String(row.id)]]);
		const sign = await w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
		c.eq("§5 after a cancel the driver's signature answers \"Already signed\"", [sign.status, sign.body && sign.body.message], [200, "Already signed"]);
	});
}

// ── §6 the fresh signature ────────────────────────────────────────────────────
async function freshSection(c, { src = SRC, lib = realLib } = {}) {
	await inWorld(c, "§6", { src, lib }, async (w) => {
		const quiet = await w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
		c.eq("§6 flag on, no request: a signed document answers \"Already signed\"", [quiet.status, quiet.body && quiet.body.message], [200, "Already signed"]);
		c.eq("§6 ...and nothing rendered", w.render.calls.length, 0);
		await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: REASON } });
		const original = docRow(w.db, 90102, "mobile_policy");
		const oldBytes = fileBytes(w, "mobile_policy", 90102);
		const noConsent = await w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: { signatureText: "Casey Example" } });
		c.eq("§6 no consent sent: 400 CONSENT_REQUIRED, nothing changed", [...answer(noConsent), archiveFiles(w).length, docRow(w.db, 90102, "mobile_policy").artifact_sha256],
			[400, "CONSENT_REQUIRED", 0, original.artifact_sha256]);
		const other = await w.call("POST", signUrl(90102, "mobile_policy"), { user: "robin", body: signBody("Robin Sample") });
		c.eq("§6 another driver can't sign it: 403", other.status, 403);
		const r = await w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody("Casey M. Example") });
		c.eq("§6 the fresh signature: 200 resigned", [r.status, r.body && r.body.resigned], [200, true]);
		const row = docRow(w.db, 90102, "mobile_policy");
		const files = archiveFiles(w);
		const archived = files.length === 1 ? fs.readFileSync(path.join(w.archiveDir, files[0])) : null;
		c.ok("§6 the original is in the evidence archive, byte for byte", archived !== null && archived.equals(oldBytes), files);
		c.eq("§6 ...its sha256 is the one the row recorded", archived && sha(archived), original.artifact_sha256);
		const newBytes = fileBytes(w, "mobile_policy", 90102);
		c.ok("§6 the live file is the fresh copy", Buffer.isBuffer(newBytes) && !newBytes.equals(oldBytes) && newBytes.includes("made-up fresh copy"));
		c.eq("§6 the row's digest and size are the fresh copy's, not the original's",
			[row.artifact_sha256, row.artifact_bytes, row.artifact_sha256 !== original.artifact_sha256], [newBytes && sha(newBytes), newBytes && newBytes.length, true]);
		c.eq("§6 the fresh evidence: signature, consent, browser, today's effective date, evidence version 1",
			[row.signed, row.signature_text, row.consent_agreed, row.consent_text, row.signed_user_agent, row.effective_date, row.evidence_version, row.signed_pdf_url],
			[1, "Casey M. Example", 1, CONSENT, NEW_AGENT, today(), 1, urlOf("mobile_policy", 90102)]);
		c.ok("§6 ...signed now, not at the original time", row.signed_at !== OLD.signedAt && Math.abs(Date.parse(row.signed_at) - Date.now()) < 60000, row.signed_at);
		c.eq("§6 the render was handed today's date and the fresh signature", w.render.calls.map((x) => [x.docKey, x.effectiveDate, x.signatureText]),
			[["mobile_policy", today(), "Casey M. Example"]]);
		c.eq("§6 the request is cleared", [row.resign_requested_at, row.resign_requested_by, row.resign_reason, row.resign_error], ["", "", "", ""]);
		const h = history(row);
		const entry = Array.isArray(h) && h.length === 1 ? h[0] : {};
		c.eq("§6 one history entry: the archived file, its sha256, why and who asked",
			[entry.kind, entry.file, entry.sha256, entry.bytes, entry.reason, entry.by],
			["fresh_signature", files[0], original.artifact_sha256, oldBytes && oldBytes.length, REASON, "sa.example"]);
		c.eq("§6 ...and the original's evidence word for word", entry.original, {
			signatureText: "Casey Example", signedAt: OLD.signedAt, signedIp: OLD.ip, signedIpSource: OLD.ipSource, userAgent: OLD.agent,
			consentAgreed: true, consentText: CONSENT, artifactSha256: original.artifact_sha256, artifactBytes: oldBytes && oldBytes.length,
			effectiveDate: OLD.effectiveDate, evidenceVersion: 1, signedPdfUrl: urlOf("mobile_policy", 90102),
		});
		c.eq("§6 the completion step never ran: no email, no Carrier sheet, no directory change", w.completion.length, 0);
		c.eq("§6 no staff alert and no further notice", [w.dispatchNotices.length, notices(w.db).length], [0, 1]);
		const a = auditRows(w.db).filter((x) => x.action === "fresh_signature");
		c.ok("§6 one audit row by the driver naming the archive and the reason",
			a.length === 1 && a[0].username === "casey.example" && a[0].details.includes(files[0]) && a[0].details.includes(REASON), a);
		const again = await w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
		c.eq("§6 a second signature now answers \"Already signed\"", [again.status, again.body && again.body.message], [200, "Already signed"]);
		const ev = await w.call("GET", "/api/admin/onboarding-evidence/driver/90102", { user: "sa" });
		const evDoc = ((ev.body && ev.body.documents) || []).find((d) => d.docKey === "mobile_policy") || {};
		const shown = [ev.status, evDoc.verdict, (evDoc.supersededArtifacts || []).length, (evDoc.supersededArtifacts || [{}])[0].original && evDoc.supersededArtifacts[0].original.signedIp];
		c.ok("§6 the evidence route shows the history, and the live file matches its digest",
			JSON.stringify(shown) === JSON.stringify([200, "match", 1, OLD.ip]), { shown, error: ev.body && ev.body.error });
	});
	await inWorld(c, "§6 grandfathered", { src, lib }, async (w) => {
		await w.call("POST", requestUrl(90102, "equipment_policy"), { user: "sa", body: { reason: REASON } });
		const r = await w.call("POST", signUrl(90102, "equipment_policy"), { user: "casey", body: signBody() });
		const row = docRow(w.db, 90102, "equipment_policy");
		const entry = (history(row) || [])[0] || {};
		c.eq("§6 a grandfathered original is archived and kept as history (evidence version 0, no digest)",
			[r.status, entry.sha256 === sha(originalBytes("equipment_policy", 90102)), entry.original && entry.original.evidenceVersion, entry.original && entry.original.artifactSha256, row.evidence_version],
			[200, true, 0, "", 1]);
	});
	await inWorld(c, "§6 contractor", { src, lib }, async (w) => {
		plantRequest(w.db, 90102, "contractor_agreement");
		w.db.exec("CREATE TABLE driver_payment_info (user_id INTEGER UNIQUE, bank_routing TEXT)");
		const before = evidenceOf(docRow(w.db, 90102, "contractor_agreement"));
		const r = await w.call("POST", signUrl(90102, "contractor_agreement"), { user: "casey", body: { ...signBody(), paymentInfo: { paymentMethod: "ach", bankRouting: "000000000" } } });
		c.eq("§6 a request planted on the contractor agreement: \"Already signed\", nothing changed, no bank details written",
			[r.status, r.body && r.body.message, JSON.stringify(evidenceOf(docRow(w.db, 90102, "contractor_agreement"))) === JSON.stringify(before),
				w.db.prepare("SELECT COUNT(*) AS n FROM driver_payment_info").get().n, w.render.calls.length],
			[200, "Already signed", true, 0, 0]);
	});
}

// ── §7 failures keep the original ─────────────────────────────────────────────
async function failureSection(c, { src = SRC, lib = realLib } = {}) {
	const scenario = async (label, setup, check) => inWorld(c, `§7 ${label}`, { src, lib }, async (w) => {
		await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: REASON } });
		const before = evidenceOf(docRow(w.db, 90102, "mobile_policy"));
		const oldBytes = fileBytes(w, "mobile_policy", 90102);
		const r = await setup(w);
		const row = docRow(w.db, 90102, "mobile_policy");
		const kept = evidenceOf(row);
		c.eq(`§7 ${label}: the evidence is as it was (no history entry)`, kept, before);
		c.ok(`§7 ${label}: the live file is the original, byte for byte`, Buffer.isBuffer(oldBytes) && oldBytes.equals(fileBytes(w, "mobile_policy", 90102) || Buffer.alloc(0)));
		c.eq(`§7 ${label}: the completion step never ran`, w.completion.length, 0);
		await check(w, r, row);
	});
	await scenario("a render that fails", async (w) => { w.render.mode = "throw"; return w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() }); },
		async (w, r, row) => {
			c.eq("§7 a render that fails: 503, retryable", [r.status, r.body && r.body.retryable], [503, true]);
			c.ok("§7 ...the driver is told the earlier copy stays", /earlier signed copy stays on file/.test(r.body && r.body.error), r.body);
			c.eq("§7 ...the request stays open, the failure recorded for staff", [row.resign_requested_at !== "", /DOCUMENT_RENDER_FAILED/.test(row.resign_error), row.resign_failed_at !== ""], [true, true, true]);
			const files = archiveFiles(w);
			const audit = auditRows(w.db).find((x) => x.action === "fresh_signature_failed");
			c.ok("§7 ...the archive copy made first is named in the audit row", files.length === 1 && !!audit && audit.details.includes(files[0]), [files, audit && audit.details]);
		});
	await scenario("a value cut off", async (w) => { w.render.mode = "cutoff"; return w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() }); },
		async (w, r) => {
			c.eq("§7 a value cut off: 503 DOCUMENT_FIELDS_UNFILLED, not retryable", [r.status, r.body && r.body.code, r.body && r.body.retryable], [503, "DOCUMENT_FIELDS_UNFILLED", false]);
			c.ok("§7 ...the driver is told it doesn't fit and the office can see it", /doesn't fit/.test(r.body && r.body.error) && /office can see this/.test(r.body && r.body.error), r.body);
		});
	await scenario("a write that fails after the file was written", async (w) => { w.render.mode = "tiny"; return w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() }); },
		async (w, r) => {
			c.eq("§7 a write that fails after the file was written: 503 DOCUMENT_STORE_FAILED", answer(r), [503, "DOCUMENT_STORE_FAILED"]);
			const audit = auditRows(w.db).find((x) => x.action === "fresh_signature_failed");
			c.ok("§7 ...the audit row says the live file was put back", !!audit && /put back from that copy/.test(audit.details), audit && audit.details);
		});
	await scenario("an archive that can't be made", async (w) => {
		fs.mkdirSync(path.dirname(w.archiveDir), { recursive: true });
		fs.writeFileSync(w.archiveDir, "made-up: a file where the archive folder should be");
		return w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
	}, async (w, r, row) => {
		c.eq("§7 an archive that can't be made: 503 ARCHIVE_FAILED, nothing rendered", [...answer(r), w.render.calls.length], [503, "ARCHIVE_FAILED", 0]);
		c.ok("§7 ...recorded for staff", /ARCHIVE_FAILED/.test(row.resign_error), row.resign_error);
	});
	await scenario("the request withdrawn while signing", async (w) => {
		let release;
		w.render.hold = new Promise((resolve) => { release = resolve; });
		const pending = w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
		c.ok("§7 ...the fresh signature starts rendering", await renderStarted(w));
		const cancelled = await w.call("POST", cancelUrl(90102, "mobile_policy"), { user: "sa" });
		c.eq("§7 ...the cancel mid-render answers 200", cancelled.status, 200);
		release();
		return pending;
	}, async (w, r, row) => {
		c.eq("§7 the request withdrawn while signing: 409 RESIGN_REQUEST_CHANGED", answer(r), [409, "RESIGN_REQUEST_CHANGED"]);
		c.eq("§7 ...the request stays withdrawn", row.resign_requested_at, "");
	});
	await scenario("a save that fails", async (w) => {
		w.db.exec("CREATE TRIGGER made_up_save_failure BEFORE UPDATE OF artifact_sha256 ON onboarding_documents BEGIN SELECT RAISE(ABORT, 'made-up save failure'); END;");
		return w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
	}, async (w, r, row) => {
		c.eq("§7 a save that fails: 503 RESIGN_SAVE_FAILED", answer(r), [503, "RESIGN_SAVE_FAILED"]);
		c.ok("§7 ...recorded for staff, the request still open", /RESIGN_SAVE_FAILED/.test(row.resign_error) && row.resign_requested_at !== "", row.resign_error);
	});
	await scenario("a second tap while the first is saving", async (w) => {
		let release;
		w.render.hold = new Promise((resolve) => { release = resolve; });
		const first = w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
		c.ok("§7 ...the first tap starts rendering", await renderStarted(w));
		// Raced, so a build that lets the second tap render too can't wait on the held first.
		const pending = w.call("POST", signUrl(90102, "mobile_policy"), { user: "casey", body: signBody() });
		const second = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
		w.secondTap = second || { status: 0, body: { code: "STILL_SAVING" } };
		// Both commits refused, so the common checks above can still see the original kept.
		w.db.exec("CREATE TRIGGER made_up_hold BEFORE UPDATE OF artifact_sha256 ON onboarding_documents BEGIN SELECT RAISE(ABORT, 'made-up: kept for this check'); END;");
		release();
		await pending;
		return first;
	}, async (w) => {
		c.eq("§7 a second tap while the first is saving: 409 RESIGN_IN_PROGRESS, retryable", [...answer(w.secondTap), w.secondTap.body && w.secondTap.body.retryable], [409, "RESIGN_IN_PROGRESS", true]);
		c.eq("§7 ...one render and one archive copy, not two", [w.render.calls.length, archiveFiles(w).length], [1, 1]);
	});
	await inWorld(c, "§7 missing original", { src, lib }, async (w) => {
		plantRequest(w.db, 90102, "substance_policy");
		const before = evidenceOf(docRow(w.db, 90102, "substance_policy"));
		const r = await w.call("POST", signUrl(90102, "substance_policy"), { user: "casey", body: signBody() });
		c.eq("§7 an original gone from disk at signing: 409 ORIGINAL_MISSING, nothing rendered or changed",
			[...answer(r), w.render.calls.length, JSON.stringify(evidenceOf(docRow(w.db, 90102, "substance_policy"))) === JSON.stringify(before)],
			[409, "ORIGINAL_MISSING", 0, true]);
	});
}

// ── §8 privacy ────────────────────────────────────────────────────────────────
async function privacySection(c, { src = SRC, lib = realLib } = {}) {
	await inWorld(c, "§8", { src, lib }, async (w) => {
		await w.call("POST", requestUrl(90102, "mobile_policy"), { user: "sa", body: { reason: REASON } });
		const secrets = [REASON, "sa.example", "resign_reason", "resign_requested_by", "resign_requested_at"];
		for (const who of ["casey", "dispatcher", "sa"]) {
			const r = await w.call("GET", "/api/onboarding/90102", { user: who });
			c.eq(`§8 GET /api/onboarding/:userId as ${who}: 200, no reason, requester or request columns`, [r.status, leaks(r.text, secrets)], [200, []]);
		}
		const disp = await w.call("GET", "/api/drivers-directory/501/documents", { user: "dispatcher" });
		c.eq("§8 the Drivers page for a Dispatcher: no request keys, no reason, no requester",
			[disp.status, "userId" in (disp.body || {}), leaks(disp.text, [REASON, "sa.example", "resign"])], [200, false, []]);
		if (!w.fns.stripSigningEvidence || !w.lib) { c.ok("§8 the driver's documents view exists", false); return; }
		const rows = w.db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? ORDER BY id").all(90102);
		const view = w.lib.driverDocs(rows, { enabled: true, strip: w.fns.stripSigningEvidence });
		c.eq("§8 the driver's documents: a yes for the requested policy, a no for the rest",
			Object.fromEntries(view.map((d) => [d.doc_key, d.resign_requested])),
			{ mobile_policy: true, equipment_policy: false, substance_policy: false, contractor_agreement: false, w9: false });
		c.eq("§8 ...and no reason, requester, request column or evidence", leaks(JSON.stringify(view), [...secrets, "resign_error", "signed_ip", "superseded_artifacts"]), []);
		plantRequest(w.db, 90102, "w9");
		const planted = w.lib.driverDocs(w.db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? ORDER BY id").all(90102), { enabled: true, strip: w.fns.stripSigningEvidence });
		c.eq("§8 a request planted on the W-9 is never offered to the driver", planted.find((d) => d.doc_key === "w9").resign_requested, false);
	});
}

// ── §9 the pin ────────────────────────────────────────────────────────────────
function pinSection(c, src = SRC, libText = LIB_TEXT) {
	for (const p of [REQUEST_HEAD, CANCEL_HEAD]) {
		const head = linesStarting(src, p)[0] || "";
		const at = (s) => head.indexOf(s);
		c.ok(`§9 ${p.split("/").pop().replace("\",", "")}: the gate, requireRole("Super Admin"), refuseCrossSite, then the limiter`,
			at("onboardingResignFlagGate") > 0 && at('requireRole("Super Admin")') > at("onboardingResignFlagGate")
			&& at("refuseCrossSite") > at('requireRole("Super Admin")') && at("onboardingResignLimiter") > at("refuseCrossSite"), head.slice(0, 200));
	}
	c.eq("§9 the flag: one read, on only for exactly \"true\"", linesStarting(src, "const ONBOARDING_RESIGN_ENABLED = "),
		['const ONBOARDING_RESIGN_ENABLED = process.env.ONBOARDING_RESIGN_ENABLED === "true";']);
	c.eq("§9 ...and nothing else reads it from the environment", (src.match(/process\.env\.ONBOARDING_RESIGN_ENABLED/g) || []).length, 1);
	const at = src.indexOf("\nconst onboardingResignLimiter = rateLimit({");
	const def = at < 0 ? "" : src.slice(at, src.indexOf("\n});", at));
	c.ok("§9 the limiter: 15 minutes, 30 requests, keyed per account", /windowMs: 15 \* 60 \* 1000,/.test(def) && /max: 30,/.test(def) && /`u:\$\{id\}`/.test(def), def.slice(0, 120));
	const emits = src.split("\n").filter((l) => l.includes('"onboarding-resign-requested"'));
	c.eq("§9 the live event: one emit, to driverRoom(), with the document key and the notice id",
		emits.map((l) => l.trim()), ['if (out.live) io.to(driverRoom(out.live.driverName)).emit("onboarding-resign-requested", { docKey: out.live.docKey, notificationId: out.live.noticeId });']);
	const code = libText.replace(/\/\/.*$/gm, "");
	c.eq("§9 lib/onboarding-resign.js exists and names no mailer, sheet, completion step, socket or network call",
		[code !== "", ...["sendEmail", "nodemailer", "syncDriverToCarrierSheet", "checkAndCompleteOnboarding", "sheets", "io.", "emit(", "fetch(", "http"].filter((x) => code.includes(x))], [true]);
	c.eq("§9 ...and requires node's path only", [...code.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]), ['"path"']);
	let sign = "";
	try { sign = liftRoute(src, lineStarting(src, SIGN_HEAD)); } catch { sign = ""; }
	const branch = sign.indexOf("onboardingResign.signAgain(");
	const complete = sign.indexOf("await checkAndCompleteOnboarding(");
	const ret = branch < 0 ? -1 : sign.indexOf("return res.status(out.status).json(out.body);", branch);
	c.ok("§9 the sign route: the fresh branch returns before the completion step", branch > 0 && ret > branch && complete > ret, { branch, ret, complete });
	c.ok("§9 ...and opens only when the flag is on and the document is requested",
		sign.includes("if (docRow.signed && !(ONBOARDING_RESIGN_ENABLED && onboardingResign.isRequested(docRow))) {"));
	c.ok("§9 the strip list carries the staff-only columns", /const SIGNING_EVIDENCE_COLUMNS = \[[^\]]*\.\.\.onboardingResign\.STAFF_ONLY_COLUMNS,\n\];/.test(src));
	c.ok("§9 the driver's payload goes through driverDocs() with the flag and the stripper",
		src.includes('? onboardingResign.driverDocs(db.prepare("SELECT * FROM onboarding_documents WHERE user_id = ? ORDER BY id").all(userId), { enabled: ONBOARDING_RESIGN_ENABLED, strip: stripSigningEvidence })'));
	c.ok("§9 the sign route names its file as the lib does", src.includes("const signedFileName = `${docKey}-${userId}-signed.pdf`;")
		&& realLib && realLib.signedFileName("mobile_policy", 7) === "mobile_policy-7-signed.pdf");
	c.eq("§9 the v1 scope: the three policies", realLib && realLib.RESIGN_DOC_KEYS, ["equipment_policy", "mobile_policy", "substance_policy"]);
}

// ── §10 mutants ───────────────────────────────────────────────────────────────
// `build` returns { src } (a server.js text) or { lib } (the lib's text); either
// must differ from the shipped one, and the section run on it must fail.
async function mutant(id, label, build, run) {
	let made = null;
	try { made = build(); } catch (err) {
		MAIN.ok(`§10 ${id}: ${label} — the mutation applies`, false, err.message);
		MAIN.ok(`§10 ${id}: ${label} — is caught`, false, "not evaluated");
		return;
	}
	const applied = (made.src !== undefined && made.src !== SRC) || (made.lib !== undefined && made.lib !== LIB_TEXT);
	MAIN.ok(`§10 ${id}: ${label} — the mutation applies`, applied);
	if (!applied) { MAIN.ok(`§10 ${id}: ${label} — is caught`, false, "not evaluated"); return; }
	const c = checker(false);
	const opts = { src: made.src !== undefined ? made.src : SRC, lib: made.lib !== undefined ? loadLib(made.lib) : realLib, libText: made.lib };
	try { await run(c, opts); } catch (err) { c.failed.push(`threw: ${err.message}`); }
	MAIN.ok(`§10 ${id}: ${label} — is caught (${c.failed.length} check(s) flip)`, c.failed.length > 0);
}

(async () => {
	if (!realLib) MAIN.ok("lib/onboarding-resign.js loads", false, LIB_TEXT ? "it threw" : "it is missing");
	console.log("\n§1 flag off");
	await flagOffSection(MAIN);
	console.log("\n§2 who may ask");
	await rolesSection(MAIN);
	console.log("\n§3 the request");
	await requestSection(MAIN);
	console.log("\n§4 the refusals");
	await refusalsSection(MAIN);
	console.log("\n§5 the cancel");
	await cancelSection(MAIN);
	console.log("\n§6 the fresh signature");
	await freshSection(MAIN);
	console.log("\n§7 failures keep the original");
	await failureSection(MAIN);
	console.log("\n§8 privacy");
	await privacySection(MAIN);
	console.log("\n§9 the pin");
	pinSection(MAIN);

	console.log("\n§10 mutants");
	await mutant("M1", "the archive taken after the new file is written", () => ({ lib: mutate(mutate(LIB_TEXT,
		"try { archived = deps.archiveSignedArtifact(signedPath); } catch { archived = null; }",
		"try { await deps.writeSignedArtifact({ render, signedPath, publicUrl, label }); archived = deps.archiveSignedArtifact(signedPath); } catch { archived = null; }"),
		"if (!archived || archived.sha256 !== original.sha) {", "if (!archived) {") }),
		(c, o) => freshSection(c, o));
	await mutant("M2", "the restore removed", () => ({ lib: mutate(LIB_TEXT, "\tconst restore = () => {\n\t\ttry {", "\tconst restore = () => {\n\t\treturn \"untouched\";\n\t\ttry {") }),
		(c, o) => failureSection(c, o));
	await mutant("M3", "Dispatcher added to the request route's roles", () => ({ src: mutate(SRC,
		'request-signature", onboardingResignFlagGate, requireRole("Super Admin"),', 'request-signature", onboardingResignFlagGate, requireRole("Super Admin", "Dispatcher"),') }),
		(c, o) => rolesSection(c, o));
	await mutant("M4", "the flag gate after the role check", () => ({ src: mutate(SRC,
		'request-signature", onboardingResignFlagGate, requireRole("Super Admin"),', 'request-signature", requireRole("Super Admin"), onboardingResignFlagGate,') }),
		(c, o) => flagOffSection(c, o));
	await mutant("M5", "the scope refusal removed", () => ({ lib: mutate(LIB_TEXT, "\tif (RESIGN_DOC_KEYS.includes(docKey)) return null;\n", "\treturn null;\n") }),
		(c, o) => refusalsSection(c, o));
	await mutant("M6", "the staff-only columns not stripped (server.js)", () => ({ src: mutate(SRC, "\t...onboardingResign.STAFF_ONLY_COLUMNS,\n", "") }),
		(c, o) => privacySection(c, o));
	await mutant("M7", "the driver's view not stripping (lib)", () => ({ lib: mutate(LIB_TEXT, "\t\tconst out = strip(r);\n", "\t\tconst out = { ...r };\n") }),
		(c, o) => privacySection(c, o));
	await mutant("M8", "the completion step called after a fresh signature", () => ({ src: mutate(SRC,
		"\t\t\treturn res.status(out.status).json(out.body);\n\t\t}\n\t\tlet artifact;",
		"\t\t\tawait checkAndCompleteOnboarding(userId, req);\n\t\t\treturn res.status(out.status).json(out.body);\n\t\t}\n\t\tlet artifact;") }),
		(c, o) => freshSection(c, o));
	await mutant("M9", "the sign route ignoring the flag", () => ({ src: mutate(SRC,
		"if (docRow.signed && !(ONBOARDING_RESIGN_ENABLED && onboardingResign.isRequested(docRow))) {", "if (docRow.signed && !onboardingResign.isRequested(docRow)) {") }),
		(c, o) => flagOffSection(c, o));
	await mutant("M10", "the reason check removed", () => ({ lib: mutate(LIB_TEXT, "\tif (Array.from(reason).length < REASON_MIN) {", "\tif (false) {") }),
		(c, o) => refusalsSection(c, o));
	await mutant("M11", "the request clearing `signed`", () => ({ lib: mutate(LIB_TEXT,
		"\"UPDATE onboarding_documents SET resign_requested_at = ?, resign_requested_by = ?, resign_reason = ?, resign_error = '', resign_failed_at = '' WHERE id = ?",
		"\"UPDATE onboarding_documents SET signed = 0, resign_requested_at = ?, resign_requested_by = ?, resign_reason = ?, resign_error = '', resign_failed_at = '' WHERE id = ?") }),
		(c, o) => requestSection(c, o));
	await mutant("M12", "the commit's re-check removed", () => ({ lib: mutate(LIB_TEXT,
		"\t\t\tif (!fresh || !fresh.signed || fresh.resign_requested_at !== requestedAt\n", "\t\t\tif (!fresh\n") }),
		(c, o) => failureSection(c, o));
	await mutant("M13", "the in-flight lock removed", () => ({ lib: mutate(LIB_TEXT,
		"\tif (inFlight.has(key)) return answer(409, \"RESIGN_IN_PROGRESS\", SIGNER_TEXT.IN_PROGRESS, { retryable: true });\n", "") }),
		(c, o) => failureSection(c, o));

	console.log(`\ntest-onboarding-resign: ${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		if (quietErrors.length) console.log(`server log (last 5): ${quietErrors.slice(-5).join(" | ")}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
