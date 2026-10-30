#!/usr/bin/env node
/**
 * Driver emergency contacts (EMERGENCY_CONTACTS_ENABLED): the four routes, who
 * reaches them, what they answer and write, and that nothing else in server.js
 * reads the table.
 *
 *   §1 flag off: each route answers 404 FEATURE_OFF for every role and for no
 *      session (the gate runs before the role check), nothing is written, and
 *      the driver payload's spread adds no key
 *   §2 the role matrix: /api/driver/me/emergency-contacts is the Driver's own
 *      (Super Admin, Dispatcher, Investor 403; no session 401); a session whose
 *      account is gone, is no longer a Driver, or has no integer id gets 403
 *      DRIVER_ACCOUNT_REQUIRED; /api/drivers-directory/:id/emergency-contacts is
 *      Super Admin's and Dispatcher's (Driver, Investor 403; no session 401)
 *   §3 another driver: A's answers never hold B's values; A's PUT naming B's
 *      contact id answers 409 CONTACT_NOT_FOUND, B's rows and A's are unchanged,
 *      one refusal row is written and no write row
 *   §4 the refusal codes through both PUTs (400, 422 with the index), each
 *      writing nothing; the CSRF header; the write limiter's 31st request (429)
 *   §5 writes: one audit row per add, change and delete, by the session's
 *      account, on the driver's account id, naming the contact id, its position
 *      and the phone's last 4 digits only; created_by and updated_by; a PUT that
 *      changes nothing writes no row; drivers:changed once per real change
 *   §6 the staff routes: a bad id (400), an unknown row (404), a row with no
 *      Driver account and one with two (200 linked:false on GET, 409 on PUT), a
 *      row found through spacing, a Dispatcher saving a linked driver's list
 *   §7 the driver payload's spread: a Driver's own count, by his session's
 *      account id, never the URL's name; no key for a Super Admin; counts only
 *   §8 the pin: every mention of a tracked name in server.js (comments blanked)
 *      sits in an allowlisted place, and each allowlisted place exists (so this
 *      fails on the old code); no other lib/ file names one; no socket emit in
 *      the routes or helpers; every 200 says Cache-Control: private, no-store;
 *      the gate, requireRole and the limiter in that order; the limiter's budget;
 *      the flag's read shape
 *   §9 mutants, each required to flip its section: the gate removed; Investor
 *      added to a role list; the membership test removed; the audit unmasked; a
 *      tracked name planted in GET /api/investor; the payload counted by the
 *      URL's name; and for §10: either branch of checkAndCompleteOnboarding()
 *      ignoring the contacts; onboardingAddsJudgedRow() ignoring them; the flag
 *      ignored; a driver already past the step held back; every signed document
 *      counted; the PUTs' step check removed
 *  §10 the onboarding signing step (onboardingSigningStepState()): with the flag
 *      on, a driver with every document signed stays documents_pending (no
 *      directory row, no "Documents Received" emails) until two contacts are on
 *      file, and a passed drug test cannot skip the step; a driver already
 *      documents_signed still finishes on a pass; the flag off decides as
 *      before; a signed document outside ONBOARDING_DOCS never counts;
 *      onboardingAddsJudgedRow() agrees with what checkAndCompleteOnboarding()
 *      does in every case. Through the routes: the driver's PUT and the staff
 *      PUT complete a pending driver's step once (emails once), never touch a
 *      driver past it, and a failing step check never fails the save
 *
 * Runs the shipped code: the four registrations, the helpers and the guards
 * (requireRole, logAudit, logAuditRefusal, auditText, the limiter) are lifted
 * from server.js through serverSource() and scripts/lib/server-lift.js and run
 * on express (127.0.0.1, port 0) over an in-memory SQLite whose
 * driver_emergency_contacts, audit_trail, driver_onboarding and
 * onboarding_documents tables are built from server.js's own CREATE text.
 * checkAndCompleteOnboarding() and onboardingAddsJudgedRow() run as shipped;
 * mail, the Job Tracking read, the directory sync and its month-end judge are
 * recorders, as is notifyChange. Made-up people and 555-01xx numbers only.
 *
 * Run: node scripts/test-emergency-contacts-routes.js   # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const { closure, indexDeclarations } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");

const ROOT = path.join(__dirname, "..");
const SRC = serverSource();
const LIB_FILE = path.join(ROOT, "lib", "emergency-contacts.js");
let realLib = null;
try { realLib = require(LIB_FILE); } catch { realLib = null; }

// ── reporting ─────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
// A section reports through a checker. The main run prints every result; a
// mutant run only counts what failed.
function checker(print) {
	const c = { failed: [] };
	c.ok = (name, cond, detail) => {
		if (cond) { if (print) { passed++; console.log(`  ok    ${name}`); } return; }
		c.failed.push(name);
		if (print) { failures.push(name); console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
	};
	c.eq = (name, actual, expected) => c.ok(name, JSON.stringify(actual) === JSON.stringify(expected),
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	return c;
}
const MAIN = checker(true);
const quietErrors = [];
const QUIET = { log() {}, info() {}, warn() {}, error: (...a) => quietErrors.push(a.map(String).join(" ")) };

// ── made-up people ────────────────────────────────────────────────────────────
const PEOPLE = [
	{ id: 90101, username: "sa.example", role: "Super Admin", driver_name: "" },
	{ id: 90201, username: "dispatch.example", role: "Dispatcher", driver_name: "" },
	{ id: 90301, username: "investor.example", role: "Investor", driver_name: "" },
	{ id: 90102, username: "casey.example", role: "Driver", driver_name: "Casey Example" },
	{ id: 90103, username: "robin.sample", role: "Driver", driver_name: "Robin Sample" },
	{ id: 90106, username: "jamie.twin", role: "Driver", driver_name: "Jamie Twin" },
	{ id: 90107, username: "jamie.twin.2", role: "Driver", driver_name: "jamie  twin" },
	{ id: 90108, username: "former.driver", role: "Dispatcher", driver_name: "Former Driver" },
	// A staff account with a directory row's name: not a Driver, so never linked.
	{ id: 90109, username: "taylor.nobody", role: "Dispatcher", driver_name: "Taylor Nobody" },
	// §10's driver at the onboarding signing step (no directory row yet).
	{ id: 90121, username: "avery.onboard", role: "Driver", driver_name: "Avery Onboard" },
];
// Sessions as the server holds them. "demoted" still says Driver though the
// account is a Dispatcher now; "gone" names a deleted account; "badid" carries
// its id as text.
const SESSIONS = {
	sa: { id: 90101, username: "sa.example", role: "Super Admin" },
	dispatcher: { id: 90201, username: "dispatch.example", role: "Dispatcher" },
	investor: { id: 90301, username: "investor.example", role: "Investor" },
	casey: { id: 90102, username: "casey.example", role: "Driver", driverName: "Casey Example" },
	robin: { id: 90103, username: "robin.sample", role: "Driver", driverName: "Robin Sample" },
	demoted: { id: 90108, username: "former.driver", role: "Driver", driverName: "Former Driver" },
	gone: { id: 90999, username: "gone.driver", role: "Driver", driverName: "Gone Driver" },
	badid: { id: "90102", username: "casey.example", role: "Driver", driverName: "Casey Example" },
};
const DIRECTORY = [[501, "Casey Example"], [502, "Robin  Sample"], [503, "Taylor Nobody"], [504, "Jamie Twin"]];
const CASEY_LIST = [
	{ name: "Quinn Example", relationship: "Spouse", phone: "(202) 555-0143" },
	{ name: "Harper Example", relationship: "Parent", phone: "1-312-555-0178" },
];
const EXTRA = [
	{ name: "Jordan Placeholder", relationship: "Friend", phone: "+44 20 7946 0958" },
	{ name: "Riley Fixture", relationship: "Relative", phone: "512-555-0149" },
	{ name: "Sky Testcase", relationship: "Other", phone: "512-555-0150" },
	{ name: "Drew Sampleton", relationship: "Child", phone: "512-555-0151" },
];
// Robin's list, seeded straight into the table.
const ROBIN_ROWS = [
	{ position: 1, contact_name: "Morgan Placeholder", relationship: "Sibling", contact_phone: "+15125550147" },
	{ position: 2, contact_name: "Avery Madeup", relationship: "Partner", contact_phone: "+15125550148" },
];
const ROBIN_VALUES = ["Morgan Placeholder", "Avery Madeup", "5125550147", "5125550148", "(512) 555-0147", "(512) 555-0148"];
const CONTACT_VALUES = ["Quinn Example", "Harper Example", "Jordan Placeholder", "Morgan Placeholder", "Avery Madeup",
	"Spouse", "Parent", "Friend", "Sibling", "Partner", "2025550143", "3125550178", "442079460958", "5125550147", "5125550148",
	"202555", "312555", "512555"];
const leaks = (text, values) => values.filter((v) => String(text).includes(v));

const ME = "/api/driver/me/emergency-contacts";
const staffUrl = (id) => `/api/drivers-directory/${id}/emergency-contacts`;

// ── lifting ───────────────────────────────────────────────────────────────────
const SERVER_HELPERS = ["emergencyContactsFlagGate", "emergencyContactsWriteLimiter", "emergencyContactRows", "emergencyContactsCount",
	"emergencyContactsBody", "emergencyContactsOwnAccount", "emergencyContactsDirectoryTarget", "driverAccountForDirectoryRow",
	"saveEmergencyContacts", "emergencyContactsAfterSave"];
const ASYNC_HELPERS = new Set(["emergencyContactsAfterSave"]);
const helperHead = (n) => `${ASYNC_HELPERS.has(n) ? "async " : ""}function ${n}(`;
// The onboarding step (§10): the shared rule and the two functions that apply it.
const STEP_HELPER = "onboardingSigningStepState";
const STEP_FUNCTIONS = ["checkAndCompleteOnboarding", "onboardingAddsJudgedRow"];
// Supplied by the world. Mail, the Job Tracking read, the directory sync and its
// month-end judge are the onboarding step's leaves: recorders here, so a
// completion is seen and nothing leaves the process.
const PROVIDED = ["db", "app", "notifyChange", "EMERGENCY_CONTACTS_ENABLED", "require", "console",
	"sendEmail", "getJobTrackingCached", "syncDriverToCarrierSheet", "accountDirectoryCarrier", "accountDirectoryRowJudged",
	"insertNotification", "ADMIN_NOTIFY_EMAIL", "DATA_DIR", "path", "fs"];
const DENIED = ["io", "server", "sheets", "getSheets", "getDrive", "transporter", "jtCacheInvalidate"];
const ROUTE_PREFIXES = [
	`app.get("${ME}",`,
	`app.put("${ME}",`,
	'app.get("/api/drivers-directory/:id/emergency-contacts",',
	'app.put("/api/drivers-directory/:id/emergency-contacts",',
];
function linesStarting(src, prefix) { return src.split("\n").filter((l) => l.startsWith(prefix)); }
function lineStarting(src, prefix) {
	const hits = linesStarting(src, prefix);
	if (hits.length !== 1) throw new Error(`expected one line starting ${prefix}, found ${hits.length}`);
	return hits[0];
}
// The text a db.exec(`...`) holds, found by a marker inside it.
function execBlock(src, marker) {
	const at = src.indexOf(marker);
	if (at < 0) throw new Error(`server.js has no ${marker}`);
	const open = src.lastIndexOf("db.exec(`", at);
	const close = src.indexOf("`);", at);
	if (open < 0 || close < 0) throw new Error(`could not cut the db.exec holding ${marker}`);
	return src.slice(open + "db.exec(`".length, close);
}
// A root the source does not declare is left out (an older server.js has no
// emergencyContactsAfterSave()), so the sections still run there and the pin
// reports what is missing.
function liftRoutes(src) {
	const { decls } = indexDeclarations(src);
	return closure(src, {
		roots: [...SERVER_HELPERS, "requireRole", ...STEP_FUNCTIONS].filter((n) => decls.has(n)),
		routes: ROUTE_PREFIXES.map((p) => lineStarting(src, p)),
		provided: PROVIDED,
		denied: DENIED,
	});
}
// Replace exactly one occurrence, or throw: a mutant whose target is gone
// would run the original code and prove nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 80)}`);
	return src.replace(from, () => to);
}

// ── a world: an app over an in-memory database ────────────────────────────────
const USERS_DDL = `CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL DEFAULT '',
	role TEXT NOT NULL, driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT NOT NULL DEFAULT '',
	company_name TEXT NOT NULL DEFAULT '', disabled_at TEXT DEFAULT NULL)`;
const DIRECTORY_DDL = `CREATE TABLE drivers_directory (
	id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE, status TEXT DEFAULT 'active',
	email TEXT DEFAULT '', phone TEXT DEFAULT '', cell TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '',
	state TEXT DEFAULT '', zip TEXT DEFAULT '', dot TEXT DEFAULT '', mc TEXT DEFAULT '', hazmat TEXT DEFAULT '')`;
// The application the onboarding step reads back: the driver's email and the
// fields its directory backfill copies.
const APPLICATIONS_DDL = `CREATE TABLE job_applications (
	id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
	cell TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', state TEXT DEFAULT '', zip TEXT DEFAULT '',
	dot TEXT DEFAULT '', mc TEXT DEFAULT '', hazmat TEXT DEFAULT '', position TEXT DEFAULT '')`;
const ADMIN_MAIL = "admin@example.test";
// Five made-up contacts a §10 driver may hold.
const STEP_CONTACTS = [
	["Quinn Example", "Spouse", "+12025550143"], ["Harper Example", "Parent", "+13125550178"],
	["Riley Fixture", "Relative", "+15125550149"], ["Sky Testcase", "Other", "+15125550150"], ["Drew Sampleton", "Child", "+15125550151"],
];
const SEEN_200 = [];

function seed(db) {
	const u = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, ?, ?)");
	for (const p of PEOPLE) u.run(p.id, p.username, p.role, p.driver_name);
	const d = db.prepare("INSERT INTO drivers_directory (id, driver_name) VALUES (?, ?)");
	for (const [id, name] of DIRECTORY) d.run(id, name);
	const c = db.prepare(`INSERT INTO driver_emergency_contacts
		(user_id, position, contact_name, relationship, contact_phone, created_at, updated_at, created_by, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const r of ROBIN_ROWS) c.run(90103, r.position, r.contact_name, r.relationship, r.contact_phone, "2026-10-30T00:00:00.000Z", "2026-10-30T00:00:00.000Z", 90103, 90103);
}

// `onboarding`: { [userId]: { status, signed, extra, drug, contacts, email } }. Each
// gets an application, an onboarding row and the documents: the first `signed` of
// ONBOARDING_DOCS signed (all by default), the rest not, `extra` signed under keys
// outside it; and the first `contacts` of STEP_CONTACTS.
function seedOnboarding(db, docs, onboarding) {
	const doc = db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed) VALUES (?, ?, ?, ?)");
	const contact = db.prepare(`INSERT INTO driver_emergency_contacts
		(user_id, position, contact_name, relationship, contact_phone, created_at, updated_at, created_by, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const [key, o] of Object.entries(onboarding)) {
		const id = Number(key);
		const name = db.prepare("SELECT driver_name FROM users WHERE id = ?").get(id).driver_name;
		const appId = Number(db.prepare("INSERT INTO job_applications (full_name, email, phone) VALUES (?, ?, ?)").run(name, o.email || "", "(202) 555-0100").lastInsertRowid);
		db.prepare("INSERT INTO driver_onboarding (user_id, application_id, driver_name, status, drug_test_result) VALUES (?, ?, ?, ?, ?)")
			.run(id, appId, name, o.status || "documents_pending", o.drug || "");
		const signed = o.signed === undefined ? docs.length : o.signed;
		docs.forEach((d, i) => doc.run(id, d.key, d.name, i < signed ? 1 : 0));
		for (const extra of o.extra || []) doc.run(id, extra, extra, 1);
		STEP_CONTACTS.slice(0, o.contacts || 0).forEach(([n, r, p], i) => contact.run(id, i + 1, n, r, p, "2026-10-30T00:00:00.000Z", "2026-10-30T00:00:00.000Z", id, id));
	}
}

async function world({ src = SRC, flag = true, lib = realLib, record = false, onboarding = {}, failSync = false } = {}) {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(USERS_DDL);
	db.exec(DIRECTORY_DDL);
	db.exec(APPLICATIONS_DDL);
	db.exec(execBlock(src, "CREATE TABLE IF NOT EXISTS audit_trail ("));
	db.exec(execBlock(src, "CREATE TABLE IF NOT EXISTS driver_emergency_contacts ("));
	db.exec(execBlock(src, "CREATE TABLE IF NOT EXISTS driver_onboarding ("));
	db.exec(execBlock(src, "CREATE TABLE IF NOT EXISTS onboarding_documents ("));
	// A migration in server.js; the step reads it back.
	db.exec("ALTER TABLE onboarding_documents ADD COLUMN signed_pdf_url TEXT DEFAULT ''");
	seed(db);
	const lifted = liftRoutes(src);
	const notified = [];
	const mail = [];
	const synced = [];
	const notes = [];
	const jt = { reads: 0 };
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
		notifyChange: (domain) => notified.push(domain),
		EMERGENCY_CONTACTS_ENABLED: flag,
		require: (m) => (m === "./lib/emergency-contacts" ? lib : require(m.startsWith("./lib/") ? path.join(ROOT, m) : m)),
		console: QUIET,
		sendEmail: (to, subject, html) => { mail.push({ to, subject, html: String(html) }); return Promise.resolve(true); },
		getJobTrackingCached: async () => { jt.reads++; return { headers: [], data: [] }; },
		syncDriverToCarrierSheet: (name, opts = {}) => {
			if (failSync) throw Object.assign(new Error("made-up sync failure"), { code: "SYNC_FAILED" });
			synced.push({ name, action: opts.action });
		},
		accountDirectoryCarrier: (name, company) => company,
		// Every row judged, so onboardingAddsJudgedRow() answers the step alone.
		accountDirectoryRowJudged: () => true,
		insertNotification: { run: (...args) => notes.push(args[1]) },
		ADMIN_NOTIFY_EMAIL: ADMIN_MAIL,
		DATA_DIR: "/nonexistent",
		path,
		fs: { existsSync: () => false },
	};
	const fns = new Function(...Object.keys(scope), `${lifted.text}\nreturn { emergencyContactsCount, emergencyContactRules, checkAndCompleteOnboarding, onboardingAddsJudgedRow, ONBOARDING_DOCS };`)(...Object.values(scope));
	seedOnboarding(db, fns.ONBOARDING_DOCS, onboarding);
	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const call = (method, url, { user, body, csrf = true } = {}) => new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const headers = {};
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
				if (record && res.statusCode === 200) SEEN_200.push({ method, url, cache: res.headers["cache-control"] || "" });
				resolve({ status: res.statusCode, headers: res.headers, body: json, text });
			});
		});
		req.on("error", reject);
		if (data !== null) req.write(data);
		req.end();
	});
	const close = () => new Promise((resolve) => { server.close(() => { db.close(); resolve(); }); });
	return { db, notified, call, close, fns, mail, synced, notes, jt };
}

const rowsOf = (db, userId) => db.prepare("SELECT id, user_id, position, contact_name, relationship, contact_phone, created_by, updated_by FROM driver_emergency_contacts WHERE user_id = ? ORDER BY position, id").all(userId);
const auditRows = (db) => db.prepare("SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail ORDER BY id").all();
const answer = (r) => [r.status, r.body && r.body.code];

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
async function flagOffSection(c, src = SRC) {
	await inWorld(c, "§1", { src, flag: false }, async (w) => {
		for (const [method, url] of [["GET", ME], ["PUT", ME], ["GET", staffUrl(501)], ["PUT", staffUrl(501)]]) {
			for (const who of ["sa", "dispatcher", "investor", "casey", null]) {
				const r = await w.call(method, url, { user: who, body: method === "PUT" ? { contacts: CASEY_LIST } : undefined });
				c.eq(`§1 ${method} ${url} as ${who || "no session"}: 404 FEATURE_OFF`, answer(r), [404, "FEATURE_OFF"]);
			}
		}
		c.eq("§1 nothing was written (Robin's two seeded rows only) and nothing audited",
			[w.db.prepare("SELECT COUNT(*) AS n FROM driver_emergency_contacts").get().n, auditRows(w.db).length], [2, 0]);
		c.eq("§1 no drivers:changed", w.notified, []);
	});
	try {
		const spread = payloadSpread(src);
		const counted = [];
		c.eq("§1 the payload spread adds no key", spread.evaluate(false, SESSIONS.casey, (id) => { counted.push(id); return 2; }), {});
		c.eq("§1 ...and counts nothing", counted, []);
	} catch (err) {
		c.ok("§1 the payload spread was found", false, err.message);
	}
}

// ── §2 the role matrix ────────────────────────────────────────────────────────
async function rolesSection(c, src = SRC, record = false) {
	await inWorld(c, "§2", { src, record }, async (w) => {
		const matrix = [
			["GET", ME, { sa: 403, dispatcher: 403, investor: 403, casey: 200, "": 401 }],
			["PUT", ME, { sa: 403, dispatcher: 403, investor: 403, casey: 200, "": 401 }],
			["GET", staffUrl(501), { sa: 200, dispatcher: 200, investor: 403, casey: 403, robin: 403, "": 401 }],
			["PUT", staffUrl(501), { sa: 200, dispatcher: 200, investor: 403, casey: 403, robin: 403, "": 401 }],
		];
		for (const [method, url, expect] of matrix) {
			for (const [who, status] of Object.entries(expect)) {
				const r = await w.call(method, url, { user: who || null, body: method === "PUT" ? { contacts: CASEY_LIST } : undefined });
				c.eq(`§2 ${method} ${url} as ${who || "no session"}: ${status}`, r.status, status);
			}
		}
		for (const who of ["demoted", "gone", "badid"]) {
			for (const method of ["GET", "PUT"]) {
				const r = await w.call(method, ME, { user: who, body: method === "PUT" ? { contacts: CASEY_LIST } : undefined });
				c.eq(`§2 ${method} ${ME} with a ${who} session: 403 DRIVER_ACCOUNT_REQUIRED`, answer(r), [403, "DRIVER_ACCOUNT_REQUIRED"]);
			}
		}
		c.eq("§2 the refused sessions wrote nothing for the account they name", rowsOf(w.db, 90108).length, 0);
	});
}

// ── §3 another driver ─────────────────────────────────────────────────────────
async function otherDriverSection(c, src = SRC, record = false) {
	await inWorld(c, "§3", { src, record }, async (w) => {
		const saved = await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST } });
		c.eq("§3 A saves A's own list", [saved.status, saved.body && saved.body.contacts && saved.body.contacts.length], [200, 2]);
		const mine = await w.call("GET", ME, { user: "casey" });
		c.eq("§3 A's GET holds A's two contacts", [mine.status, (mine.body.contacts || []).map((x) => x.name)], [200, ["Quinn Example", "Harper Example"]]);
		c.eq("§3 A's GET never holds B's names or numbers", leaks(mine.text, ROBIN_VALUES), []);
		const robinBefore = rowsOf(w.db, 90103);
		const caseyBefore = rowsOf(w.db, 90102);
		const auditBefore = auditRows(w.db).length;
		const notifiedBefore = w.notified.length;
		const steal = await w.call("PUT", ME, { user: "casey", body: { contacts: [{ ...CASEY_LIST[0], id: robinBefore[0].id }, CASEY_LIST[1]] } });
		c.eq("§3 A's PUT naming B's contact id: 409 CONTACT_NOT_FOUND", answer(steal), [409, "CONTACT_NOT_FOUND"]);
		c.eq("§3 ...B's rows are unchanged", rowsOf(w.db, 90103), robinBefore);
		c.eq("§3 ...A's rows are unchanged", rowsOf(w.db, 90102), caseyBefore);
		const added = auditRows(w.db).slice(auditBefore);
		c.eq("§3 ...one refusal row and no write row", added.map((a) => a.action), ["emergency_contacts_write_blocked"]);
		c.eq("§3 ...the refusal row is A's, on A's account id", added.map((a) => [a.user_id, a.role, a.entity, a.entity_id]), [[90102, "Driver", "driver_emergency_contacts", "90102"]]);
		c.eq("§3 ...and holds no contact's name, relationship or number", leaks(JSON.stringify(added), CONTACT_VALUES), []);
		c.eq("§3 ...the 409 answer holds none of B's values", leaks(steal.text, ROBIN_VALUES), []);
		c.eq("§3 ...no drivers:changed", w.notified.length, notifiedBefore);
		const staff = await w.call("GET", staffUrl(501), { user: "dispatcher" });
		c.eq("§3 the staff view of A's row holds A's list and none of B's values", [staff.status, staff.body && staff.body.userId, leaks(staff.text, ROBIN_VALUES)], [200, 90102, []]);
		const viaStaff = await w.call("PUT", staffUrl(501), { user: "sa", body: { contacts: [{ ...CASEY_LIST[0], id: robinBefore[1].id }, CASEY_LIST[1]] } });
		c.eq("§3 a staff PUT on A's row naming B's contact id: 409 CONTACT_NOT_FOUND, B unchanged", [...answer(viaStaff), JSON.stringify(rowsOf(w.db, 90103)) === JSON.stringify(robinBefore)], [409, "CONTACT_NOT_FOUND", true]);
	});
}

// ── §4 the refusal codes ──────────────────────────────────────────────────────
async function refusalsSection(c, src = SRC, record = false) {
	const six = [...CASEY_LIST, ...EXTRA];
	const cases = [
		[[CASEY_LIST[0], CASEY_LIST[1]], 400, "INVALID_BODY", undefined, "an array body"],
		[{}, 400, "INVALID_BODY", undefined, "no contacts"],
		[{ contacts: Array.from({ length: 21 }, () => CASEY_LIST[0]) }, 400, "INVALID_BODY", undefined, "21 entries"],
		[{ contacts: [{ ...CASEY_LIST[0], id: "7" }, CASEY_LIST[1]] }, 400, "INVALID_BODY", 0, "an id as text"],
		[{ contacts: [CASEY_LIST[0]] }, 422, "EMERGENCY_CONTACTS_MIN", undefined, "one contact"],
		[{ contacts: six }, 422, "EMERGENCY_CONTACTS_MAX", undefined, "six contacts"],
		[{ contacts: [CASEY_LIST[0], { ...CASEY_LIST[1], name: "" }] }, 422, "CONTACT_NAME_INVALID", 1, "a blank name"],
		[{ contacts: [{ ...CASEY_LIST[0], relationship: "r".repeat(41) }, CASEY_LIST[1]] }, 422, "CONTACT_RELATIONSHIP_INVALID", 0, "a long relationship"],
		[{ contacts: [CASEY_LIST[0], { ...CASEY_LIST[1], phone: "555-0143" }] }, 422, "CONTACT_PHONE_INVALID", 1, "seven digits"],
		[{ contacts: [CASEY_LIST[0], { ...CASEY_LIST[1], phone: "+1 202 555 0143" }] }, 422, "CONTACT_PHONE_DUPLICATE", 1, "the same number twice"],
	];
	await inWorld(c, "§4", { src, record }, async (w) => {
		for (const [url, who] of [[ME, "casey"], [staffUrl(501), "sa"]]) {
			for (const [body, status, code, index, why] of cases) {
				const r = await w.call("PUT", url, { user: who, body });
				c.eq(`§4 PUT ${url}: ${why} -> ${status} ${code}${index !== undefined ? ` @${index}` : ""}`,
					[r.status, r.body && r.body.code, r.body && r.body.index], [status, code, index]);
			}
		}
		c.eq("§4 none of them wrote a row, an audit line or an event", [rowsOf(w.db, 90102).length, auditRows(w.db).length, w.notified.length], [0, 0, 0]);
		const noHeader = await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST }, csrf: false });
		c.eq("§4 a PUT without X-Requested-With: 403 CSRF_HEADER_REQUIRED, nothing written", [...answer(noHeader), rowsOf(w.db, 90102).length], [403, "CSRF_HEADER_REQUIRED", 0]);
	});
	await inWorld(c, "§4 limiter", { src, record }, async (w) => {
		const statuses = [];
		for (let i = 0; i < 31; i++) statuses.push((await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST } })).status);
		c.eq("§4 thirty writes in the window pass, the 31st is 429", [statuses.slice(0, 30).every((s) => s === 200), statuses[30]], [true, 429]);
		const other = await w.call("PUT", staffUrl(501), { user: "sa", body: { contacts: CASEY_LIST } });
		c.eq("§4 ...counted per account: a Super Admin still writes", other.status, 200);
		// The same account, exhausted, on the route its role may not use: requireRole
		// answers first (a limiter mounted before it would answer 429).
		const refused = await w.call("PUT", staffUrl(501), { user: "casey", body: { contacts: CASEY_LIST } });
		c.eq("§4 ...and the exhausted account on a route its role may not use gets 403, not 429", refused.status, 403);
	});
}

// ── §5 writes and their audit rows ────────────────────────────────────────────
async function writesSection(c, src = SRC, { lib = realLib, record = false } = {}) {
	await inWorld(c, "§5", { src, lib, record }, async (w) => {
		const first = await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST } });
		const b = first.body || {};
		c.eq("§5 a first save: 200, both contacts, complete, the limits",
			[first.status, (b.contacts || []).map((x) => [x.position, x.phone, x.phoneDisplay]), b.complete, b.minimum, b.maximum],
			[200, [[1, "+12025550143", "(202) 555-0143"], [2, "+13125550178", "(312) 555-0178"]], true, 2, 5]);
		const [A, B] = (b.contacts || []).map((x) => x.id);
		let audit = auditRows(w.db);
		c.eq("§5 two add rows by the driver's account, as a Driver, on his account id", audit.map((a) => [a.action, a.user_id, a.username, a.role, a.entity, a.entity_id]), [
			["emergency_contact_add", 90102, "casey.example", "Driver", "driver_emergency_contacts", "90102"],
			["emergency_contact_add", 90102, "casey.example", "Driver", "driver_emergency_contacts", "90102"],
		]);
		c.eq("§5 ...naming the contact id, the position and the last 4 digits", audit.map((a) => a.details), [
			`Driver Casey Example (user 90102): contact ${A} added at position 1, phone ending 0143`,
			`Driver Casey Example (user 90102): contact ${B} added at position 2, phone ending 0178`,
		]);
		c.eq("§5 created_by and updated_by are the driver's account", rowsOf(w.db, 90102).map((r) => [r.created_by, r.updated_by]), [[90102, 90102], [90102, 90102]]);
		c.eq("§5 one drivers:changed", w.notified, ["drivers"]);

		const again = await w.call("PUT", ME, { user: "casey", body: { contacts: (b.contacts || []).map((x) => ({ id: x.id, name: x.name, relationship: x.relationship, phone: x.phoneDisplay })) } });
		c.eq("§5 the same list again: 200, no row written, no event", [again.status, auditRows(w.db).length, w.notified.length], [200, 2, 1]);

		// A Dispatcher moves B up, gives A a new number and adds a third.
		const staffBody = { contacts: [
			{ id: B, ...CASEY_LIST[1] },
			{ id: A, ...CASEY_LIST[0], phone: "512-555-0147" },
			EXTRA[0],
		] };
		const edit = await w.call("PUT", staffUrl(501), { user: "dispatcher", body: staffBody });
		const C = edit.body && edit.body.contacts ? edit.body.contacts[2].id : null;
		c.eq("§5 a staff edit: 200, linked to the driver's account, in the new order", [edit.status, edit.body && edit.body.linked, edit.body && edit.body.userId, (edit.body.contacts || []).map((x) => x.id)], [200, true, 90102, [B, A, C]]);
		audit = auditRows(w.db).slice(2);
		c.eq("§5 ...its rows are the Dispatcher's, on the driver's account id", audit.map((a) => [a.action, a.user_id, a.role, a.entity_id]), [
			["emergency_contact_change", 90201, "Dispatcher", "90102"],
			["emergency_contact_change", 90201, "Dispatcher", "90102"],
			["emergency_contact_add", 90201, "Dispatcher", "90102"],
		]);
		c.eq("§5 ...a move, a move with a new number, an add", audit.map((a) => a.details), [
			`Driver Casey Example (user 90102): contact ${B} changed: position (2 -> 1)`,
			`Driver Casey Example (user 90102): contact ${A} changed: position (1 -> 2), phone (ending 0143 -> ending 0147)`,
			`Driver Casey Example (user 90102): contact ${C} added at position 3, phone ending 0958`,
		]);
		c.eq("§5 ...updated_by is the Dispatcher on the rows it touched, created_by stays the driver's",
			rowsOf(w.db, 90102).map((r) => [r.id, r.created_by, r.updated_by]), [[B, 90102, 90201], [A, 90102, 90201], [C, 90201, 90201]]);
		c.eq("§5 ...one more drivers:changed", w.notified, ["drivers", "drivers"]);

		const drop = await w.call("PUT", ME, { user: "casey", body: { contacts: [{ id: B, ...CASEY_LIST[1] }, { id: A, ...CASEY_LIST[0], phone: "512-555-0147" }] } });
		audit = auditRows(w.db).slice(5);
		c.eq("§5 a removed contact: one delete row naming its old position and last 4 digits", [drop.status, audit.map((a) => [a.action, a.details])], [200, [
			["emergency_contact_delete", `Driver Casey Example (user 90102): contact ${C} deleted from position 3, phone ending 0958`],
		]]);
		const all = auditRows(w.db);
		c.eq("§5 no audit row holds a contact's name, relationship or more than the last 4 digits", leaks(JSON.stringify(all.map((a) => a.details)), CONTACT_VALUES), []);
		c.eq("§5 every write row is one of the three actions", [...new Set(all.map((a) => a.action))].sort(), ["emergency_contact_add", "emergency_contact_change", "emergency_contact_delete"]);
		c.eq("§5 no other account's rows moved", rowsOf(w.db, 90103).map((r) => r.contact_phone), ["+15125550147", "+15125550148"]);
	});
}

// ── §6 the staff routes ───────────────────────────────────────────────────────
async function staffSection(c, src = SRC, record = false) {
	await inWorld(c, "§6", { src, record }, async (w) => {
		for (const bad of ["abc", "0", "1e3", "-1", "501x", "05", "12345678901"]) {
			for (const method of ["GET", "PUT"]) {
				const r = await w.call(method, staffUrl(bad), { user: "sa", body: method === "PUT" ? { contacts: CASEY_LIST } : undefined });
				c.eq(`§6 ${method} id ${JSON.stringify(bad)}: 400 INVALID_DRIVER_ID`, answer(r), [400, "INVALID_DRIVER_ID"]);
			}
		}
		for (const method of ["GET", "PUT"]) {
			const r = await w.call(method, staffUrl(9999), { user: "dispatcher", body: method === "PUT" ? { contacts: CASEY_LIST } : undefined });
			c.eq(`§6 ${method} an unknown row: 404 DRIVER_NOT_FOUND`, answer(r), [404, "DRIVER_NOT_FOUND"]);
		}
		const none = await w.call("GET", staffUrl(503), { user: "dispatcher" });
		c.eq("§6 GET a row no Driver account matches (a Dispatcher's name does not count): 200 linked:false", [none.status, none.body], [200, { linked: false, reason: "no_driver_account" }]);
		const twin = await w.call("GET", staffUrl(504), { user: "dispatcher" });
		c.eq("§6 GET a row two Driver accounts match: 200 linked:false ambiguous", [twin.status, twin.body], [200, { linked: false, reason: "ambiguous" }]);
		const putNone = await w.call("PUT", staffUrl(503), { user: "sa", body: { contacts: CASEY_LIST } });
		const putTwin = await w.call("PUT", staffUrl(504), { user: "sa", body: { contacts: CASEY_LIST } });
		c.eq("§6 PUT those two rows: 409 NO_DRIVER_ACCOUNT and 409 DRIVER_ACCOUNT_AMBIGUOUS", [answer(putNone), answer(putTwin)], [[409, "NO_DRIVER_ACCOUNT"], [409, "DRIVER_ACCOUNT_AMBIGUOUS"]]);
		c.eq("§6 ...nothing written for anyone", [w.db.prepare("SELECT COUNT(*) AS n FROM driver_emergency_contacts").get().n, auditRows(w.db).length], [2, 0]);
		const spaced = await w.call("GET", staffUrl(502), { user: "dispatcher" });
		c.eq("§6 a row stored under another spacing finds its driver's account and list",
			[spaced.status, spaced.body && spaced.body.linked, spaced.body && spaced.body.userId, ((spaced.body && spaced.body.contacts) || []).map((x) => x.name)],
			[200, true, 90103, ["Morgan Placeholder", "Avery Madeup"]]);
		const save = await w.call("PUT", staffUrl(502), { user: "dispatcher", body: { contacts: [EXTRA[1], EXTRA[2]] } });
		c.eq("§6 a Dispatcher replaces that driver's list", [save.status, save.body && save.body.userId, rowsOf(w.db, 90103).map((r) => r.contact_phone)], [200, 90103, ["+15125550149", "+15125550150"]]);
		c.eq("§6 ...two deletes and two adds, all on that account", auditRows(w.db).map((a) => [a.action, a.entity_id]), [
			["emergency_contact_delete", "90103"], ["emergency_contact_delete", "90103"], ["emergency_contact_add", "90103"], ["emergency_contact_add", "90103"],
		]);
		c.eq("§6 ...and Casey's account is untouched", rowsOf(w.db, 90102).length, 0);
	});
}

// ── §7 the driver payload's spread ────────────────────────────────────────────
const PAYLOAD_HEAD = 'app.get("/api/driver/:driverName",';
const SPREAD_RE = /^\.\.\.\(EMERGENCY_CONTACTS_ENABLED && req\.session\.user\.role !== "Super Admin" \? \{ emergencyContacts: \{ required: emergencyContactRules\.MIN_CONTACTS, maximum: emergencyContactRules\.MAX_CONTACTS, onFile: emergencyContactsCount\(req\.session\.user\.id\) \} \} : \{\}\),$/;
// The payload route's one line that names emergency contacts, as written, and
// a way to evaluate it as a property of an object.
function payloadSpread(src) {
	const lines = blankComments(src).split("\n");
	const head = lines.findIndex((l) => l.startsWith(PAYLOAD_HEAD));
	if (head < 0) throw new Error("GET /api/driver/:driverName is not registered");
	let end = head + 1;
	while (end < lines.length && lines[end] !== "});") end++;
	const hits = [];
	for (let i = head; i < end; i++) if (/EMERGENCY_CONTACTS_ENABLED|emergencyContact/.test(lines[i])) hits.push(i);
	if (hits.length !== 1) throw new Error(`expected one emergency-contact line in the payload route, found ${hits.length}`);
	const line = lines[hits[0]].trim();
	return {
		line,
		at: hits[0] + 1,
		evaluate: (flag, sessionUser, countFn, params = { driverName: "Robin Sample" }) =>
			new Function("EMERGENCY_CONTACTS_ENABLED", "req", "emergencyContactRules", "emergencyContactsCount", `return { ${line} };`)(
				flag, { session: { user: sessionUser }, params }, realLib, countFn),
	};
}
async function payloadSection(c, src = SRC) {
	try {
		const spread = payloadSpread(src);
		c.ok("§7 the spread line is the shape the pin allows", SPREAD_RE.test(spread.line), spread.line);
		const counted = [];
		const spy = (id) => { counted.push(id); return 1; };
		c.eq("§7 a Driver: the counts, by his session's account id (the URL names another driver)",
			[spread.evaluate(true, SESSIONS.casey, spy), counted], [{ emergencyContacts: { required: 2, maximum: 5, onFile: 1 } }, [90102]]);
		counted.length = 0;
		c.eq("§7 a Super Admin: no key, nothing counted", [spread.evaluate(true, SESSIONS.sa, spy), counted], [{}, []]);
		c.eq("§7 flag off: no key, nothing counted", [spread.evaluate(false, SESSIONS.casey, spy), counted], [{}, []]);
	} catch (err) {
		c.ok("§7 the payload spread was found and evaluated", false, err.message);
	}
	await inWorld(c, "§7", { src }, async (w) => {
		const spread = payloadSpread(src);
		await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST } });
		const real = (user) => spread.evaluate(true, user, w.fns.emergencyContactsCount);
		c.eq("§7 with the real count: Casey 2, Robin 2, a Driver with none 0", [real(SESSIONS.casey), real(SESSIONS.robin), real(SESSIONS.demoted)].map((o) => o.emergencyContacts && o.emergencyContacts.onFile), [2, 2, 0]);
		const out = real(SESSIONS.casey);
		c.eq("§7 counts only: three numbers, no contact value", [Object.keys(out.emergencyContacts), Object.values(out.emergencyContacts).every((v) => typeof v === "number"), leaks(JSON.stringify(out), CONTACT_VALUES)], [["required", "maximum", "onFile"], true, []]);
	});
}

// ── §10 the onboarding signing step ───────────────────────────────────────────
const AVERY = 90121;
const AVERY_MAIL = "avery.onboard@example.com";
const CASEY_MAIL = "casey.example@example.com";
const STEP_VALUES = STEP_CONTACTS.flatMap(([name, , phone]) => [name, phone.slice(2)]);
// [what, flag, the driver's state (seedOnboarding()), then: status, emails, directory
// adds, notifications]. Five signed unless `signed` says otherwise.
const STEP_CASES = [
	["flag on, five signed, no contacts: stays at the step", true, { contacts: 0 }, "documents_pending", 0, 0, []],
	["flag on, five signed, one contact: stays at the step", true, { contacts: 1 }, "documents_pending", 0, 0, []],
	["flag on, five signed, two contacts: the step is done", true, { contacts: 2 }, "documents_signed", 2, 1, ["documents_signed"]],
	["flag on, four signed, two contacts: stays at the step", true, { signed: 4, contacts: 2 }, "documents_pending", 0, 0, []],
	["flag on, five signed, a passed drug test, no contacts: the pass cannot skip the step", true, { drug: "pass", contacts: 0 }, "documents_pending", 0, 0, []],
	["flag on, five signed, a passed drug test, two contacts: the step, then onboarded", true, { drug: "pass", contacts: 2 }, "fully_onboarded", 2, 2, ["documents_signed", "onboarding_complete"]],
	["flag on, documents_signed before the switch-on, a passed drug test, no contacts: onboarded", true, { status: "documents_signed", drug: "pass", contacts: 0 }, "fully_onboarded", 0, 1, ["onboarding_complete"]],
	["flag on, documents_signed, no drug test yet, no contacts: unchanged", true, { status: "documents_signed", contacts: 0 }, "documents_signed", 0, 0, []],
	["flag on, fully onboarded, no contacts: unchanged", true, { status: "fully_onboarded", drug: "pass", contacts: 0 }, "fully_onboarded", 0, 0, []],
	["flag on, four of the five and another document signed, two contacts: stays at the step", true, { signed: 4, extra: ["passenger_authorization"], contacts: 2 }, "documents_pending", 0, 0, []],
	["flag on, the five and another document signed, two contacts: the step is done", true, { extra: ["passenger_authorization"], contacts: 2 }, "documents_signed", 2, 1, ["documents_signed"]],
	["flag off, five signed, no contacts: the step is done, as before", false, { contacts: 0 }, "documents_signed", 2, 1, ["documents_signed"]],
	["flag off, four signed: stays, as before", false, { signed: 4, contacts: 0 }, "documents_pending", 0, 0, []],
	["flag off, five signed, a passed drug test: the step, then onboarded, as before", false, { drug: "pass", contacts: 0 }, "fully_onboarded", 2, 2, ["documents_signed", "onboarding_complete"]],
	["flag off, four of the five and another document signed: stays at the step", false, { signed: 4, extra: ["service_invoice"], contacts: 0 }, "documents_pending", 0, 0, []],
];
const statusOf = (db, userId) => db.prepare("SELECT status FROM driver_onboarding WHERE user_id = ?").get(userId).status;
const addsOf = (w) => w.synced.filter((s) => s.action === "add").length;

// checkAndCompleteOnboarding() and onboardingAddsJudgedRow() called as the sign and
// drug-test routes call them.
async function stepSection(c, src = SRC) {
	for (const [label, flag, state, status, mails, adds, notes] of STEP_CASES) {
		await inWorld(c, `§10 ${label}`, { src, flag, onboarding: { [AVERY]: { email: AVERY_MAIL, ...state } } }, async (w) => {
			const judged = w.fns.onboardingAddsJudgedRow(AVERY);
			const actor = { session: { user: { ...SESSIONS.sa } } };
			await w.fns.checkAndCompleteOnboarding(AVERY, actor);
			c.eq(`§10 ${label}: status, emails, directory adds, notifications`,
				[statusOf(w.db, AVERY), w.mail.length, addsOf(w), w.notes], [status, mails, adds, notes]);
			c.eq(`§10 ${label}: onboardingAddsJudgedRow() agrees, and Job Tracking is read only then`,
				[judged, w.jt.reads], [adds > 0, adds > 0 ? 1 : 0]);
			if (mails) {
				c.eq(`§10 ${label}: "Documents Received" goes to the driver and the admin inbox, holding no contact`,
					[w.mail.map((m) => m.to), leaks(JSON.stringify(w.mail), STEP_VALUES)], [[AVERY_MAIL, ADMIN_MAIL], []]);
			}
			await w.fns.checkAndCompleteOnboarding(AVERY, actor);
			c.eq(`§10 ${label}: a second check changes nothing`, [statusOf(w.db, AVERY), w.mail.length, addsOf(w)], [status, mails, adds]);
		});
	}
}

// The same step reached through the two PUTs.
async function stepRoutesSection(c, src = SRC) {
	const pending = { 90102: { email: CASEY_MAIL } };
	await inWorld(c, "§10 the driver's PUT", { src, onboarding: pending, record: true }, async (w) => {
		const one = await w.call("PUT", ME, { user: "casey", body: { contacts: [CASEY_LIST[0]] } });
		c.eq("§10 a driver at the step (five signed) saves one contact: 422 EMERGENCY_CONTACTS_MIN, still at the step, no email",
			[...answer(one), statusOf(w.db, 90102), w.mail.length], [422, "EMERGENCY_CONTACTS_MIN", "documents_pending", 0]);
		const two = await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST } });
		c.eq("§10 ...saves two: 200 with the list, documents_signed, the two emails, one directory add",
			[two.status, ((two.body && two.body.contacts) || []).length, statusOf(w.db, 90102), w.mail.map((m) => m.to), addsOf(w)],
			[200, 2, "documents_signed", [CASEY_MAIL, ADMIN_MAIL], 1]);
		c.ok("§10 ...and the Applications views are told (applications:changed)", w.notified.includes("applications"), JSON.stringify(w.notified));
		const ids = ((two.body && two.body.contacts) || []).map((x) => x.id);
		const again = await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST.map((x, i) => ({ ...x, id: ids[i] })) } });
		c.eq("§10 ...the same list again: 200, no second email, no second add", [again.status, statusOf(w.db, 90102), w.mail.length, addsOf(w)], [200, "documents_signed", 2, 1]);
	});
	await inWorld(c, "§10 the staff PUT", { src, onboarding: pending, record: true }, async (w) => {
		const r = await w.call("PUT", staffUrl(501), { user: "dispatcher", body: { contacts: CASEY_LIST } });
		c.eq("§10 a Dispatcher saves two contacts for a driver at the step: 200, documents_signed, the two emails",
			[r.status, statusOf(w.db, 90102), w.mail.map((m) => m.to)], [200, "documents_signed", [CASEY_MAIL, ADMIN_MAIL]]);
	});
	await inWorld(c, "§10 drivers past the step", { src, onboarding: { 90102: { status: "fully_onboarded", drug: "pass" }, 90103: { status: "documents_signed" } } }, async (w) => {
		const a = await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST } });
		const b = await w.call("PUT", ME, { user: "robin", body: { contacts: [EXTRA[1], EXTRA[2]] } });
		c.eq("§10 a fully onboarded and a documents_signed driver save: 200, unchanged, no email, no add, no applications event",
			[a.status, b.status, statusOf(w.db, 90102), statusOf(w.db, 90103), w.mail.length, w.synced.length, w.notified.includes("applications")],
			[200, 200, "fully_onboarded", "documents_signed", 0, 0, false]);
	});
	await inWorld(c, "§10 a failing step check", { src, onboarding: pending, failSync: true }, async (w) => {
		const before = quietErrors.length;
		const r = await w.call("PUT", ME, { user: "casey", body: { contacts: CASEY_LIST } });
		const logged = quietErrors.slice(before);
		c.eq("§10 the step check fails after the save: 200 with the list, both rows stored",
			[r.status, ((r.body && r.body.contacts) || []).length, rowsOf(w.db, 90102).length], [200, 2, 2]);
		c.ok("§10 ...one log line naming the failure's code, holding no contact value",
			logged.length === 1 && logged[0].includes("[emergency-contacts]") && logged[0].includes("SYNC_FAILED") && leaks(logged[0], CONTACT_VALUES).length === 0,
			JSON.stringify(logged));
	});
}

// ── §8 the pin ────────────────────────────────────────────────────────────────
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LIB_EXPORTS = realLib ? Object.keys(realLib) : [];
const TRACKED = ["driver_emergency_contacts", "emergency-contacts", "emergencyContactRules", "EMERGENCY_CONTACTS_ENABLED",
	"idx_emergency_contacts_user", ...SERVER_HELPERS, STEP_HELPER, ...LIB_EXPORTS];
const TRACKED_RE = new RegExp(`(?<![\\w$-])(?:${TRACKED.map(escapeRe).join("|")})(?![\\w$])`);
const DELETE_RE = /^removed\.driver_emergency_contacts = db\.prepare\("DELETE FROM driver_emergency_contacts WHERE user_id = \?"\)\.run\(id\)\.changes;$/;
const FLAG_LINE = 'const EMERGENCY_CONTACTS_ENABLED = process.env.EMERGENCY_CONTACTS_ENABLED === "true";';
const ALLOW_HEADS = [
	"const EMERGENCY_CONTACTS_ENABLED =",
	'try { db.exec("CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user ',
	'const emergencyContactRules = require("./lib/emergency-contacts");',
	"const emergencyContactsWriteLimiter = rateLimit(",
	...SERVER_HELPERS.filter((n) => n !== "emergencyContactsWriteLimiter").map(helperHead),
	`function ${STEP_HELPER}(`,
	...ROUTE_PREFIXES,
];
// The onboarding step's two callers name the shared rule on exactly these lines and
// name no other tracked name, so the emails checkAndCompleteOnboarding() sends can
// never carry a contact.
const STEP_CALLS = {
	"async function checkAndCompleteOnboarding(": `const step = ${STEP_HELPER}(userId, ob);`,
	"function onboardingAddsJudgedRow(": `if (!${STEP_HELPER}(userId, ob).stepDone) return false;`,
};
// Comments blanked, newlines kept, so a comment naming the table is not a
// mention. A scanner that knows strings, template and regex literals (the state
// machine of scripts/split/route-context.js scanSource()): a "/*" inside a line
// comment or a string must not start a block comment, or whole regions of
// server.js would vanish from the scan.
const REGEX_AFTER = new Set(["", "kw", "...", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const WORDS_BEFORE_EXPRESSION = new Set(["return", "typeof", "case", "in", "of", "new", "delete", "void", "throw", "else", "do", "instanceof", "yield", "await"]);
function blankComments(src) {
	const out = src.split("");
	const stack = [];
	let mode = "code";
	let quote = "";
	let inClass = false;
	let prev = "";
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (mode === "line") { if (ch === "\n") mode = "code"; else out[i] = " "; continue; }
		if (mode === "block") {
			if (ch === "*" && src[i + 1] === "/") { out[i] = " "; out[i + 1] = " "; i++; mode = "code"; } else if (ch !== "\n") out[i] = " ";
			continue;
		}
		if (mode === "string") {
			if (ch === "\\") { i++; continue; }
			if (ch === quote || ch === "\n") { mode = "code"; prev = "lit"; }
			continue;
		}
		if (mode === "template") {
			if (ch === "\\") { i++; continue; }
			if (ch === "`") { mode = "code"; prev = "lit"; continue; }
			if (ch === "$" && src[i + 1] === "{") { stack.push("${"); mode = "code"; prev = "("; i++; }
			continue;
		}
		if (mode === "regex") {
			if (ch === "\n") { mode = "code"; continue; }
			if (ch === "\\") { i++; continue; }
			if (inClass) { if (ch === "]") inClass = false; continue; }
			if (ch === "[") { inClass = true; continue; }
			if (ch === "/") { mode = "code"; while (/[A-Za-z]/.test(src[i + 1] || "")) i++; prev = "lit"; }
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;
		if (ch === "/") {
			if (src[i + 1] === "/") { mode = "line"; out[i] = " "; out[i + 1] = " "; i++; continue; }
			if (src[i + 1] === "*") { mode = "block"; out[i] = " "; out[i + 1] = " "; i++; continue; }
			if (REGEX_AFTER.has(prev)) { mode = "regex"; inClass = false; continue; }
			prev = "/";
			continue;
		}
		if (ch === '"' || ch === "'") { mode = "string"; quote = ch; continue; }
		if (ch === "`") { mode = "template"; continue; }
		if (ch === "(" || ch === "[" || ch === "{") { stack.push(ch); prev = ch; continue; }
		if (ch === ")" || ch === "]" || ch === "}") {
			if (stack.pop() === "${") { mode = "template"; continue; }
			prev = ch;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let j = i + 1;
			while (j < src.length && /[\w$]/.test(src[j])) j++;
			prev = prev !== "." && WORDS_BEFORE_EXPRESSION.has(src.slice(i, j)) ? "kw" : "w";
			i = j - 1;
			continue;
		}
		if (/[0-9]/.test(ch)) {
			let j = i + 1;
			while (j < src.length && /[\w.]/.test(src[j])) j++;
			prev = "w";
			i = j - 1;
			continue;
		}
		if (ch === "." && src[i + 1] === "." && src[i + 2] === ".") { prev = "..."; i += 2; continue; }
		prev = ch;
	}
	return out.join("");
}
// What the pin finds in `src`: { strays, missing, exempt }.
function pinFindings(src) {
	const code = blankComments(src).split("\n");
	const isHead = (l) => /^[^\s}\])`/]/.test(l);
	const headOf = (i) => { for (let j = i; j >= 0; j--) if (isHead(code[j])) return j; return -1; };
	const statementText = (j) => { let k = j + 1; while (k < code.length && !isHead(code[k])) k++; return code.slice(j, k).join("\n"); };
	const inReply = (j, i) => {
		for (let k = i - 1; k > j; k--) {
			const t = code[k].trim();
			if (t === "res.json({") return true;
			if (t === "});" || /^(if|for|while|const|let|return|try|await)\b|^\} catch\b/.test(t)) return false;
		}
		return false;
	};
	const strays = [];
	const exempt = { spread: [], del: [], step: Object.fromEntries(Object.keys(STEP_CALLS).map((h) => [h, []])) };
	let mentions = 0;
	code.forEach((l, i) => {
		if (!TRACKED_RE.test(l)) return;
		mentions++;
		const j = headOf(i);
		const head = j < 0 ? "" : code[j];
		if (ALLOW_HEADS.some((h) => head.startsWith(h))) return;
		if (head.startsWith("db.exec(") && statementText(j).includes("CREATE TABLE IF NOT EXISTS driver_emergency_contacts (")) return;
		if (head.startsWith(PAYLOAD_HEAD) && SPREAD_RE.test(l.trim()) && inReply(j, i)) { exempt.spread.push(i + 1); return; }
		if (head.startsWith('app.delete("/api/users/:id",') && DELETE_RE.test(l.trim())) { exempt.del.push(i + 1); return; }
		const stepHead = Object.keys(STEP_CALLS).find((h) => head.startsWith(h));
		if (stepHead && l.trim() === STEP_CALLS[stepHead]) { exempt.step[stepHead].push(i + 1); return; }
		strays.push(`line ${i + 1} (in ${head.slice(0, 70) || "?"}): ${l.trim().slice(0, 100)}`);
	});
	const missing = [];
	const count = (pred) => code.filter(pred).length;
	if (count((l) => l.includes("CREATE TABLE IF NOT EXISTS driver_emergency_contacts (")) !== 1) missing.push("the CREATE TABLE");
	if (count((l) => l.startsWith('try { db.exec("CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user ON driver_emergency_contacts(user_id)")')) !== 1) missing.push("the index");
	if (count((l) => l === FLAG_LINE) !== 1 || count((l) => l.startsWith("const EMERGENCY_CONTACTS_ENABLED =")) !== 1) missing.push("the flag, read once as exactly \"true\"");
	if (count((l) => l === 'const emergencyContactRules = require("./lib/emergency-contacts");') !== 1) missing.push("the require");
	if (count((l) => l.startsWith("const emergencyContactsWriteLimiter = rateLimit(")) !== 1) missing.push("the write limiter");
	for (const n of SERVER_HELPERS.filter((x) => x !== "emergencyContactsWriteLimiter")) {
		if (count((l) => l.startsWith(helperHead(n))) !== 1) missing.push(`${helperHead(n)})`);
	}
	if (count((l) => l.startsWith(`function ${STEP_HELPER}(`)) !== 1) missing.push(`function ${STEP_HELPER}()`);
	for (const p of ROUTE_PREFIXES) if (count((l) => l.startsWith(p)) !== 1) missing.push(p);
	if (exempt.spread.length !== 1) missing.push(`the payload spread (${exempt.spread.length} found)`);
	if (exempt.del.length !== 1) missing.push(`the user-delete DELETE (${exempt.del.length} found)`);
	for (const [h, lines] of Object.entries(exempt.step)) {
		if (lines.length !== 1) missing.push(`"${STEP_CALLS[h]}" in ${h}) (${lines.length} found)`);
	}
	return { strays, missing, exempt, mentions };
}
async function pinSection(c, src = SRC) {
	const f = pinFindings(src);
	c.eq("§8 no tracked name outside the allowlist", f.strays, []);
	c.eq("§8 every allowlisted place exists", f.missing, []);
	if (c === MAIN) {
		const step = Object.values(f.exempt.step).map((lines) => lines.join(", ") || "-").join(" and ");
		console.log(`  (${f.mentions} mention(s) checked; payload spread at line ${f.exempt.spread.join(", ") || "-"}, user-delete line at ${f.exempt.del.join(", ") || "-"}, the step's two calls at ${step})`);
	}
}
function pinExtras(c) {
	// No other lib/ file names a tracked name, but for the flag's one entry in the
	// replica's --enable allowlist (a classification, not a reader).
	const libDir = path.join(ROOT, "lib");
	const strayLib = [];
	let classified = 0;
	for (const f of fs.readdirSync(libDir).filter((x) => /\.(c|m)?js$/.test(x) && x !== "emergency-contacts.js")) {
		const lines = blankComments(fs.readFileSync(path.join(libDir, f), "utf8")).split("\n");
		lines.forEach((l, i) => {
			if (!TRACKED_RE.test(l)) return;
			if (f === "replica-rules.js" && l === '\t"EMERGENCY_CONTACTS_ENABLED",') { classified++; return; }
			strayLib.push(`lib/${f}:${i + 1}`);
		});
	}
	c.eq("§8 no other lib/ file names a tracked name", strayLib, []);
	c.eq("§8 ...the flag is classified once in lib/replica-rules.js", classified, 1);
	c.ok("§8 the tracked names include the module's exports", LIB_EXPORTS.length >= 10, `${LIB_EXPORTS.length}`);
	// No socket emit in the routes or the helpers: their one event is notifyChange("drivers").
	let lifted = "";
	try { lifted = liftRoutes(SRC).text; } catch (err) { c.ok("§8 the routes and helpers lift", false, err.message); }
	if (lifted) {
		const code = blankComments(lifted);
		const ownText = [...[...SERVER_HELPERS, STEP_HELPER].map((n) => {
			const at = code.indexOf(`function ${n}(`);
			return at < 0 ? "" : code.slice(at, code.indexOf("\n}\n", at));
		}), ...ROUTE_PREFIXES.map((p) => { const at = code.indexOf(p); return at < 0 ? "" : code.slice(at, code.indexOf("\n});", at)); })].join("\n");
		c.ok("§8 no io. or emit( in the routes or helpers", ownText.length > 0 && !/\bio\.|\.emit\(|\bemit\(/.test(ownText));
		c.eq("§8 their only event is notifyChange(\"drivers\")", [...new Set(ownText.match(/notifyChange\([^)]*\)/g) || [])], ['notifyChange("drivers")']);
	}
	// Every 200 the main run saw says private, no-store.
	const bad = SEEN_200.filter((r) => r.cache !== "private, no-store");
	c.ok(`§8 every 200 (${SEEN_200.length}) says Cache-Control: private, no-store`, SEEN_200.length >= 20 && bad.length === 0,
		bad.slice(0, 3).map((r) => `${r.method} ${r.url}: ${JSON.stringify(r.cache)}`).join("; "));
	// The order on each head: gate, then requireRole, then (a write) the limiter.
	for (const p of ROUTE_PREFIXES) {
		const head = linesStarting(SRC, p)[0] || "";
		const gate = head.indexOf("emergencyContactsFlagGate");
		const role = head.indexOf("requireRole(");
		const limiter = head.indexOf("emergencyContactsWriteLimiter");
		const write = p.startsWith("app.put(");
		c.ok(`§8 ${p} the gate, then requireRole${write ? ", then the limiter" : ", no limiter"}`,
			gate > 0 && role > gate && (write ? limiter > role : limiter < 0), head.slice(0, 160));
	}
	const roles = ROUTE_PREFIXES.map((p) => ((linesStarting(SRC, p)[0] || "").match(/requireRole\(([^)]*)\)/) || [])[1]);
	c.eq("§8 the role lists", roles, ['"Driver"', '"Driver"', '"Super Admin", "Dispatcher"', '"Super Admin", "Dispatcher"']);
	// The limiter's budget.
	const at = SRC.indexOf("\nconst emergencyContactsWriteLimiter = rateLimit({");
	const def = at < 0 ? "" : SRC.slice(at, SRC.indexOf("\n});", at));
	c.ok("§8 the limiter: 15 minutes, 30 writes, keyed per account", /windowMs: 15 \* 60 \* 1000,/.test(def) && /max: 30,/.test(def) && /`u:\$\{id\}`/.test(def), def.slice(0, 120));
}

// ── §9 mutants ────────────────────────────────────────────────────────────────
// `build` returns the mutated server.js text, or { lib } for a mutant of the
// module the server requires; either must differ from the shipped one.
async function mutant(id, label, build, run) {
	let made = null;
	try { made = build(); } catch (err) {
		MAIN.ok(`§9 ${id}: ${label} — the mutation applies`, false, err.message);
		MAIN.ok(`§9 ${id}: ${label} — is caught`, false, "not evaluated");
		return;
	}
	const applied = typeof made === "string" ? made !== SRC : !!(made && made.lib && made.lib !== realLib);
	MAIN.ok(`§9 ${id}: ${label} — the mutation applies`, applied);
	if (!applied) { MAIN.ok(`§9 ${id}: ${label} — is caught`, false, "not evaluated"); return; }
	const c = checker(false);
	try { await run(c, made); } catch (err) { c.failed.push(`threw: ${err.message}`); }
	MAIN.ok(`§9 ${id}: ${label} — is caught (${c.failed.length} check(s) flip)`, c.failed.length > 0);
}

(async () => {
	console.log("\n§1 flag off");
	await flagOffSection(MAIN);
	console.log("\n§2 the role matrix");
	await rolesSection(MAIN, SRC, true);
	console.log("\n§3 another driver");
	await otherDriverSection(MAIN, SRC, true);
	console.log("\n§4 the refusal codes");
	await refusalsSection(MAIN, SRC, true);
	console.log("\n§5 writes and their audit rows");
	await writesSection(MAIN, SRC, { record: true });
	console.log("\n§6 the staff routes");
	await staffSection(MAIN, SRC, true);
	console.log("\n§7 the driver payload's spread");
	await payloadSection(MAIN);
	// Before §8, so the private, no-store check covers its 200s too.
	console.log("\n§10 the onboarding signing step");
	await stepSection(MAIN);
	await stepRoutesSection(MAIN);
	console.log("\n§8 the pin");
	await pinSection(MAIN);
	pinExtras(MAIN);

	console.log("\n§9 mutants");
	await mutant("M1", "the flag gate removed", () => mutate(SRC, "function emergencyContactsFlagGate(req, res, next) {\n", "function emergencyContactsFlagGate(req, res, next) {\n\treturn next();\n"),
		(c, src) => flagOffSection(c, src));
	await mutant("M2", "Investor added to the staff GET's roles", () => mutate(SRC,
		'app.get("/api/drivers-directory/:id/emergency-contacts", emergencyContactsFlagGate, requireRole("Super Admin", "Dispatcher")',
		'app.get("/api/drivers-directory/:id/emergency-contacts", emergencyContactsFlagGate, requireRole("Super Admin", "Dispatcher", "Investor")'),
		(c, src) => rolesSection(c, src));
	await mutant("M3", "the membership test removed", () => mutate(SRC, "\t\tif (stray) return { strayId: stray.id };\n", ""),
		(c, src) => otherDriverSection(c, src));
	await mutant("M4", "the audit detail unmasked", () => {
		if (!realLib) throw new Error("lib/emergency-contacts.js is missing");
		return { lib: { ...realLib, auditDetail: (kind, facts) => `${realLib.auditDetail(kind, facts)} ${JSON.stringify(facts)}` } };
	}, (c, made) => writesSection(c, SRC, { lib: made.lib }));
	await mutant("M5", "a tracked name planted in GET /api/investor", () => {
		const head = lineStarting(SRC, 'app.get("/api/investor", ');
		return mutate(SRC, `\n${head}\n`, `\n${head}\n\temergencyContactsCount(0);\n`);
	}, async (c, src) => pinSection(c, src));
	await mutant("M6", "the payload counted by the URL's driver name", () => mutate(SRC,
		"onFile: emergencyContactsCount(req.session.user.id) } } : {}),",
		"onFile: emergencyContactsCount(req.params.driverName) } } : {}),"),
		(c, src) => payloadSection(c, src));
	await mutant("M7", "the documents_signed step ignoring the contacts", () => mutate(SRC,
		'if (step.stepDone && ob.status === "documents_pending") {',
		'if (step.requiredSigned && ob.status === "documents_pending") {'),
		(c, src) => stepSection(c, src));
	await mutant("M8", "the fully_onboarded step ignoring the contacts", () => mutate(SRC,
		'if (step.stepDone && ob.drug_test_result === "pass") {',
		'if (step.requiredSigned && ob.drug_test_result === "pass") {'),
		(c, src) => stepSection(c, src));
	await mutant("M9", "onboardingAddsJudgedRow() ignoring the contacts", () => mutate(SRC,
		`if (!${STEP_HELPER}(userId, ob).stepDone) return false;`,
		`if (!${STEP_HELPER}(userId, ob).requiredSigned) return false;`),
		(c, src) => stepSection(c, src));
	await mutant("M10", "the step ignoring the flag", () => mutate(SRC,
		"const contactsOk = !EMERGENCY_CONTACTS_ENABLED || emergencyContactsCount(userId) >= emergencyContactRules.MIN_CONTACTS;",
		"const contactsOk = true;"),
		(c, src) => stepSection(c, src));
	await mutant("M11", "a driver already past the step held back too", () => mutate(SRC,
		'stepDone: requiredSigned && (contactsOk || ob.status !== "documents_pending")',
		"stepDone: requiredSigned && contactsOk"),
		(c, src) => stepSection(c, src));
	await mutant("M12", "every signed document counted, one outside ONBOARDING_DOCS too", () => mutate(SRC,
		"const requiredSigned = ONBOARDING_DOCS.every((d) => signed.has(d.key));",
		"const requiredSigned = signed.size === ONBOARDING_DOCS.length;"),
		(c, src) => stepSection(c, src));
	await mutant("M13", "the PUTs' step check removed", () => mutate(SRC,
		'\t\tif (ob && ob.status === "documents_pending") await checkAndCompleteOnboarding(userId, req);\n', ""),
		(c, src) => stepRoutesSection(c, src));

	console.log(`\ntest-emergency-contacts-routes: ${passed} passed, ${failures.length} failed`);
	if (failures.length) {
		if (quietErrors.length) console.log(`server log (last 5): ${quietErrors.slice(-5).join(" | ")}`);
		process.exit(1);
	}
})().catch((err) => {
	console.error("test run threw:", err && err.stack);
	process.exit(1);
});
