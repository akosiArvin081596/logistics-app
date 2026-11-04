#!/usr/bin/env node
/**
 * Owner-operators, onboarding (plan C PR 3): the application branch, acceptance
 * as an owner-operator, his document set and agreement, and the loads and
 * directory edits the app refuses him. lib/owner-operator-onboarding.js and the
 * server.js lines that call it, run as shipped.
 *
 *   §1 the module's pure rules: `as` on the acceptance, the document set, the
 *      welcome line, the category, a row save's new driver
 *   §2 the stand-in other runners pass (scripts/lib/oo-onboarding-env.js) gives
 *      the real module's answers over a database with no owner-operator
 *   §3 the renderer (review L1 of #686): with OWNER_OPERATOR_ONBOARDING_ENABLED
 *      off the agreement renders only for a caller passing the profile path; the
 *      statement never does; a value other than true opens nothing
 *   §4 the flag-off baseline: the same requests, with the flag off, answer and
 *      write as the base's server.js did (a fixture captured there with
 *      --capture, through scripts/lib/server-source.js); the
 *      application's truck section is never read; `as: "owner_operator"` is 404
 *   §5 the application and the Applications screen with the flag on: the
 *      section stored beside its application, the category, source and truck
 *      flags on the list, the section on the detail; GET /api/config/apply-options
 *   §6 acceptance as an owner-operator: the account, his document set, his
 *      profile, his truck (owner 0, Inactive), the link and the assignment in one
 *      transaction, nothing on a failure; NM1: a full 17-character VIN on any
 *      truck refuses with 409 OO_TRUCK_VIN_HELD, that truck and its driver
 *      untouched, a blank or short VIN never matches; no section 409
 *      OO_TRUCK_REQUIRED; already a company driver 409 OO_ACCEPTED_AS_DRIVER;
 *      the source; the audit row and the emails
 *   §7 the agreement: refused before his truck and terms (409
 *      OO_AGREEMENT_NOT_READY), refused on the draft text (S3), signed once ready
 *      with his figures and Schedule D saved, also with the flag off (plan M3);
 *      the preview; the readiness notice once; his signing step reads his set;
 *      a company driver's is unchanged
 *   §8 R2-M1: onboarding completion puts his truck in service on his completion
 *      day (business clock) unless a date is set, audited as a system change
 *   §9 G10: his directory row keeps its pay fields and carrier name for every
 *      role; a resend of the stored values goes through; a driver's is unchanged;
 *      his first row, added or renamed onto his name, takes the defaults and no carrier
 *  §10 G13 through the five routes that put a driver on a load (dispatch,
 *      reassign, the row editor, PUT /api/load/:loadId, POST /api/data): refused
 *      before he signs and after his end week, nothing written, audited; a
 *      company driver is untouched
 *  §11 source pins: server.js builds the module once, beside the owner-operator
 *      region; the flag is read only where the plan puts it
 *  §12 mutants, one per decision, each caught
 *
 * Made-up data only. No server, network or mail: express on 127.0.0.1, port 0,
 * over an in-memory SQLite built from server.js's own DDL.
 *
 *   node scripts/test-owner-operator-onboarding.js     # exits 1 on any failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const { serverSource } = require("./lib/server-source");
const { closure, indexDeclarations } = require("./lib/server-lift");
const SRC = serverSource();
const LIB_FILE = path.join(ROOT, "lib", "owner-operator-onboarding.js");
const RENDERER_FILE = path.join(ROOT, "lib", "policy-renderer.js");

let express;
let Database;
try {
	express = require("express");
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: a dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
	process.exit(1);
}

let realLib = null;
let libError = "";
try { realLib = require(LIB_FILE); } catch (e) { libError = e.code || e.message; }
const LIB_SRC = fs.existsSync(LIB_FILE) ? fs.readFileSync(LIB_FILE, "utf8") : "";
const AGREEMENT_TEXT = require(path.join(ROOT, "lib", "owner-operator-agreement-text.js")).OWNER_OPERATOR_AGREEMENT_TEXT;
// Counsel's final text, made up: the draft marker cleared, nothing else changed.
const FINAL_TEXT = Object.freeze({ ...AGREEMENT_TEXT, DRAFT_MARKER: "" });

// ── the runner ────────────────────────────────────────────────────────────────
function counter() {
	const c = { pass: 0, fail: [] };
	c.ok = (name, cond, detail) => { if (cond) c.pass++; else c.fail.push(detail ? `${name} (${detail})` : name); return !!cond; };
	c.eq = (name, actual, expected) => c.ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
	return c;
}
const MAIN = counter();
const QUIET = { log() {}, info() {}, warn() {}, error() {} };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oo-onboarding-"));

// Load a module from text at its own path (a mutant of a lib file).
function compileModule(file, text) {
	const m = new Module(file, module);
	m.filename = file;
	m.paths = Module._nodeModulePaths(path.dirname(file));
	m._compile(text, file);
	return m.exports;
}
function mutate(text, from, to) {
	const n = text.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 90)}`);
	return text.replace(from, () => to);
}

// ── the database: server.js's own CREATE and ALTER text ───────────────────────
function closeParen(s, open) {
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")") { depth--; if (depth === 0) return i; }
	}
	return -1;
}
function schemaStatements(src) {
	const out = [];
	const trucks = src.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!trucks) throw new Error("could not locate the trucks rebuild (CREATE TABLE trucks_new)");
	out.push(`CREATE TABLE trucks (${trucks[1]}\n)`);
	const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g;
	let m;
	while ((m = re.exec(src))) {
		const open = m.index + m[0].length - 1;
		const close = closeParen(src, open);
		if (close < 0) continue;
		const body = src.slice(open, close + 1);
		if (body.includes("${")) continue;
		out.push(`CREATE TABLE IF NOT EXISTS ${m[1]} ${body}`);
	}
	for (const a of src.matchAll(/ALTER TABLE (\w+) ADD COLUMN ([^"`;\n]+?)["`]/g)) out.push(`ALTER TABLE ${a[1]} ADD COLUMN ${a[2]}`);
	const ev = /for \(const t of \["onboarding_documents", "investor_onboarding_documents"\]\) \{\n\tfor \(const col of \[([\s\S]*?)\]\) \{/.exec(src);
	if (ev) for (const c of ev[1].matchAll(/"([a-z0-9_]+ [^"]*)"/g)) out.push(`ALTER TABLE onboarding_documents ADD COLUMN ${c[1]}`);
	for (const col of ["signed_pdf_url TEXT DEFAULT ''", "signing_error TEXT DEFAULT ''", "signing_failed_at TEXT DEFAULT ''"]) out.push(`ALTER TABLE onboarding_documents ADD COLUMN ${col}`);
	return out;
}
const SCHEMA = schemaStatements(SRC);
function freshDb() {
	const db = new Database(":memory:");
	for (const sql of SCHEMA) { try { db.exec(sql); } catch { /* a column already there, or a table this world does not use */ } }
	for (const t of ["users", "job_applications", "driver_onboarding", "onboarding_documents", "trucks", "truck_assignments", "notifications", "audit_trail", "drivers_directory", "driver_payment_info"]) {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) throw new Error(`table ${t} did not build from server.js's DDL`);
	}
	return db;
}

// ── the world: the shipped routes, lifted ─────────────────────────────────────
const HEADS = {
	apply: 'app.post("/api/public/apply", publicFormLimiter, (req, res) => {',
	applyOptions: 'app.get("/api/config/apply-options", (req, res) => {',
	list: 'app.get("/api/applications", requireRole("Super Admin"), (req, res) => {',
	detail: 'app.get("/api/applications/:id", requireRole("Super Admin"), (req, res) => {',
	status: 'app.put("/api/applications/:id/status", requireRole("Super Admin"), async (req, res) => {',
	onboarding: 'app.get("/api/onboarding/:userId", requireAuth, (req, res) => {',
	sign: 'app.post("/api/onboarding/:userId/documents/:docKey/sign", requireAuth, onboardingSignLimiter, async (req, res) => {',
	preview: 'app.get("/api/onboarding/documents/:docKey/pdf", requireAuth, onboardingPreviewLimiter, async (req, res) => {',
	directory: 'app.put("/api/drivers-directory/:id", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	directoryCreate: 'app.post("/api/drivers-directory", requireRole("Super Admin", "Dispatcher"), async (req, res) => {',
	userEdit: 'app.put("/api/users/:id", requireRole("Super Admin"), userPasswordResetLimiter, async (req, res) => {',
};
const PROVIDED = ["db", "app", "require", "console", "process", "sendEmail", "notifyChange", "io", "renderPolicy", "fillW9Form", "DATA_DIR",
	"ADMIN_NOTIFY_EMAIL", "OWNER_OPERATOR_ONBOARDING_ENABLED", "EMERGENCY_CONTACTS_ENABLED", "ONBOARDING_RESIGN_ENABLED",
	"publicFormLimiter", "onboardingSignLimiter", "onboardingPreviewLimiter", "userPasswordResetLimiter", "bcrypt", "getJobTrackingCached",
	"syncDriverToCarrierSheet", "accountDirectoryCarrier", "accountDirectoryRowJudged", "syncCarrierDriverHistory", "recordPayRateChanges", "Date",
	"getSheets", "SPREADSHEET_ID"];
const DENIED = ["server", "sheets", "getDrive", "transporter", "sheetsClient", "KEY_FILE", "jtCacheInvalidate"];
const ROOTS = ["checkAndCompleteOnboarding", "onboardingSigningStepState", "ONBOARDING_DOCS"];
const SESSIONS = {
	sa: { id: 1, username: "super_admin", role: "Super Admin" },
	disp: { id: 2, username: "dispatch_t", role: "Dispatcher" },
};
// Mon 2026-11-02 15:00 UTC: 10:00 on the business clock (US Eastern); the week of Sat 2026-10-31.
const NOW = Date.parse("2026-11-02T15:00:00.000Z");

const liftCache = new Map();
function lift(src) {
	if (!liftCache.has(src)) {
		const { decls } = indexDeclarations(src);
		const routes = Object.values(HEADS).filter((h) => src.includes(`\n${h}`));
		liftCache.set(src, closure(src, { roots: ROOTS.filter((n) => decls.has(n)), routes, provided: PROVIDED, denied: DENIED }));
	}
	return liftCache.get(src);
}

// `lib`: the onboarding module (a mutant's, or null for the old code); `text`: the
// agreement text its factory reads (FINAL_TEXT stands for counsel's text).
// `db`: another world's database, so a case can accept with the flag on and then
// work on with it off (the database is then left to its owner to close).
async function world({ src = SRC, flag = true, lib = realLib, text = AGREEMENT_TEXT, rendererLib = null, contacts = false, partnerRef = "QA-PARTNER-CODE", db: shared = null } = {}) {
	const db = shared || freshDb();
	const dataDir = fs.mkdtempSync(path.join(TMP, "w-"));
	const lifted = lift(src);
	const log = { mail: [], notified: [], renders: [], synced: [], pairings: [] };
	const app = express();
	app.use(express.json({ limit: "5mb" }));
	app.use((req, res, next) => {
		const raw = req.get("x-test-user");
		req.session = raw ? { user: SESSIONS[raw] || JSON.parse(raw) } : {};
		next();
	});
	const renderer = rendererLib || require(RENDERER_FILE);
	class FixedDate extends Date {
		constructor(...args) { super(...(args.length ? args : [NOW])); }
		static now() { return NOW; }
	}
	const shim = (m) => {
		if (m === "./lib/owner-operator-onboarding") {
			if (!lib) throw Object.assign(new Error("lib/owner-operator-onboarding.js is missing"), { code: "MODULE_NOT_FOUND" });
			// server.js's own factory call, with counsel's text standing in when a case asks.
			return { ...lib, createOwnerOperatorOnboarding: (deps) => lib.createOwnerOperatorOnboarding({ ...deps, agreementText: text }) };
		}
		return require(m.startsWith("./lib/") ? path.join(ROOT, m) : m);
	};
	const scope = {
		db, app, require: shim, console: QUIET,
		process: { env: { OWNER_OPERATOR_PARTNER_REF: partnerRef, APP_TIMEZONE: "America/New_York" }, argv: [], cwd: () => ROOT, on() {}, nextTick: process.nextTick, hrtime: process.hrtime, memoryUsage: process.memoryUsage },
		sendEmail: (to, subject, html) => { log.mail.push({ to, subject, html: String(html) }); return Promise.resolve(true); },
		notifyChange: (d) => log.notified.push(d),
		io: { to: () => ({ emit() {} }), emit() {} },
		// The renderer's stand-in: what it was asked for, checked by the shipped field
		// map (buildRenderFields) so a figure the agreement refuses fails here too.
		renderPolicy: async (docKey, data, options) => {
			log.renders.push({ docKey, data, options });
			renderer.buildRenderFields(docKey, data, options);
			return Buffer.concat([Buffer.from(`%PDF-1.7\n% made-up ${docKey}\n`), Buffer.alloc(2500, 0x20), Buffer.from("\n%%EOF\n")]);
		},
		fillW9Form: async () => Buffer.concat([Buffer.from("%PDF-1.7\n% made-up w9\n"), Buffer.alloc(2500, 0x20), Buffer.from("\n%%EOF\n")]),
		DATA_DIR: dataDir,
		ADMIN_NOTIFY_EMAIL: "admin@example.test",
		OWNER_OPERATOR_ONBOARDING_ENABLED: flag,
		EMERGENCY_CONTACTS_ENABLED: contacts,
		ONBOARDING_RESIGN_ENABLED: false,
		publicFormLimiter: (req, res, next) => next(),
		onboardingSignLimiter: (req, res, next) => next(),
		onboardingPreviewLimiter: (req, res, next) => next(),
		userPasswordResetLimiter: (req, res, next) => next(),
		bcrypt: { hash: async () => "made-up-hash", compare: async () => false },
		getJobTrackingCached: async () => ({ headers: [], data: [] }),
		syncDriverToCarrierSheet: (name, opts = {}) => log.synced.push({ name, action: opts.action, companyName: opts.companyName }),
		accountDirectoryCarrier: (name, company) => company,
		accountDirectoryRowJudged: () => true,
		// The carrier pairing the investor ledger reads (leg 3): recorded, so a refused write is seen writing none.
		syncCarrierDriverHistory: (rows, driverCol, carrierCol) => log.pairings.push(...rows.map((r) => [r[driverCol], r[carrierCol]])),
		recordPayRateChanges: () => {},
		Date: FixedDate,
		getSheets: async () => { throw new Error("no sheet in this world"); },
		SPREADSHEET_ID: "oo-onboarding-test-sheet",
	};
	const names = Object.keys(scope);
	const exported = ROOTS.filter((n) => lifted.names.includes(n));
	const has = (n) => lifted.names.includes(n);
	const fns = new Function(...names, `"use strict";\n${lifted.text}\nreturn { ${exported.join(", ")}${has("ooOnboarding") ? ", ooOnboarding" : ""} };`)(...names.map((n) => scope[n]));
	const server = http.createServer(app);
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const call = (method, url, { user = "sa", body, csrf = true } = {}) => new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const headers = {};
		if (user) headers["x-test-user"] = typeof user === "string" && SESSIONS[user] ? user : JSON.stringify(user);
		if (data !== null) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(data); }
		if (csrf && method !== "GET") headers["x-requested-with"] = "XMLHttpRequest";
		const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: url, headers }, (res) => {
			let t = "";
			res.setEncoding("latin1");
			res.on("data", (c) => { t += c; });
			res.on("end", () => { let json = null; try { json = JSON.parse(t); } catch { json = null; } resolve({ status: res.statusCode, body: json, text: t, type: res.headers["content-type"] || "" }); });
		});
		req.on("error", reject);
		if (data !== null) req.write(data);
		req.end();
	});
	const close = () => new Promise((r) => server.close(() => { if (!shared) db.close(); r(); }));
	return { db, call, close, log, fns, dataDir };
}
async function inWorld(c, label, opts, fn) {
	let w = null;
	try {
		w = await world(opts);
		await fn(w);
	} catch (err) {
		c.ok(`${label} ran`, false, `threw: ${err && (err.stack || err.message)}`.slice(0, 600));
	} finally {
		if (w) await w.close();
	}
}

// ── fixtures (made up) ────────────────────────────────────────────────────────
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n%QA-TEST\n").toString("base64")}`;
const TRUCK = {
	truck_year: "2019", truck_make: "Madeup", truck_model: "Hauler 9", truck_vin: "1MDEXP0VT00000001", truck_plate: "QA-1234",
	truck_plate_state: "TX", truck_unit: "", truck_ownership: "own", registered_owner: "Alex Example", business_name: "Example Hauling LLC",
};
let seq = 0;
function application(over = {}) {
	seq++;
	return {
		full_name: `Alex Example ${seq}`, email: `qa-oo-${seq}@example.com`, phone: `(555) 555-01${String(seq).padStart(2, "0")}`, dob: "1990-01-01",
		address: "1 QA Test Way, Testville, TX 77001", city: "Testville", state: "TX", zip: "77001", ssn: "123-45-6789", drivers_license: "QA-TEST-DL",
		position: "Owner Operator", experience: "5", has_cdl: "Yes", work_authorized: "Yes", felony_convicted: "No", accident_history: "No",
		skills: "", availability: ["Full-time"], reference_info: "[]", signature: "Alex Example", hazmat: "No",
		cdl_front: PDF, cdl_back: PDF, medical_card: PDF, owner_operator: TRUCK, ...over,
	};
}
const CONSENT = { agreed: true, text: "I agree to sign this document electronically." };
const signBody = (over = {}) => ({ signatureText: "Alex Example", signatureImage: PNG, consent: CONSENT, ...over });
const tableRows = (db, t) => { try { return db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(); } catch { return null; } };
const counts = (db) => Object.fromEntries(["users", "driver_onboarding", "onboarding_documents", "trucks", "truck_assignments", "owner_operators", "owner_operator_trucks", "carrier_driver_history"]
	.map((t) => [t, (tableRows(db, t) || []).length]));
const audits = (db) => db.prepare("SELECT action, entity, entity_id, details, username, role FROM audit_trail ORDER BY id").all();
const docsOf = (db, userId) => db.prepare("SELECT doc_key, doc_name, confidential FROM onboarding_documents WHERE user_id = ? ORDER BY id").all(userId);
const sessionOf = (db, userId) => ({ id: userId, username: db.prepare("SELECT username FROM users WHERE id = ?").get(userId).username, role: "Driver",
	driverName: db.prepare("SELECT driver_name FROM users WHERE id = ?").get(userId).driver_name });

// Apply (flag on), then accept as an owner-operator; answers the parts.
async function applyAndAccept(w, over = {}, acceptBody = { status: "Accepted", as: "owner_operator" }) {
	const a = await w.call("POST", "/api/public/apply", { user: null, body: application(over) });
	const appId = a.body && a.body.id;
	const r = await w.call("PUT", `/api/applications/${appId}/status`, { body: acceptBody });
	const userId = r.body && r.body.credentials ? r.body.credentials.userId : null;
	return { apply: a, appId, accept: r, userId };
}
function signAllBut(db, userId, keep) {
	db.prepare("UPDATE onboarding_documents SET signed = 1, signed_pdf_url = '/uploads/x.pdf' WHERE user_id = ? AND doc_key != ?").run(userId, keep);
}

// ── §1 the pure rules ─────────────────────────────────────────────────────────
function pureSection(c, L = realLib) {
	if (!L) return c.ok("§1 lib/owner-operator-onboarding.js loads", false, libError);
	const as = (body, status, on) => { const r = L.ooAcceptAs(body, status, on); return r.refusal ? `${r.refusal.status} ${r.refusal.body.code}` : String(r.ownerOperator); };
	c.eq("§1 `as` with the flag off: absent and \"company_driver\" are today's acceptance; \"owner_operator\" is 404; anything else is ignored",
		[as({}, "Accepted", false), as({ as: "company_driver" }, "Accepted", false), as({ as: "owner_operator" }, "Accepted", false), as({ as: "x" }, "Accepted", false), as({ as: "owner_operator" }, "Rejected", false)],
		["false", "false", "404 FEATURE_OFF", "false", "404 FEATURE_OFF"]);
	c.eq("§1 `as` with the flag on: \"owner_operator\" only with \"Accepted\"; an unknown value is 400",
		[as({}, "Accepted", true), as({ as: "company_driver" }, "Accepted", true), as({ as: "owner_operator" }, "Accepted", true), as({ as: "owner_operator" }, "Reviewed", true), as({ as: "OWNER_OPERATOR" }, "Accepted", true), as({ as: ["owner_operator"] }, "Accepted", true)],
		["false", "false", "true", "400 INVALID_ACCEPT_AS", "400 INVALID_ACCEPT_AS", "400 INVALID_ACCEPT_AS"]);
	const driverDocs = new Function(`return ${/\nconst ONBOARDING_DOCS = (\[[\s\S]*?\n\]);/.exec(SRC)[1]};`)();
	const ooDocs = L.ooOnboardingDocs(driverDocs);
	c.eq("§1 his set: the drivers' five with the owner-operator agreement (confidential) in the contractor agreement's place",
		ooDocs.map((d) => [d.key, d.confidential]), driverDocs.map((d) => (d.key === "contractor_agreement" ? ["owner_operator_agreement", 1] : [d.key, d.confidential])));
	c.ok("§1 ...no contractor agreement in it (its $300/day pay would contradict his agreement)", !ooDocs.some((d) => d.key === "contractor_agreement"));
	c.ok("§1 ...and a drivers' set with no contractor agreement is refused at boot", (() => { try { L.ooOnboardingDocs(driverDocs.filter((d) => d.key !== "contractor_agreement")); return false; } catch { return true; } })());
	c.eq("§1 the welcome email's line lists his set by count and name", L.ooWelcomeDocsText(ooDocs),
		"Sign 5 onboarding documents (Owner-Operator Agreement, Equipment Policy, W-9, Mobile Policy, Substance Policy)");
	c.eq("§1 ...the drivers' set and his have the same length, so the driver payload's totalDocs (ONBOARDING_DOCS.length) is right for both", ooDocs.length, driverDocs.length);
	c.eq("§1 the category: position \"Owner Operator\", trimmed and case-folded", ["Owner Operator", " owner OPERATOR ", "Company Driver", "Owner-Operator", null].map(L.ooApplicationCategory),
		["owner_operator", "owner_operator", "driver", "driver", "driver"]);
	const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
	const H = ["Load ID", "Driver", "Driver Notes"];
	c.eq("§1 a row save's new driver: the Driver column only, a respelling is no change, a cleared cell is none",
		[L.ooRowDriverChange(H, ["1", "", ""], ["1", "Alex Example", ""], norm), L.ooRowDriverChange(H, ["1", "Alex Example", ""], ["1", " alex  EXAMPLE ", ""], norm),
			L.ooRowDriverChange(H, ["1", "Alex Example", ""], ["1", "", ""], norm), L.ooRowDriverChange(H, ["1", "", ""], ["1", "", "Alex"], norm), L.ooRowDriverChange(["Load ID"], [], ["1"], norm)],
		["Alex Example", "", "", "", ""]);
	c.eq("§1 the company signer comes from the driver policies' own map (a name and a title, never blank)",
		[typeof L.companySigner().name, L.companySigner().name !== "", L.companySigner().title !== ""], ["string", true, true]);
}

// ── §2 the stand-in other runners use ─────────────────────────────────────────
function standInSection(c) {
	if (!realLib) return c.ok("§2 the module loads", false, libError);
	const { ooOnboardingEnv, ooOnboardingNoProfile, driverDocsFrom } = require("./lib/oo-onboarding-env");
	const db = freshDb();
	db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (7, 'qa-driver', 'x', 'Driver', 'Casey Example')").run();
	const real = ooOnboardingEnv(db, { src: SRC }).ooOnboarding;
	const stand = ooOnboardingNoProfile(driverDocsFrom(SRC));
	const res = () => { const out = { code: 0 }; return { out, res: { status(c2) { out.code = c2; return this; }, json() { return this; } } }; };
	const a = res();
	const b = res();
	const pairs = [
		["docsFor", real.docsFor(7), stand.docsFor(7)], ["docSet(false)", real.docSet(false), stand.docSet(false)],
		["hasProfile", real.hasProfile(7), stand.hasProfile(7)], ["profileForUser", real.profileForUser(7), stand.profileForUser(7)],
		["profileForDriverName", real.profileForDriverName("Casey Example"), stand.profileForDriverName("Casey Example")],
		["loadRefusal", real.loadRefusal("Casey Example"), stand.loadRefusal("Casey Example")],
		["refuseLoad", [real.refuseLoad({}, a.res, { driver: "Casey Example", via: "t" }), a.out.code], [stand.refuseLoad({}, b.res, { driver: "Casey Example", via: "t" }), b.out.code]],
		["directoryEditRefusal", real.directoryEditRefusal({ driver_name: "Casey Example", pay_type: "fixed" }, { pay_type: "percentage", carrier_name: "Other" }), stand.directoryEditRefusal({ driver_name: "Casey Example" }, {})],
		["directoryEditRefusal (a rename)", real.directoryEditRefusal({ driver_name: "Sam Other", pay_type: "fixed" }, { driver_name: "Casey Example", pay_type: "percentage", carrier_name: "Other" }, { pay_type: "fixed", carrier_name: "" }),
			stand.directoryEditRefusal({ driver_name: "Sam Other" }, { driver_name: "Casey Example" }, {})],
		["directoryCreateRefusal", real.directoryCreateRefusal({ driver_name: "Casey Example", carrier_name: "Other", pay_type: "fixed" }, { pay_type: "fixed", carrier_name: "" }), stand.directoryCreateRefusal({ driver_name: "Casey Example" }, {})],
		["accountCompanyRefusal", real.accountCompanyRefusal({ id: 7, driver_name: "Casey Example" }, true), stand.accountCompanyRefusal({ id: 7 }, true)],
		["setInServiceOnCompletion", real.setInServiceOnCompletion(7, "2026-11-02T15:00:00.000Z"), stand.setInServiceOnCompletion(7, "2026-11-02T15:00:00.000Z")],
		["notifyAgreementReady", real.notifyAgreementReady(7), stand.notifyAgreementReady(7)],
		["sweepAgreementReadyNotices", real.sweepAgreementReadyNotices(), stand.sweepAgreementReadyNotices()],
		["agreementState", real.agreementState(7), stand.agreementState(7)],
		["agreementSigned", real.agreementSigned(7), stand.agreementSigned(7)],
	];
	for (const [name, x, y] of pairs) c.eq(`§2 with no owner-operator, the stand-in answers ${name} as the module does`, x, y);
	c.eq("§2 ...and the stand-in has every method the module has that server.js calls", Object.keys(stand).filter((k) => typeof real[k] !== "function"), []);
}

// ── §3 the renderer's flag gate and the profile path ──────────────────────────
function rendererSection(c, renderer = require(RENDERER_FILE)) {
	const saved = process.env.OWNER_OPERATOR_ONBOARDING_ENABLED;
	const savedS = process.env.OWNER_OPERATOR_SETTLEMENTS_ENABLED;
	const opens = (doc, options) => { try { renderer.prepareTemplateHtml(doc, {}, options); renderer.buildRenderFields(doc, {}, options); return true; } catch (e) { return /Unknown onboarding doc/.test(e.message) ? false : `threw ${e.message}`; } };
	try {
		delete process.env.OWNER_OPERATOR_ONBOARDING_ENABLED;
		delete process.env.OWNER_OPERATOR_SETTLEMENTS_ENABLED;
		c.eq("§3 flag off: the agreement is unknown to any caller without the profile path", opens("owner_operator_agreement"), false);
		c.eq("§3 flag off: ...and opens for the server's profile path (an existing owner-operator, plan M3; review L1)", opens("owner_operator_agreement", { ownerOperatorProfile: true }), true);
		c.eq("§3 flag off: only exactly true opens it", [opens("owner_operator_agreement", { ownerOperatorProfile: "true" }), opens("owner_operator_agreement", { ownerOperatorProfile: 1 }), opens("owner_operator_agreement", null)], [false, false, false]);
		c.eq("§3 flags off: the statement never opens through the profile path", opens("owner_operator_settlement", { ownerOperatorProfile: true }), false);
		c.eq("§3 a driver document is unaffected by the option", [opens("mobile_policy"), opens("mobile_policy", { ownerOperatorProfile: true })], [true, true]);
		process.env.OWNER_OPERATOR_ONBOARDING_ENABLED = "true";
		c.eq("§3 flag on: the agreement opens for any caller, as in #686", opens("owner_operator_agreement"), true);
	} finally {
		if (saved === undefined) delete process.env.OWNER_OPERATOR_ONBOARDING_ENABLED; else process.env.OWNER_OPERATOR_ONBOARDING_ENABLED = saved;
		if (savedS === undefined) delete process.env.OWNER_OPERATOR_SETTLEMENTS_ENABLED; else process.env.OWNER_OPERATOR_SETTLEMENTS_ENABLED = savedS;
	}
}

// ── §4 the flag-off baseline: the base's answers (a fixture) against this code ──
// Captured on the base's own server.js, read through scripts/lib/server-source.js:
//   SERVER_ROOT=<a checkout of the base> node scripts/test-owner-operator-onboarding.js --capture=<file>
const FIXTURE = path.join(__dirname, "fixtures", "owner-operator-onboarding-flag-off.json");
const CAPTURE = (process.argv.find((a) => a.startsWith("--capture=")) || "").slice("--capture=".length);
// The stamps SQLite writes itself (CURRENT_TIMESTAMP), which the fixed Date can't
// reach: dropped at any depth, so two worlds a second apart still compare equal.
const CLOCK_FIELDS = new Set(["created_at", "updated_at", "signed_at", "timestamp", "signing_failed_at", "submitted_at", "onboarded_at", "deleted_at"]);
function dropClock(v) {
	if (Array.isArray(v)) return v.map(dropClock);
	if (!v || typeof v !== "object") return v;
	return Object.fromEntries(Object.entries(v).filter(([k]) => !CLOCK_FIELDS.has(k)).map(([k, x]) => [k, dropClock(x)]));
}
// One script of requests, the same on both sides; what each answers and every
// table it touches afterwards, with the clock and the made-up hash fixed.
async function baselineScript(w) {
	const out = [];
	const keep = (r) => ({ status: r.status, body: dropClock(r.body) });
	const company = await w.call("POST", "/api/public/apply", { user: null, body: application({ position: "Company Driver", owner_operator: undefined }) });
	const ooPos = await w.call("POST", "/api/public/apply", { user: null, body: application() });
	out.push(keep(company), keep(ooPos));
	out.push(keep(await w.call("GET", "/api/applications")));
	out.push(keep(await w.call("GET", `/api/applications/${ooPos.body.id}`)));
	const acc = await w.call("PUT", `/api/applications/${company.body.id}/status`, { body: { status: "Accepted" } });
	if (acc.body && acc.body.credentials) acc.body.credentials.tempPassword = "(random)";
	out.push(keep(acc));
	out.push(keep(await w.call("PUT", `/api/applications/${ooPos.body.id}/status`, { body: { status: "Reviewed" } })));
	const userId = acc.body && acc.body.credentials ? acc.body.credentials.userId : 0;
	const me = userId ? sessionOf(w.db, userId) : null;
	out.push(keep(await w.call("GET", `/api/onboarding/${userId}`, { user: me })));
	const signed = await w.call("POST", `/api/onboarding/${userId}/documents/mobile_policy/sign`, { user: me, body: signBody() });
	out.push({ status: signed.status, success: signed.body && signed.body.success });
	out.push(keep(await w.call("POST", `/api/onboarding/${userId}/documents/contractor_agreement/sign`, { user: me, body: signBody({ paymentInfo: { paymentMethod: "check", checkName: "Alex Example" } }) })).status);
	const preview = await w.call("GET", "/api/onboarding/documents/equipment_policy/pdf", { user: me });
	out.push(preview.status, preview.type);
	for (const t of ["job_applications", "users", "driver_onboarding", "onboarding_documents", "driver_payment_info", "trucks", "truck_assignments", "notifications"]) out.push([t, dropClock(tableRows(w.db, t) || [])]);
	out.push(["audit", audits(w.db).map((a) => [a.action, a.entity, a.details.replace(/created account "[^"]+"/, "")])]);
	out.push(["mail", w.log.mail.map((m) => [m.to, m.subject, m.html.replace(/>[0-9a-f]{8}</g, ">(pw)<")])]);
	return out;
}
async function baselineSection(c) {
	let a = null;
	let b = null;
	try { a = JSON.parse(fs.readFileSync(FIXTURE, "utf8")).answers; } catch { a = null; }
	c.ok("§4 the base's flag-off answers are on file (scripts/fixtures/owner-operator-onboarding-flag-off.json)", Array.isArray(a));
	seq = 1000;
	await inWorld(c, "§4 this code", { src: SRC, flag: false }, async (w) => {
		b = await baselineScript(w);
		c.eq("§4 flag off: no owner-operator row of any kind was written", ["owner_operator_applications", "owner_operators", "owner_operator_trucks"].map((t) => (tableRows(w.db, t) || []).length), [0, 0, 0]);
		const app2 = await w.call("POST", "/api/public/apply", { user: null, body: application() });
		const r = await w.call("PUT", `/api/applications/${app2.body.id}/status`, { body: { status: "Accepted", as: "owner_operator" } });
		c.eq("§4 flag off: accept as owner-operator answers 404 FEATURE_OFF", [r.status, r.body && r.body.code], [404, "FEATURE_OFF"]);
		c.eq("§4 ...and writes nothing (no account, the application still New)", [(w.db.prepare("SELECT status FROM job_applications WHERE id = ?").get(app2.body.id) || {}).status, w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE driver_name = ?").get(application().full_name).n], ["New", 0]);
		const opt = await w.call("GET", "/api/config/apply-options", { user: null });
		c.eq("§4 flag off: GET /api/config/apply-options answers { ownerOperator: false }, no session needed", [opt.status, opt.body], [200, { ownerOperator: false }]);
	});
	if (a && b) {
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const label = Array.isArray(a[i]) && typeof a[i][0] === "string" ? a[i][0] : `answer ${i + 1}`;
			c.eq(`§4 flag off: ${label} the same on the base's server.js and this one`, b[i], a[i]);
		}
	}
}

// ── §5 the application and the Applications screen, flag on ───────────────────
async function applicationSection(c, opts = {}) {
	await inWorld(c, "§5", { flag: true, ...opts }, async (w) => {
		const opt = await w.call("GET", "/api/config/apply-options", { user: null });
		c.eq("§5 GET /api/config/apply-options with the flag on: { ownerOperator: true }", [opt.status, opt.body], [200, { ownerOperator: true }]);
		const oo = await w.call("POST", "/api/public/apply", { user: null, body: application({ owner_operator: { ...TRUCK, referral_code: "QA-PARTNER-CODE" } }) });
		const plain = await w.call("POST", "/api/public/apply", { user: null, body: application({ position: "Owner Operator", owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000002" } }) });
		const driver = await w.call("POST", "/api/public/apply", { user: null, body: application({ position: "Company Driver" }) });
		c.ok("§5 the three applications are stored", [oo, plain, driver].every((r) => r.status === 200), JSON.stringify([oo.body, plain.body, driver.body]));
		// An older Owner Operator application with no section (made before the flag).
		const legacy = Number(w.db.prepare("INSERT INTO job_applications (full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl, work_authorized, felony_convicted, accident_history, skills, signature) VALUES ('Jordan Example', 'qa-legacy@example.com', '5', '1990-01-01', 'x', '123-45-6789', 'x', 'Owner Operator', '5', 'Yes', 'Yes', 'No', 'No', '', 'x')").run().lastInsertRowid);
		const list = await w.call("GET", "/api/applications");
		const byId = Object.fromEntries((list.body || []).map((x) => [x.id, x]));
		const pick = (x) => (x ? [x.category, x.oo_truck, x.oo_source, x.oo_accepted] : null);
		c.eq("§5 the list: category, truck section, source and accepted-as-owner-operator from the server",
			[pick(byId[oo.body.id]), pick(byId[plain.body.id]), pick(byId[driver.body.id]), pick(byId[legacy])],
			[["owner_operator", true, "partner", false], ["owner_operator", true, "direct", false], ["driver", false, "", false], ["owner_operator", false, "", false]]);
		c.ok("§5 the list still carries no SSN", (list.body || []).every((x) => !("ssn" in x)));
		const d = await w.call("GET", `/api/applications/${oo.body.id}`);
		c.eq("§5 the detail: the section and its source", d.body && d.body.owner_operator && [d.body.category, d.body.owner_operator.truck_vin, d.body.owner_operator.truck_ownership, d.body.owner_operator.registered_owner, d.body.owner_operator.source],
			["owner_operator", "1MDEXP0VT00000001", "own", "Alex Example", "partner"]);
		const dl = await w.call("GET", `/api/applications/${legacy}`);
		c.eq("§5 an older Owner Operator application: category owner_operator, no section", [dl.body.category, dl.body.owner_operator], ["owner_operator", null]);
		const dDisp = await w.call("GET", `/api/applications/${oo.body.id}`, { user: "disp" });
		c.eq("§5 a Dispatcher still gets 403 on the detail", dDisp.status, 403);
	});
}

// ── §6 acceptance ─────────────────────────────────────────────────────────────
async function acceptanceSection(c, opts = {}) {
	await inWorld(c, "§6 accepted", { flag: true, ...opts }, async (w) => {
		const before = counts(w.db);
		const { appId, accept, userId } = await applyAndAccept(w);
		c.eq("§6 accept as owner-operator: 200, account created, his truck and source named", [accept.status, accept.body && accept.body.accountCreated, accept.body && accept.body.ownerOperator],
			[200, true, { truckUnit: `OO-${appId}-A`, source: "direct" }]);
		const after = counts(w.db);
		c.eq("§6 ...one account, one onboarding row, his five documents, one truck, one profile, one link, one assignment, no carrier pairing",
			Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]])),
			{ users: 1, driver_onboarding: 1, onboarding_documents: 5, trucks: 1, truck_assignments: 1, owner_operators: 1, owner_operator_trucks: 1, carrier_driver_history: 0 });
		c.eq("§6 ...his documents are his set: the agreement (confidential) in place of the contractor agreement",
			docsOf(w.db, userId).map((d) => [d.doc_key, d.confidential]),
			[["owner_operator_agreement", 1], ["equipment_policy", 0], ["w9", 1], ["mobile_policy", 0], ["substance_policy", 0]]);
		const truck = w.db.prepare("SELECT * FROM trucks WHERE unit_number = ?").get(`OO-${appId}-A`) || {};
		c.eq("§6 ...the truck from his section: owner 0, Inactive, no in-service date, his VIN, plate, year, make and model, driven by him",
			[truck.owner_id, truck.status, truck.in_service_date || "", truck.vin, truck.license_plate, truck.year, truck.make, truck.model, truck.assigned_driver],
			[0, "Inactive", "", "1MDEXP0VT00000001", "QA-1234", 2019, "Madeup", "Hauler 9", accept.body.credentials.driverName]);
		const profile = w.db.prepare("SELECT * FROM owner_operators WHERE user_id = ?").get(userId) || {};
		c.eq("§6 ...his profile: onboarding, the default terms (18%, $2,500 / $500), installment unset, his application and business name",
			[profile.status, profile.fee_bps, profile.escrow_target_cents, profile.escrow_weekly_cents, profile.installment_cents, profile.application_id, profile.business_name, profile.source, profile.end_week_start, profile.created_by],
			["onboarding", 1800, 250000, 50000, 0, appId, "Example Hauling LLC", "direct", "", "super_admin"]);
		const link = w.db.prepare("SELECT * FROM owner_operator_trucks WHERE oo_id = ?").get(profile.id) || {};
		c.eq("§6 ...the link: his truck, from this week's Saturday (business clock), open", [link.truck_id, link.start_week_start, link.end_week_start], [truck.id, "2026-10-31", ""]);
		const assign = w.db.prepare("SELECT * FROM truck_assignments WHERE truck_id = ?").get(truck.id) || {};
		c.eq("§6 ...the assignment: him, open", [assign.driver_name, assign.end_date], [accept.body.credentials.driverName, ""]);
		const rows = audits(w.db).filter((a) => /accept/.test(a.action));
		c.ok("§6 ...one audit row naming the owner-operator, his truck and the source", rows.length === 1 && rows[0].action === "accept_owner_operator" &&
			rows[0].details.includes(`OO-${appId}-A`) && rows[0].details.includes("source direct"), JSON.stringify(rows));
		const welcome = w.log.mail.find((m) => /Welcome/.test(m.subject));
		c.ok("§6 ...the welcome email lists his set, never the contractor agreement", !!welcome && welcome.html.includes("Owner-Operator Agreement") && !welcome.html.includes("Contractor Agreement"));
		const admin = w.log.mail.find((m) => m.to === "admin@example.test" && /Accepted/.test(m.subject));
		c.ok("§6 ...the admin email says he was accepted as an owner-operator, with his truck", !!admin && admin.html.includes(`Owner-operator, truck OO-${appId}-A`));
		const again = await w.call("PUT", `/api/applications/${appId}/status`, { body: { status: "Accepted", as: "owner_operator" } });
		c.eq("§6 re-accepting answers \"already exists\" and writes nothing", [again.status, again.body && again.body.message, JSON.stringify(counts(w.db)) === JSON.stringify(after)], [200, "Application accepted (account already exists)", true]);
	});
	await inWorld(c, "§6 partner and source", { flag: true, ...opts }, async (w) => {
		const p = await applyAndAccept(w, { owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000011", referral_code: "QA-PARTNER-CODE" } });
		c.eq("§6 the source the application carries is the default", p.accept.body && p.accept.body.ownerOperator && p.accept.body.ownerOperator.source, "partner");
		const q = await applyAndAccept(w, { owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000012", referral_code: "QA-PARTNER-CODE" } }, { status: "Accepted", as: "owner_operator", source: "direct" });
		c.eq("§6 the Super Admin's acceptance corrects it", (w.db.prepare("SELECT source FROM owner_operators WHERE user_id = ?").get(q.userId) || {}).source, "direct");
		const bad = await applyAndAccept(w, { owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000013" } }, { status: "Accepted", as: "owner_operator", source: "someone" });
		c.eq("§6 an unknown source is 400 OO_SOURCE_INVALID, nothing written", [bad.accept.status, bad.accept.body && bad.accept.body.code, bad.userId], [400, "OO_SOURCE_INVALID", null]);
	});
	await inWorld(c, "§6 NM1", { flag: true, ...opts }, async (w) => {
		// A company truck with the same VIN, driven by a company driver.
		w.db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (50, 'qa-company', 'x', 'Driver', 'Sam Company')").run();
		const tid = Number(w.db.prepare("INSERT INTO trucks (unit_number, vin, owner_id, status, assigned_driver) VALUES ('QA-CO-1', '1mdexp0vt00000099', 0, 'Active', 'Sam Company')").run().lastInsertRowid);
		w.db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, 'Sam Company', '2026-10-01T12:00:00.000Z')").run(tid);
		const truckBefore = JSON.stringify(w.db.prepare("SELECT * FROM trucks WHERE id = ?").get(tid));
		const assignBefore = JSON.stringify(tableRows(w.db, "truck_assignments"));
		const before = counts(w.db);
		const held = await applyAndAccept(w, { owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000099" } });
		c.eq("§6 NM1: a full VIN on a company truck: 409 OO_TRUCK_VIN_HELD", [held.accept.status, held.accept.body && held.accept.body.code], [409, "OO_TRUCK_VIN_HELD"]);
		c.ok("§6 NM1: ...nothing written, the application still New", JSON.stringify(counts(w.db)) === JSON.stringify(before) && (w.db.prepare("SELECT status FROM job_applications WHERE id = ?").get(held.appId) || {}).status === "New");
		c.ok("§6 NM1: ...the company truck and its driver untouched", JSON.stringify(w.db.prepare("SELECT * FROM trucks WHERE id = ?").get(tid)) === truckBefore && JSON.stringify(tableRows(w.db, "truck_assignments")) === assignBefore);
		c.ok("§6 NM1: ...the refusal audited, naming the truck held", audits(w.db).some((a) => a.action === "accept_application_blocked" && a.details.includes(`truck ${tid}`) && a.details.includes("[OO_TRUCK_VIN_HELD]")));
		// An investor's truck holds it too.
		w.db.prepare("INSERT INTO trucks (unit_number, vin, owner_id, status) VALUES ('QA-INV-1', '1MDEXP0VT00000098', 77, 'Active')").run();
		const inv = await applyAndAccept(w, { owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000098" } });
		c.eq("§6 NM1: a full VIN on an investor's truck: 409 OO_TRUCK_VIN_HELD", inv.accept.body && inv.accept.body.code, "OO_TRUCK_VIN_HELD");
		// Blank and short VINs never match.
		w.db.prepare("INSERT INTO trucks (unit_number, vin, owner_id, status) VALUES ('QA-CO-2', '', 0, 'Active')").run();
		w.db.prepare("INSERT INTO trucks (unit_number, vin, owner_id, status) VALUES ('QA-CO-3', 'SHORT1', 0, 'Active')").run();
		const short = await applyAndAccept(w, { owner_operator: { ...TRUCK, truck_vin: "SHORT1" } });
		c.eq("§6 NM1: a short VIN equal to a truck's is never matched: accepted with a new truck", [short.accept.status, !!(w.db.prepare("SELECT 1 FROM trucks WHERE unit_number = ?").get(`OO-${short.appId}-A`))], [200, true]);
		// The unit number already taken.
		const app3 = await w.call("POST", "/api/public/apply", { user: null, body: application({ owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000097" } }) });
		w.db.prepare("INSERT INTO trucks (unit_number, owner_id, status) VALUES (?, 0, 'Active')").run(`oo-${app3.body.id}-a`);
		const taken = await w.call("PUT", `/api/applications/${app3.body.id}/status`, { body: { status: "Accepted", as: "owner_operator" } });
		c.eq("§6 his unit number already on a truck (any case): 409 OO_TRUCK_UNIT_TAKEN", [taken.status, taken.body && taken.body.code], [409, "OO_TRUCK_UNIT_TAKEN"]);
	});
	await inWorld(c, "§6 refusals", { flag: true, ...opts }, async (w) => {
		const legacy = Number(w.db.prepare("INSERT INTO job_applications (full_name, email, phone, dob, address, ssn, drivers_license, position, experience, has_cdl, work_authorized, felony_convicted, accident_history, skills, signature) VALUES ('Jordan Example', 'qa-legacy@example.com', '5550109', '1990-01-01', 'x', '123-45-6789', 'x', 'Owner Operator', '5', 'Yes', 'Yes', 'No', 'No', '', 'x')").run().lastInsertRowid);
		const before = counts(w.db);
		const r = await w.call("PUT", `/api/applications/${legacy}/status`, { body: { status: "Accepted", as: "owner_operator" } });
		c.eq("§6 no truck section: 409 OO_TRUCK_REQUIRED, nothing written", [r.status, r.body && r.body.code, JSON.stringify(counts(w.db)) === JSON.stringify(before)], [409, "OO_TRUCK_REQUIRED", true]);
		const asDriver = await w.call("PUT", `/api/applications/${legacy}/status`, { body: { status: "Accepted", as: "company_driver" } });
		const docs = asDriver.body && asDriver.body.credentials ? docsOf(w.db, asDriver.body.credentials.userId).map((d) => d.doc_key) : [];
		c.ok("§6 ...he can still be accepted as a company driver: the drivers' set, no profile, no truck", asDriver.status === 200 && docs.includes("contractor_agreement") && !docs.includes("owner_operator_agreement") &&
			(tableRows(w.db, "owner_operators") || []).length === 0);
		const conv = await w.call("PUT", `/api/applications/${legacy}/status`, { body: { status: "Accepted", as: "owner_operator" } });
		c.eq("§6 accepting a company driver's application again as an owner-operator: 409 OO_ACCEPTED_AS_DRIVER", [conv.status, conv.body && conv.body.code], [409, "OO_ACCEPTED_AS_DRIVER"]);
		const rej = await w.call("PUT", `/api/applications/${legacy}/status`, { body: { status: "Rejected", as: "owner_operator" } });
		c.eq("§6 `as` with any other status: 400 INVALID_ACCEPT_AS", [rej.status, rej.body && rej.body.code], [400, "INVALID_ACCEPT_AS"]);
	});
	await inWorld(c, "§6 one transaction", { flag: true, ...opts }, async (w) => {
		const a = await w.call("POST", "/api/public/apply", { user: null, body: application({ owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000021" } }) });
		w.db.exec("DROP TABLE truck_assignments");
		const before = counts(w.db);
		const r = await w.call("PUT", `/api/applications/${a.body.id}/status`, { body: { status: "Accepted", as: "owner_operator" } });
		c.ok("§6 a write that fails part-way (the assignment) leaves nothing: no account, document, truck, profile or link, the application still New",
			r.status === 500 && JSON.stringify(counts(w.db)) === JSON.stringify(before) && (w.db.prepare("SELECT status FROM job_applications WHERE id = ?").get(a.body.id) || {}).status === "New",
			`${r.status} ${JSON.stringify(counts(w.db))} vs ${JSON.stringify(before)}`);
	});
	await inWorld(c, "§6 company driver, flag on", { flag: true, ...opts }, async (w) => {
		const a = await w.call("POST", "/api/public/apply", { user: null, body: application() });
		const r = await w.call("PUT", `/api/applications/${a.body.id}/status`, { body: { status: "Accepted" } });
		c.ok("§6 flag on, an Owner Operator application accepted with no `as`: a company driver, as today (the position alone decides nothing)",
			r.status === 200 && !r.body.ownerOperator && docsOf(w.db, r.body.credentials.userId).some((d) => d.doc_key === "contractor_agreement") && (tableRows(w.db, "owner_operators") || []).length === 0);
	});
}

// ── §7 the agreement ──────────────────────────────────────────────────────────
async function agreementSection(c, opts = {}) {
	// The draft text: no one signs it (S3, review L2 of #686).
	await inWorld(c, "§7 draft", { flag: true, ...opts }, async (w) => {
		const { userId } = await applyAndAccept(w);
		const me = sessionOf(w.db, userId);
		const r = await w.call("POST", `/api/onboarding/${userId}/documents/owner_operator_agreement/sign`, { user: me, body: signBody({ paymentInfo: { paymentMethod: "check", checkName: "Alex Example" } }) });
		c.eq("§7 the draft agreement: 409 OO_AGREEMENT_NOT_READY naming the draft", [r.status, r.body && r.body.code, r.body && r.body.missing], [409, "OO_AGREEMENT_NOT_READY", ["draft"]]);
		c.eq("§7 ...the driver reads why in plain words", r.body && r.body.error, "LogisX is still setting up your agreement. We'll let you know here when it's ready to sign.");
		const row = w.db.prepare("SELECT signed, signature_text, consent_agreed FROM onboarding_documents WHERE user_id = ? AND doc_key = 'owner_operator_agreement'").get(userId);
		c.eq("§7 ...nothing written: unsigned, no evidence, no bank details, no render", [row.signed, row.signature_text || "", row.consent_agreed || 0, (tableRows(w.db, "driver_payment_info") || []).length, w.log.renders.length], [0, "", 0, 0, 0]);
		c.eq("§7 ...and no readiness notice on the draft", w.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'oo_agreement_ready'").get().n, 0);
		// Counsel's text arrives by a deploy: the start-up sweep tells him, once.
		const later = await world({ flag: true, text: FINAL_TEXT, ...opts, db: w.db });
		try {
			c.eq("§7 counsel's text deployed later: the start-up sweep sends his notice, once", [later.fns.ooOnboarding.sweepAgreementReadyNotices(), later.fns.ooOnboarding.sweepAgreementReadyNotices()], [1, 0]);
		} finally { await later.close(); }
	});
	for (const flag of [true, false]) {
		await inWorld(c, `§7 counsel's text, flag ${flag ? "on" : "off"}`, { flag: true, text: FINAL_TEXT, ...opts }, async (accepting) => {
			const { userId, appId } = await applyAndAccept(accepting);
			// Accepted with the flag on; the rest runs with the flag as the case says
			// (off: an existing owner-operator after a switch-off, plan M3).
			const w = flag ? accepting : await world({ flag: false, text: FINAL_TEXT, ...opts, db: accepting.db });
			try {
			const me = sessionOf(w.db, userId);
			const noticed = w.db.prepare("SELECT driver_name, type, title FROM notifications WHERE type = 'oo_agreement_ready'").all();
			c.eq(`§7 [flag ${flag ? "on" : "off"}] ready at acceptance: one in-app notice to him`, noticed.map((n) => [n.driver_name, n.title]), [[me.driverName.toLowerCase(), "Your agreement is ready to sign"]]);
			c.eq(`§7 [flag ${flag ? "on" : "off"}] ...the notice is sent once`, [w.fns.ooOnboarding.notifyAgreementReady(userId), w.fns.ooOnboarding.sweepAgreementReadyNotices()], [false, 0]);
			// Not ready while his truck isn't linked.
			const profile = w.db.prepare("SELECT id FROM owner_operators WHERE user_id = ?").get(userId);
			w.db.prepare("UPDATE owner_operator_trucks SET end_week_start = '2026-10-31' WHERE oo_id = ?").run(profile.id);
			const notReady = await w.call("POST", `/api/onboarding/${userId}/documents/owner_operator_agreement/sign`, { user: me, body: signBody({ paymentInfo: { paymentMethod: "check", checkName: "Alex Example" } }) });
			c.eq(`§7 [flag ${flag ? "on" : "off"}] his truck unlinked: 409 OO_AGREEMENT_NOT_READY naming the truck, nothing written`,
				[notReady.status, notReady.body && notReady.body.missing, (tableRows(w.db, "driver_payment_info") || []).length], [409, ["truck"], 0]);
			w.db.prepare("UPDATE owner_operator_trucks SET end_week_start = '' WHERE oo_id = ?").run(profile.id);
			// A fee outside 10-25% can't be stored (the table's CHECK), so terms are proven unreadable through escrow.
			w.db.prepare("UPDATE owner_operators SET escrow_weekly_cents = 300000 WHERE id = ?").run(profile.id);
			const noTerms = await w.call("POST", `/api/onboarding/${userId}/documents/owner_operator_agreement/sign`, { user: me, body: signBody() });
			c.eq(`§7 [flag ${flag ? "on" : "off"}] terms not set right (weekly escrow above its target): 409 naming the terms`, [noTerms.status, noTerms.body && noTerms.body.missing], [409, ["terms"]]);
			w.db.prepare("UPDATE owner_operators SET escrow_weekly_cents = 50000 WHERE id = ?").run(profile.id);
			// His truck's costs and an onboarding charge, as PR 4's page will set them.
			const truck = w.db.prepare("SELECT id FROM trucks WHERE unit_number = ?").get(`OO-${appId}-A`);
			w.db.prepare("UPDATE trucks SET insurance_monthly = 1343.33, eld_monthly = 65 WHERE id = ?").run(truck.id);
			w.db.prepare(`INSERT INTO owner_operator_charges (oo_id, kind, category, label, cents, charge_date, cost_record, reason, created_at)
				VALUES (?, 'onboarding', 'taxes_permits', 'Form 2290', 55000, '2026-10-20', 'outside_app', 'made-up', '2026-10-20T12:00:00.000Z')`).run(profile.id);
			// The preview, before he signs.
			const preview = await w.call("GET", "/api/onboarding/documents/owner_operator_agreement/pdf", { user: me });
			const pr = w.log.renders.pop() || {};
			c.ok(`§7 [flag ${flag ? "on" : "off"}] the preview renders his agreement through the profile path, unsigned`,
				preview.status === 200 && /application\/pdf/.test(preview.type) && pr.docKey === "owner_operator_agreement" && pr.options && pr.options.ownerOperatorProfile === true && pr.data.signatureText === "", `${preview.status} ${preview.text.slice(0, 120)}`);
			const contractor = await w.call("GET", "/api/onboarding/documents/contractor_agreement/pdf", { user: me });
			c.eq(`§7 [flag ${flag ? "on" : "off"}] ...the contractor agreement isn't his to preview: 404`, contractor.status, 404);
			// Signing with the flag off is the existing-profile path (plan M3).
			const signed = await w.call("POST", `/api/onboarding/${userId}/documents/owner_operator_agreement/sign`, { user: me, body: signBody({ paymentInfo: { paymentMethod: "check", checkName: "Example Hauling LLC" } }) });
			const rr = w.log.renders.pop() || {};
			c.eq(`§7 [flag ${flag ? "on" : "off"}] signed once ready: 200, the document signed`, [signed.status, (w.db.prepare("SELECT signed FROM onboarding_documents WHERE user_id = ? AND doc_key = 'owner_operator_agreement'").get(userId) || {}).signed], [200, 1]);
			const d = rr.data || {};
			c.eq(`§7 [flag ${flag ? "on" : "off"}] ...rendered through the profile path with his figures: fee, escrow, truck, weekly costs (monthly x 12 / 52), onboarding costs, Schedule D, the company signer`,
				[rr.options && rr.options.ownerOperatorProfile, d.feeBps, d.escrowTargetCents, d.escrowWeeklyCents, d.truckVin, d.truckPlate, d.truckPlateState, d.truckYear, d.truckUnit, d.truckOwnership, d.registeredOwner,
					d.weeklyInsuranceCents, d.weeklyEldCents, d.onboardingTotalCents, JSON.stringify(d.onboardingCosts), d.installmentCents, d.paymentMethod, d.businessName, !!d.carrierSignerName, d.signatureText],
				[true, 1800, 250000, 50000, "1MDEXP0VT00000001", "QA-1234", "TX", "2019", `OO-${appId}-A`, "own", "Alex Example", 31000, 1500, 55000, JSON.stringify([{ label: "Form 2290", cents: 55000 }]), 0, "check", "Example Hauling LLC", true, "Alex Example"]);
			const pay = w.db.prepare("SELECT payment_method, check_name FROM driver_payment_info WHERE user_id = ?").get(userId) || {};
			c.eq(`§7 [flag ${flag ? "on" : "off"}] ...Schedule D's details saved as the contractor agreement saves them`, [pay.payment_method, pay.check_name], ["check", "Example Hauling LLC"]);
			} finally {
				if (w !== accepting) await w.close();
			}
		});
	}
	// His signing step reads his set; a driver's is unchanged.
	await inWorld(c, "§7 the signing step", { flag: true, text: FINAL_TEXT, ...opts }, async (w) => {
		const { userId } = await applyAndAccept(w);
		const ob = { status: "documents_pending" };
		signAllBut(w.db, userId, "owner_operator_agreement");
		c.eq("§7 his step: four of his five signed is not done", w.fns.onboardingSigningStepState(userId, ob).requiredSigned, false);
		w.db.prepare("UPDATE onboarding_documents SET signed = 1, signed_pdf_url = '/uploads/x.pdf' WHERE user_id = ?").run(userId);
		c.eq("§7 his step: all five of his set signed is done, no contractor agreement needed", w.fns.onboardingSigningStepState(userId, ob).requiredSigned, true);
		const a = await w.call("POST", "/api/public/apply", { user: null, body: application({ position: "Company Driver" }) });
		const r = await w.call("PUT", `/api/applications/${a.body.id}/status`, { body: { status: "Accepted" } });
		const driverId = r.body.credentials.userId;
		w.db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed) VALUES (?, 'owner_operator_agreement', 'x', 1)").run(driverId);
		signAllBut(w.db, driverId, "contractor_agreement");
		c.eq("§7 a driver's step: his agreement signed never stands in for the contractor agreement", w.fns.onboardingSigningStepState(driverId, ob).requiredSigned, false);
		const mine = await w.call("GET", `/api/onboarding/${userId}`, { user: sessionOf(w.db, userId) });
		c.eq("§7 GET /api/onboarding/:userId: his totalDocs is his set's", [mine.status, mine.body && mine.body.totalDocs], [200, 5]);
		const noRow = await w.call("POST", `/api/onboarding/${driverId}/documents/contractor_agreement/sign`, { user: sessionOf(w.db, driverId), body: signBody() });
		c.ok("§7 a company driver's contractor agreement still signs as before", noRow.status === 200 && (w.log.renders.pop() || {}).docKey === "contractor_agreement");
	});
}

// ── §8 R2-M1: the in-service date at completion ───────────────────────────────
async function inServiceSection(c, opts = {}) {
	await inWorld(c, "§8", { flag: true, text: FINAL_TEXT, ...opts }, async (w) => {
		const one = await applyAndAccept(w);
		const two = await applyAndAccept(w, { owner_operator: { ...TRUCK, truck_vin: "1MDEXP0VT00000031" } });
		const truckOf = (appId) => w.db.prepare("SELECT * FROM trucks WHERE unit_number = ?").get(`OO-${appId}-A`);
		w.db.prepare("UPDATE trucks SET in_service_date = '2026-10-25' WHERE id = ?").run(truckOf(two.appId).id);
		for (const u of [one.userId, two.userId]) {
			w.db.prepare("UPDATE onboarding_documents SET signed = 1, signed_pdf_url = '/uploads/x.pdf' WHERE user_id = ?").run(u);
			w.db.prepare("UPDATE driver_onboarding SET status = 'documents_signed', drug_test_result = 'pass' WHERE user_id = ?").run(u);
			await w.fns.checkAndCompleteOnboarding(u, null);
		}
		c.eq("§8 completion: fully onboarded", [one.userId, two.userId].map((u) => w.db.prepare("SELECT status FROM driver_onboarding WHERE user_id = ?").get(u).status), ["fully_onboarded", "fully_onboarded"]);
		c.eq("§8 his truck goes in service on his completion day on the business clock (10:00 ET Mon 2026-11-02)", truckOf(one.appId).in_service_date, "2026-11-02");
		c.eq("§8 ...a date already set is kept", truckOf(two.appId).in_service_date, "2026-10-25");
		const rows = audits(w.db).filter((a) => a.action === "oo_truck_in_service_set");
		c.ok("§8 ...one audit row, a system change, naming the truck and the day", rows.length === 1 && rows[0].role === "system" && rows[0].details.includes(`OO-${one.appId}-A`) && rows[0].details.includes("2026-11-02") && rows[0].details.includes("[system change]"), JSON.stringify(rows));
		c.eq("§8 ...his truck stays Inactive (staff set it Active)", truckOf(one.appId).status, "Inactive");
		// A company driver's completion touches no truck.
		const a = await w.call("POST", "/api/public/apply", { user: null, body: application({ position: "Company Driver" }) });
		const r = await w.call("PUT", `/api/applications/${a.body.id}/status`, { body: { status: "Accepted" } });
		const t = Number(w.db.prepare("INSERT INTO trucks (unit_number, owner_id, status, assigned_driver) VALUES ('QA-CO-9', 0, 'Active', ?)").run(r.body.credentials.driverName).lastInsertRowid);
		w.db.prepare("UPDATE onboarding_documents SET signed = 1, signed_pdf_url = '/uploads/x.pdf' WHERE user_id = ?").run(r.body.credentials.userId);
		w.db.prepare("UPDATE driver_onboarding SET status = 'documents_signed', drug_test_result = 'pass' WHERE user_id = ?").run(r.body.credentials.userId);
		await w.fns.checkAndCompleteOnboarding(r.body.credentials.userId, null);
		c.eq("§8 a company driver's completion sets no in-service date", (w.db.prepare("SELECT in_service_date FROM trucks WHERE id = ?").get(t).in_service_date || ""), "");
	});
}

// ── §9 G10: his directory row ─────────────────────────────────────────────────
async function directorySection(c, opts = {}) {
	await inWorld(c, "§9", { flag: true, ...opts }, async (w) => {
		const { userId } = await applyAndAccept(w);
		const name = w.db.prepare("SELECT driver_name FROM users WHERE id = ?").get(userId).driver_name;
		const dirId = Number(w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily, status) VALUES (?, '', 'fixed', 0, 0, 'active')").run(name).lastInsertRowid);
		const other = Number(w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily, status) VALUES ('Sam Company', '', 'fixed', 0, 0, 'active')").run().lastInsertRowid);
		const put = (id, values, user = "sa") => w.call("PUT", `/api/drivers-directory/${id}`, { user, body: { headers: Object.keys(values), values: Object.values(values) } });
		const rowOf = (id) => w.db.prepare("SELECT driver_name, carrier_name, pay_type, pay_percentage, pay_daily, phone FROM drivers_directory WHERE id = ?").get(id);
		const before = JSON.stringify(rowOf(dirId));
		for (const [label, values] of [
			["his pay type to a percentage", { Driver: name, PayType: "percentage", PayPercentage: "80" }],
			["his daily rate", { Driver: name, PayType: "fixed", PayDaily: "300" }],
			["his carrier name", { Driver: name, "Carrier Name": "Example Investor Co" }],
		]) {
			const r = await put(dirId, values);
			c.eq(`§9 a Super Admin changing ${label}: 409 OWNER_OPERATOR_DIRECTORY, nothing written`, [r.status, r.body && r.body.code, JSON.stringify(rowOf(dirId)) === before], [409, "OWNER_OPERATOR_DIRECTORY", true]);
		}
		c.ok("§9 ...each refusal audited under update_driver_pay_blocked with its code", audits(w.db).filter((a) => a.action === "update_driver_pay_blocked" && a.details.includes("[OWNER_OPERATOR_DIRECTORY]")).length >= 1);
		const disp = await put(dirId, { Driver: name, "Carrier Name": "Example Investor Co" }, "disp");
		c.eq("§9 a Dispatcher too: 409 OWNER_OPERATOR_DIRECTORY", [disp.status, disp.body && disp.body.code], [409, "OWNER_OPERATOR_DIRECTORY"]);
		const resend = await put(dirId, { Driver: name, PayType: "fixed", PayDaily: "", PayPercentage: "", "Carrier Name": "", PhoneNumber: "555-0100" });
		c.eq("§9 a contact edit resending his stored terms goes through", [resend.status, rowOf(dirId).phone], [200, "555-0100"]);
		const driver = await put(other, { Driver: "Sam Company", "Carrier Name": "Example Carrier Co" });
		c.eq("§9 a company driver's carrier change is as before (no owner-operator refusal)", [driver.status, rowOf(other).carrier_name], [200, "Example Carrier Co"]);
	});
	// His first row (POST /api/drivers-directory), open from acceptance until his signing
	// step adds it, and after a delete: the same rule as the edit.
	await inWorld(c, "§9 the first row", { flag: true, ...opts }, async (w) => {
		const { userId } = await applyAndAccept(w);
		const name = w.db.prepare("SELECT driver_name FROM users WHERE id = ?").get(userId).driver_name;
		const add = (values, user = "disp") => w.call("POST", "/api/drivers-directory", { user, body: { headers: Object.keys(values), values: Object.values(values) } });
		const rowsOf = () => w.db.prepare("SELECT driver_name, carrier_name, pay_type, pay_percentage, pay_daily, phone FROM drivers_directory WHERE driver_name = ?").all(name);
		const pairingsBefore = w.log.pairings.length;
		const carrier = await add({ Driver: name, "Carrier Name": "Example Investor Co" });
		c.eq("§9 a Dispatcher adding his row with an investor company as carrier: 409 OWNER_OPERATOR_DIRECTORY, no row, no carrier pairing",
			[carrier.status, carrier.body && carrier.body.code, rowsOf().length, w.log.pairings.length - pairingsBefore], [409, "OWNER_OPERATOR_DIRECTORY", 0, 0]);
		const terms = await add({ Driver: name, PayType: "percentage", PayPercentage: "80" }, "sa");
		c.eq("§9 a Super Admin adding his row with pay terms: 409 OWNER_OPERATOR_DIRECTORY, no row", [terms.status, terms.body && terms.body.code, rowsOf().length], [409, "OWNER_OPERATOR_DIRECTORY", 0]);
		c.ok("§9 ...both refusals audited under create_driver_pay_blocked with the code",
			audits(w.db).filter((a) => a.action === "create_driver_pay_blocked" && a.details.includes("[OWNER_OPERATOR_DIRECTORY]")).length === 2);
		const contact = await add({ Driver: name, PhoneNumber: "555-0100", "Carrier Name": "" });
		c.eq("§9 a contact-only add goes through: his row with the default pay and no carrier", [contact.status, rowsOf()], [200, [{ driver_name: name, carrier_name: "", pay_type: "fixed", pay_percentage: 0, pay_daily: 0, phone: "555-0100" }]]);
		const other = await add({ Driver: "Sam Company", "Carrier Name": "Example Carrier Co" });
		c.eq("§9 a company driver's row is added with its carrier as before", [other.status, w.log.pairings.some(([d, k]) => d === "Sam Company" && k === "Example Carrier Co")], [200, true]);
	});
	// Another driver's row renamed onto his name (PUT /api/drivers-directory/:id) while he
	// has no row: what the edit leaves is his first row, held to the create's rule.
	await inWorld(c, "§9 a rename onto him", { flag: true, ...opts }, async (w) => {
		const { userId } = await applyAndAccept(w);
		const name = w.db.prepare("SELECT driver_name FROM users WHERE id = ?").get(userId).driver_name;
		const addRow = (driverName, carrier, payType, pct) => Number(w.db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_percentage, pay_daily, phone, status) VALUES (?, ?, ?, ?, 0, '', 'active')")
			.run(driverName, carrier, payType, pct).lastInsertRowid);
		const put = (id, values, user) => w.call("PUT", `/api/drivers-directory/${id}`, { user, body: { headers: Object.keys(values), values: Object.values(values) } });
		const rowOf = (id) => w.db.prepare("SELECT driver_name, carrier_name, pay_type, pay_percentage, pay_daily, phone FROM drivers_directory WHERE id = ?").get(id);
		// A rename the code under test lets through is undone, so every case meets the rows as set up.
		const refused = async (label, id, values, user) => {
			const was = rowOf(id);
			const p0 = w.log.pairings.length;
			const r = await put(id, values, user);
			const unchanged = JSON.stringify(rowOf(id)) === JSON.stringify(was);
			if (!unchanged) w.db.prepare("UPDATE drivers_directory SET driver_name = ?, carrier_name = ?, pay_type = ?, pay_percentage = ?, pay_daily = ?, phone = ? WHERE id = ?")
				.run(was.driver_name, was.carrier_name, was.pay_type, was.pay_percentage, was.pay_daily, was.phone, id);
			c.eq(`§9 ${label}: 409 OWNER_OPERATOR_DIRECTORY, the row unchanged, no carrier pairing`,
				[r.status, r.body && r.body.code, unchanged, w.log.pairings.length - p0], [409, "OWNER_OPERATOR_DIRECTORY", true, 0]);
		};
		const plain = addRow("Sam Other", "", "fixed", 0);
		const legacy = addRow("Sam Legacy", "Example Investor Co", "fixed", 0);
		const terms = addRow("Pat Other", "Example Investor Co", "percentage", 80);
		await refused("a Dispatcher renaming another driver's row onto his name with an investor company as carrier", plain, { Driver: name, "Carrier Name": "Example Investor Co" }, "disp");
		await refused("a Dispatcher renaming a row that carries an investor company onto his name, as the edit form sends it (carrier blank, so kept)", legacy,
			{ Driver: name, "Carrier Name": "", PayType: "fixed", PayDaily: "", PayPercentage: "", PhoneNumber: "555-0101" }, "disp");
		await refused("a Dispatcher renaming that row onto a case and spacing variant of his name", legacy, { Driver: ` ${name.toUpperCase().replace(/ /g, "  ")} ` }, "disp");
		await refused("a Super Admin renaming a row with 80% terms and an investor carrier onto his name", terms, { Driver: name }, "sa");
		await refused("a Super Admin renaming a default row onto his name and setting pay terms", plain, { Driver: name, PayType: "percentage", PayPercentage: "80" }, "sa");
		await refused("a Super Admin renaming a default row onto his name and setting an investor carrier", plain, { Driver: name, "Carrier Name": "Example Investor Co" }, "sa");
		const blocked = audits(w.db).filter((a) => a.action === "update_driver_pay_blocked" && a.details.includes("[OWNER_OPERATOR_DIRECTORY]"));
		c.ok("§9 ...the refusals audited under update_driver_pay_blocked with the code, on the renamed row, naming him, for each role",
			blocked.some((a) => a.username === "dispatch_t" && a.entity_id === String(plain)) && blocked.some((a) => a.username === "super_admin" && a.entity_id === String(terms)) &&
			blocked.every((a) => a.details.startsWith(`${name}: `)), JSON.stringify(blocked));
		// A rename onto any other name is as before: the row's terms and carrier go with it.
		const p1 = w.log.pairings.length;
		const away = await put(terms, { Driver: "Pat Newname" }, "sa");
		c.eq("§9 a Super Admin renaming that row onto another name is as before: its terms and carrier go with it, the pairing written",
			[away.status, rowOf(terms), w.log.pairings.slice(p1)],
			[200, { driver_name: "Pat Newname", carrier_name: "Example Investor Co", pay_type: "percentage", pay_percentage: 80, pay_daily: 0, phone: "" }, [["Pat Newname", "Example Investor Co"]]]);
		const p2 = w.log.pairings.length;
		const elsewhere = await put(plain, { Driver: "Sam Newname", "Carrier Name": "Example Carrier Co" }, "disp");
		c.eq("§9 a Dispatcher renaming a row onto another name with a carrier is as before", [elsewhere.status, rowOf(plain).driver_name, rowOf(plain).carrier_name, w.log.pairings.slice(p2)],
			[200, "Sam Newname", "Example Carrier Co", [["Sam Newname", "Example Carrier Co"]]]);
		// A default, carrier-less row renamed onto him goes through, for either role, and is then his row.
		const typo = addRow("Sam Typo", "", "fixed", 0);
		const p3 = w.log.pairings.length;
		const disp = await put(typo, { Driver: name, "Carrier Name": "", PayType: "fixed", PayDaily: "", PayPercentage: "", PhoneNumber: "555-0102" }, "disp");
		c.eq("§9 a Dispatcher renaming a default, carrier-less row onto him goes through: his row at the defaults, no carrier, no pairing",
			[disp.status, rowOf(typo), w.log.pairings.length - p3], [200, { driver_name: name, carrier_name: "", pay_type: "fixed", pay_percentage: 0, pay_daily: 0, phone: "555-0102" }, 0]);
		const then = await put(typo, { Driver: name, "Carrier Name": "Example Investor Co" }, "sa");
		c.eq("§9 ...and it is then his row: a carrier on it is refused as before", [then.status, then.body && then.body.code], [409, "OWNER_OPERATOR_DIRECTORY"]);
		w.db.prepare("DELETE FROM drivers_directory WHERE id = ?").run(typo);
		const typo2 = addRow("Sam Typo Two", "", "fixed", 0);
		const sa = await put(typo2, { Driver: name, PhoneNumber: "555-0103" }, "sa");
		c.eq("§9 after his row is deleted, a Super Admin renaming a default, carrier-less row onto him goes through",
			[sa.status, rowOf(typo2)], [200, { driver_name: name, carrier_name: "", pay_type: "fixed", pay_percentage: 0, pay_daily: 0, phone: "555-0103" }]);
		// His own row's edits keep their rule, even on a row holding a carrier (as a Super Admin's name merge can leave it).
		w.db.prepare("UPDATE drivers_directory SET carrier_name = 'Example Investor Co' WHERE id = ?").run(typo2);
		const own = await put(typo2, { Driver: name.toLowerCase(), "Carrier Name": "", PayType: "fixed", PayDaily: "", PayPercentage: "", PhoneNumber: "555-0104" }, "disp");
		c.eq("§9 his own row holding a carrier: a contact edit that re-spells his name goes through as before, the carrier kept",
			[own.status, rowOf(typo2)], [200, { driver_name: name.toLowerCase(), carrier_name: "Example Investor Co", pay_type: "fixed", pay_percentage: 0, pay_daily: 0, phone: "555-0104" }]);
	});
	// His account's company name: the account edit's directory sync and the signing
	// step copy it into his carrier, so it doesn't change for an owner-operator.
	await inWorld(c, "§9 the account's company name", { flag: true, ...opts }, async (w) => {
		// The account edit re-reads the acting Super Admin's own row.
		w.db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'super_admin', 'x', 'Super Admin')").run();
		const { userId } = await applyAndAccept(w);
		const before = w.db.prepare("SELECT company_name, email FROM users WHERE id = ?").get(userId);
		const r = await w.call("PUT", `/api/users/${userId}`, { body: { companyName: "Example Investor Co" } });
		c.eq("§9 changing his account's company name: 409 OWNER_OPERATOR_DIRECTORY, the account unchanged, no directory sync",
			[r.status, r.body && r.body.code, w.db.prepare("SELECT company_name FROM users WHERE id = ?").get(userId).company_name, w.log.synced.filter((s) => s.companyName !== undefined).length],
			[409, "OWNER_OPERATOR_DIRECTORY", before.company_name, 0]);
		c.ok("§9 ...audited under update_user_blocked with the code", audits(w.db).some((a) => a.action === "update_user_blocked" && a.details.includes("[OWNER_OPERATOR_DIRECTORY]")));
		const same = await w.call("PUT", `/api/users/${userId}`, { body: { companyName: before.company_name, email: "qa-oo-new@example.com" } });
		c.eq("§9 an edit that sends his company name back unchanged goes through", [same.status, w.db.prepare("SELECT email FROM users WHERE id = ?").get(userId).email], [200, "qa-oo-new@example.com"]);
		const a = await w.call("POST", "/api/public/apply", { user: null, body: application({ position: "Company Driver" }) });
		const d = await w.call("PUT", `/api/applications/${a.body.id}/status`, { body: { status: "Accepted" } });
		const co = await w.call("PUT", `/api/users/${d.body.credentials.userId}`, { body: { companyName: "Example Carrier Co" } });
		c.eq("§9 a company driver's account company change is as before", [co.status, w.db.prepare("SELECT company_name FROM users WHERE id = ?").get(d.body.credentials.userId).company_name], [200, "Example Carrier Co"]);
	});
}

// ── §10 G13: the five routes that put a driver on a load ──────────────────────
async function loadsSection(c, { libOverride = null } = {}) {
	const AW = require("./lib/availability-world");
	let w = null;
	try {
		w = await AW.startWorld({ flag: false, env: {} });
		if (libOverride) throw new Error("the availability world lifts lib modules as shipped");
		const db = w.db;
		// Hollis (user 10) as an owner-operator who hasn't signed.
		db.prepare("INSERT INTO owner_operators (user_id, status, created_at) VALUES (10, 'onboarding', '2026-10-01T12:00:00.000Z')").run();
		db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed) VALUES (10, 'owner_operator_agreement', 'Owner-Operator Agreement', 0)").run();
		const sheetBefore = () => JSON.stringify(w.sheet.tabs["Job Tracking"]);
		const H = AW.HEADERS;
		const rowOf = (id) => w.sheet.tabs["Job Tracking"].findIndex((r) => r[H.indexOf("Load ID")] === String(id)) + 1;
		const row7003 = rowOf("7003");
		const disp = AW.USERS.disp;
		// Each route puts `driver` on a load that isn't his: `edit` is the load the two
		// row saves change (one with another driver on it, or none).
		const tries = async (driver, edit = "7003") => {
			const out = [];
			const editRow = rowOf(edit);
			out.push(await w.call("POST", "/api/dispatch", { user: disp, body: { rowIndex: row7003, loadId: "7003", driver } }));
			out.push(await w.call("POST", "/api/dispatch/reassign", { user: disp, body: { rowIndex: rowOf("7002"), loadId: "7002", newDriver: driver } }));
			const cells = w.sheet.tabs["Job Tracking"][editRow - 1].slice();
			const values = H.map((h, i) => (h === "Driver" ? driver : cells[i] || ""));
			out.push(await w.call("PUT", `/api/data/${editRow}?sheet=Job%20Tracking`, { user: disp, body: { values, baseline: H.map((h, i) => cells[i] || "") } }));
			out.push(await w.call("PUT", `/api/load/${edit}`, { user: disp, body: { Driver: driver } }));
			const fresh = H.map((h) => ({ "Load ID": "7999", "Contract ID": "C-7999", Driver: driver, "Job Status": "Dispatched", "Pickup Appointment": "11/20/2026 08:00", "Drop-off Appointment": "11/21/2026 17:00" }[h.trim()] || ""));
			out.push(await w.call("POST", "/api/data?sheet=Job%20Tracking", { user: AW.USERS.sa, body: { values: fresh } }));
			return out;
		};
		const ROUTES5 = ["POST /api/dispatch", "POST /api/dispatch/reassign", "PUT /api/data/:rowIndex", "PUT /api/load/:loadId", "POST /api/data"];
		const s0 = sheetBefore();
		const unsigned = await tries("hollis  RENNER");
		ROUTES5.forEach((label, i) => c.eq(`§10 ${label}: an owner-operator who hasn't signed (named in other spacing and case): 409 OWNER_OPERATOR_UNSIGNED`,
			[unsigned[i].status, unsigned[i].body && unsigned[i].body.code], [409, "OWNER_OPERATOR_UNSIGNED"]));
		c.ok("§10 ...the sheet is untouched", sheetBefore() === s0);
		const blocked = db.prepare("SELECT action, details FROM audit_trail WHERE details LIKE '%OWNER_OPERATOR_UNSIGNED%'").all();
		c.ok("§10 ...refusals audited under the routes' own *_blocked actions", blocked.some((a) => a.action === "dispatch_blocked") && blocked.some((a) => a.action === "update_sheet_row_blocked") && blocked.some((a) => a.action === "create_sheet_row_blocked"), JSON.stringify(blocked.map((a) => a.action)));
		// A company driver is untouched.
		const soren = await w.call("POST", "/api/dispatch", { user: disp, body: { rowIndex: row7003, loadId: "7003", driver: "Tamsin Vale" } });
		c.eq("§10 a company driver is dispatched as before", soren.status, 200);
		// Signed: he hauls.
		db.prepare("UPDATE onboarding_documents SET signed = 1 WHERE user_id = 10").run();
		const ok1 = await w.call("POST", "/api/dispatch", { user: disp, body: { rowIndex: row7003, loadId: "7003", driver: "Hollis Renner" } });
		c.eq("§10 once he has signed: dispatched", ok1.status, 200);
		// After his end week (business clock: Thu 2026-10-15 is in the week of Sat 10-10).
		db.prepare("UPDATE owner_operators SET end_week_start = '2026-10-03' WHERE user_id = 10").run();
		const s1 = sheetBefore();
		const ended = await tries("Hollis Renner", "7002");
		ROUTES5.forEach((label, i) => c.eq(`§10 ${label}: after his end week: 409 OWNER_OPERATOR_ENDED`, [ended[i].status, ended[i].body && ended[i].body.code], [409, "OWNER_OPERATOR_ENDED"]));
		c.ok("§10 ...the sheet is untouched", sheetBefore() === s1);
		// A save that leaves him on a load that is already his is no new load.
		const cells = w.sheet.tabs["Job Tracking"][row7003 - 1].slice();
		const keep = await w.call("PUT", `/api/data/${row7003}?sheet=Job%20Tracking`, { user: disp, body: { values: H.map((h, i) => (h === "Trailer Number" ? "TR-9" : cells[i] || "")), baseline: H.map((h, i) => cells[i] || "") } });
		c.eq("§10 after his end week, a save that keeps him on a load already his (another cell changed) goes through", keep.status, 200);
		db.prepare("UPDATE owner_operators SET end_week_start = '2026-10-10' WHERE user_id = 10").run();
		const own = await w.call("POST", "/api/dispatch", { user: disp, body: { rowIndex: row7003, loadId: "7003", driver: "Hollis Renner" } });
		c.eq("§10 in his end week itself: dispatched", own.status, 200);
	} catch (err) {
		c.ok("§10 ran", false, `threw: ${err && (err.stack || err.message)}`.slice(0, 600));
	} finally {
		if (w && typeof w.close === "function") await w.close();
		if (AW && typeof AW.closeAll === "function") await AW.closeAll();
	}
}

// ── §11 source pins ───────────────────────────────────────────────────────────
function pinSection(c) {
	const count = (re) => (SRC.match(re) || []).length;
	c.eq("§11 server.js builds the module once", count(/ooOnboardingLib\.createOwnerOperatorOnboarding\(/g), 1);
	const at = SRC.indexOf("const ooOnboarding = ooOnboardingLib.createOwnerOperatorOnboarding({");
	const region = SRC.indexOf("console.log(ownerOperator.ooFlagsStartupLine(OO_FLAGS));");
	c.ok("§11 ...right after the owner-operator region's start-up line, with the partner code from its setting", at > region && region > 0 && at - region < 200 &&
		SRC.slice(at, at + 600).includes("partnerRef: process.env.OWNER_OPERATOR_PARTNER_REF"));
	c.eq("§11 the onboarding flag: defined once and read at its five gates (apply, apply-options, list, detail, acceptance), comments aside",
		SRC.split("\n").filter((l) => /\bOWNER_OPERATOR_ONBOARDING_ENABLED\b/.test(l) && !/^\s*\/\//.test(l)).length, 6);
	c.eq("§11 the other three flags are still read nowhere", ["OWNER_OPERATOR_LOAD_PAY_ENABLED", "OWNER_OPERATOR_SETTLEMENTS_ENABLED", "OWNER_OPERATOR_ESCROW_ENABLED"].map((n) => (SRC.match(new RegExp(`\\b${n}\\b`, "g")) || []).length), [1, 1, 1]);
	c.eq("§11 G13 is asked by the five routes that put a driver on a load, once each", [SRC.split("ooOnboarding.refuseLoad(").length - 1,
		...["POST /api/dispatch", "POST /api/dispatch/reassign", "PUT /api/data/:rowIndex", "PUT /api/load/:loadId", "POST /api/data"].map((v) => SRC.split(`ooOnboarding.refuseLoad(`).slice(1).filter((t) => t.slice(0, 300).includes(`via: "${v}"`)).length)],
		[5, 1, 1, 1, 1, 1]);
	c.ok("§11 the module reads no environment itself (server.js hands it the partner code)", LIB_SRC !== "" && !LIB_SRC.includes("process.env"));
	c.eq("§11 the readiness sweep runs once, at start-up, its failure logged and never fatal",
		SRC.split("\ntry { ooOnboarding.sweepAgreementReadyNotices(); } catch (err) { console.error(").length - 1, 1);
}

// ── §12 mutants ───────────────────────────────────────────────────────────────
async function mutants(c) {
	const runOn = async (name, build, check) => {
		const sub = counter();
		let built;
		try { built = build(); } catch (err) { c.ok(`§12 ${name}: the mutation applies`, false, err.message); return; }
		c.ok(`§12 ${name}: the mutation applies`, true);
		await check(sub, built);
		c.ok(`§12 ${name}: is caught`, sub.fail.length > 0, `${sub.pass} passed, none failed`);
	};
	const libMutant = (from, to) => () => compileModule(LIB_FILE, mutate(LIB_SRC, from, to));
	const srcMutant = (from, to) => () => mutate(SRC, from, to);
	await runOn("M1 acceptance without the VIN rule (NM1)", libMutant("const held = vin ? db.prepare", "const held = false && vin ? db.prepare"), (s, lib) => acceptanceSection(s, { lib }));
	await runOn("M2 the flag off lets `as: \"owner_operator\"` through", libMutant('return raw === "owner_operator" ? { refusal: refused(404, "FEATURE_OFF", "Not found") } : { ownerOperator: false };', 'return { ownerOperator: raw === "owner_operator" };'), (s, lib) => { pureSection(s, lib); });
	await runOn("M3 the server reading `as` without the flag", srcMutant("ooOnboardingLib.ooAcceptAs(req.body, status, OWNER_OPERATOR_ONBOARDING_ENABLED)", "ooOnboardingLib.ooAcceptAs(req.body, status, true)"), (s, src) => inWorld(s, "M3", { src, flag: false }, async (w) => {
		const a = await w.call("POST", "/api/public/apply", { user: null, body: application() });
		const r = await w.call("PUT", `/api/applications/${a.body.id}/status`, { body: { status: "Accepted", as: "owner_operator" } });
		s.eq("M3 flag off: 404", r.status, 404);
	}));
	await runOn("M4 G13 without the signed check", libMutant("if (!agreementSigned(profile.user_id)) {", "if (false) {"), async (s) => {
		const L = compileModule(LIB_FILE, mutate(LIB_SRC, "if (!agreementSigned(profile.user_id)) {", "if (false) {"));
		const db = freshDb();
		db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (10, 'h', 'x', 'Driver', 'Hollis Renner')").run();
		const oo = L.createOwnerOperatorOnboarding({ db, driverDocs: require("./lib/oo-onboarding-env").driverDocsFrom(SRC), assignDriverToTruck() {}, normalizeDriverName: (x) => String(x).trim().toLowerCase().replace(/\s+/g, " "), todayKey: () => "2026-11-02", logAudit() {}, logAuditRefusal() {}, notify() {} });
		db.prepare("INSERT INTO owner_operators (user_id, status, created_at) VALUES (10, 'onboarding', 'x')").run();
		s.eq("M4 unsigned refused", (oo.loadRefusal("Hollis Renner") || { body: {} }).body.code, "OWNER_OPERATOR_UNSIGNED");
	});
	await runOn("M5 G13 without the end-week check", libMutant('if (profile.status === "ended" || (profile.end_week_start && thisWeek && thisWeek > profile.end_week_start)) {', 'if (profile.status === "ended") {'), async (s, L) => {
		const db = freshDb();
		db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (10, 'h', 'x', 'Driver', 'Hollis Renner')").run();
		const oo = L.createOwnerOperatorOnboarding({ db, driverDocs: require("./lib/oo-onboarding-env").driverDocsFrom(SRC), assignDriverToTruck() {}, normalizeDriverName: (x) => String(x).trim().toLowerCase(), todayKey: () => "2026-11-02", logAudit() {}, logAuditRefusal() {}, notify() {} });
		db.prepare("INSERT INTO owner_operators (user_id, status, created_at, end_week_start) VALUES (10, 'onboarding', 'x', '2026-10-17')").run();
		db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed) VALUES (10, 'owner_operator_agreement', 'x', 1)").run();
		s.eq("M5 ended refused", (oo.loadRefusal("Hollis Renner") || { body: {} }).body.code, "OWNER_OPERATOR_ENDED");
	});
	const RENDERER_SRC = fs.readFileSync(RENDERER_FILE, "utf8");
	await runOn("M6 the renderer ignoring the profile path (review L1)", () => compileModule(RENDERER_FILE, mutate(RENDERER_SRC, "return ooFlagsFromEnv(env)[flagged.flag] === true || profileOpens ? flagged.file : null;", "return ooFlagsFromEnv(env)[flagged.flag] === true ? flagged.file : null;")), (s, r) => rendererSection(s, r));
	await runOn("M7 the profile path opening the statement too", () => compileModule(RENDERER_FILE, mutate(RENDERER_SRC, "owner_operator_settlement: { file: \"owner-operator-settlement.html\", flag: \"settlements\", profilePath: false },", "owner_operator_settlement: { file: \"owner-operator-settlement.html\", flag: \"settlements\", profilePath: true },")), (s, r) => rendererSection(s, r));
	await runOn("M8 his signing step reading the drivers' set (G9)", libMutant("const docsFor = (userId) => (hasProfile(userId) ? ooDocs : driverDocs);", "const docsFor = (userId) => driverDocs;"), (s, lib) => agreementSection(s, { lib }));
	await runOn("M9 the in-service date overwriting one already set", libMutant("currentInServiceDate: truck.in_service_date", "currentInServiceDate: \"\""), (s, lib) => inServiceSection(s, { lib }));
	await runOn("M10 the draft gate removed (S3)", libMutant('if (String(agreementText.DRAFT_MARKER || "") !== "") missing.push("draft");', ""), (s, lib) => agreementSection(s, { lib }));
	await runOn("M11 the directory check ignoring the carrier name", libMutant('if (String(next.carrier_name || "").trim() !== String(current.carrier_name || "").trim()) changed.push("carrier_name");', ""), (s, lib) => directorySection(s, { lib }));
	await runOn("M12 acceptance writing no link", libMutant("db.prepare(`INSERT INTO owner_operator_trucks", "(() => ({ run() {} }))(`INSERT INTO owner_operator_trucks"), (s, lib) => acceptanceSection(s, { lib }));
	await runOn("M13 the readiness notice sent every time", libMutant("if (db.prepare(\"SELECT 1 FROM notifications WHERE driver_name = ? AND type = ? LIMIT 1\").get(recipient, OO_READY_NOTICE_TYPE)) return false;", ""), (s, lib) => agreementSection(s, { lib }));
	await runOn("M14 the apply route storing a section with the flag off", srcMutant("if (OWNER_OPERATOR_ONBOARDING_ENABLED && ownerOperator.ooIsOwnerOperatorPosition(position)) {", "if (ownerOperator.ooIsOwnerOperatorPosition(position)) {"), (s, src) => inWorld(s, "M14", { src, flag: false }, async (w) => {
		await w.call("POST", "/api/public/apply", { user: null, body: application() });
		s.eq("M14 flag off: no section row", (tableRows(w.db, "owner_operator_applications") || []).length, 0);
	}));
	await runOn("M16 G13 matching his name as typed (no folding)", libMutant("return rows.find((r) => normalizeDriverName(String(r.account_driver_name || \"\")) === needle) || null;",
		"return rows.find((r) => String(r.account_driver_name || \"\") === String(name)) || null;"), async (s, L) => {
		const db = freshDb();
		db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (10, 'h', 'x', 'Driver', 'Hollis Renner')").run();
		const oo = L.createOwnerOperatorOnboarding({ db, driverDocs: require("./lib/oo-onboarding-env").driverDocsFrom(SRC), assignDriverToTruck() {}, normalizeDriverName: (x) => String(x).trim().toLowerCase().replace(/\s+/g, " "), todayKey: () => "2026-11-02", logAudit() {}, logAuditRefusal() {}, notify() {} });
		db.prepare("INSERT INTO owner_operators (user_id, status, created_at) VALUES (10, 'onboarding', 'x')").run();
		s.eq("M16 a spacing and case variant is still him", (oo.loadRefusal("  hollis   RENNER") || { body: {} }).body.code, "OWNER_OPERATOR_UNSIGNED");
	});
	await runOn("M17 his first directory row without the owner-operator check (review M1)", srcMutant("const ooCreate = ooOnboarding.directoryCreateRefusal(createRow, directoryDefaultRow(insName));", "const ooCreate = null;"),
		(s, src) => directorySection(s, { src }));
	await runOn("M18 his account's company name without the owner-operator check", srcMutant("const ooCompany = ooOnboarding.accountCompanyRefusal(user, accountCompanyChange(user, companyName));", "const ooCompany = null;"),
		(s, src) => directorySection(s, { src }));
	await runOn("M19 the directory edit judging only the row's old name (recheck R1)", libMutant("const onto = profileForDriverName(next.driver_name);", "const onto = null;"),
		(s, lib) => directorySection(s, { lib }));
	await runOn("M20 the route handing G10 the row's old name, not the new one", srcMutant("{ driver_name: nextName, pay_type: nextPayType,", "{ driver_name: current.driver_name, pay_type: nextPayType,"),
		(s, src) => directorySection(s, { src }));
	await runOn("M21 his own row judged as a first row (re-spelling his row's name)", libMutant("if (!onto || (own && own.id === onto.id)) return null;", "if (!onto) return null;"),
		(s, lib) => directorySection(s, { lib }));
	await runOn("M15 the list annotated with the flag off", srcMutant("if (OWNER_OPERATOR_ONBOARDING_ENABLED) apps = ooOnboarding.annotateApplications(apps);", "apps = ooOnboarding.annotateApplications(apps);"), (s, src) => inWorld(s, "M15", { src, flag: false }, async (w) => {
		await w.call("POST", "/api/public/apply", { user: null, body: application() });
		const l = await w.call("GET", "/api/applications");
		s.ok("M15 flag off: the list has no category", (l.body || []).every((x) => !("category" in x)));
	}));
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
	// --capture: the flag-off answers of the server.js the helper reads (SERVER_ROOT names
	// the base), written to the file given; nothing else runs.
	if (CAPTURE) {
		let answers = null;
		seq = 1000;
		await inWorld(MAIN, "capture", { src: SRC, flag: false, lib: null }, async (w) => { answers = await baselineScript(w); });
		if (!answers || MAIN.fail.length) { console.error(`capture failed: ${MAIN.fail.join("; ")}`); process.exit(1); }
		fs.writeFileSync(CAPTURE, `${JSON.stringify({ about: "Flag-off answers of the base's server.js for scripts/test-owner-operator-onboarding.js §4 (made-up data). Re-capture with --capture when a later change to these routes is intended.", answers }, null, 1)}\n`);
		try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* scratch */ }
		console.log(`captured ${answers.length} answers to ${CAPTURE}`);
		process.exit(0);
	}
	const steps = [
		["§1 the pure rules", () => pureSection(MAIN)],
		["§2 the stand-in other runners use", () => standInSection(MAIN)],
		["§3 the renderer's flag gate and the profile path", () => rendererSection(MAIN)],
		["§4 the flag-off baseline (the base's answers, a fixture)", () => baselineSection(MAIN)],
		["§5 the application and the Applications screen", () => applicationSection(MAIN)],
		["§6 acceptance as an owner-operator", () => acceptanceSection(MAIN)],
		["§7 the agreement", () => agreementSection(MAIN)],
		["§8 the in-service date at completion", () => inServiceSection(MAIN)],
		["§9 his directory row", () => directorySection(MAIN)],
		["§10 no load before he signs or after his end week", () => loadsSection(MAIN)],
		["§11 source pins", () => pinSection(MAIN)],
		["§12 mutants", () => mutants(MAIN)],
	];
	for (const [title, fn] of steps) {
		const before = MAIN.pass + MAIN.fail.length;
		const failsBefore = MAIN.fail.length;
		try { await fn(); } catch (err) { MAIN.ok(`${title} ran`, false, `threw: ${err && (err.stack || err.message)}`.slice(0, 600)); }
		console.log(`${title}: ${MAIN.pass + MAIN.fail.length - before - (MAIN.fail.length - failsBefore)}/${MAIN.pass + MAIN.fail.length - before}`);
	}
	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* scratch */ }
	if (MAIN.fail.length) {
		console.error(`\nFAILURES (${MAIN.fail.length}):`);
		for (const f of MAIN.fail) console.error(`  x ${f}`);
		console.error(`\n${MAIN.pass} passed, ${MAIN.fail.length} failed`);
		process.exit(1);
	}
	console.log(`\n${MAIN.pass} passed, 0 failed`);
	process.exit(0);
})();
