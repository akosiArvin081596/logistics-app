#!/usr/bin/env node
/**
 * Accepting an investor application is refused before anything is written
 * when it would collide, and otherwise writes everything in one transaction.
 *
 * PUT /api/investor-applications/:id/status with "Accepted" creates the
 * investor's account, their investors record and one truck per vehicle. It is
 * refused, with nothing written and the application left as it was, when:
 *   - an account already has the applicant's email → 409 USER_ALREADY_EXISTS;
 *   - another investors record already holds the company name the new record
 *     would take (carrier_name = the DBA, else the legal name; compared trimmed
 *     and case-insensitively) → 409 INVESTOR_RECORD_CONFLICT, naming it.
 * bcrypt.hash is the handler's only await and runs first; the checks read the
 * state after it, and the status, account, record and trucks are written in
 * one synchronous transaction. The emails are sent after it commits.
 *
 * WHAT IS ASSERTED. The shipped handler is lifted out of server.js with the
 * helpers it calls (registerApplicationVehicles, colLetter, parseTruckAmount,
 * escapeHtml) and run against an in-memory SQLite whose users table is built
 * from server.js's own DDL; investors carries the production UNIQUE index on
 * carrier_name.
 *   §1 company-name collision: the second of two same-name applications is
 *      409 INVESTOR_RECORD_CONFLICT (naming the record), in any case or
 *      spacing, and against a hand-added record; nothing written, no mail.
 *   §2 email collision: 409 USER_ALREADY_EXISTS in any case; nothing written.
 *   §3 the success path: status, account, investors record and trucks all
 *      written, the audit line and both emails after.
 *   §4 one transaction: a write that fails part-way leaves no account, no
 *      record, no truck and the status as it was, and sends no mail.
 *   §5 the state is read AFTER the await: a colliding account or record that
 *      appears while the password hashes is still refused.
 *   §6 unchanged: re-accepting an application whose record exists, New /
 *      Reviewed / Rejected, a removed application (409) and a missing one (404).
 *   §7 source pins: the only await is bcrypt.hash, above the first read; none
 *      between the re-read and the transaction; the record INSERT is not
 *      OR IGNORE; the emails follow the transaction.
 *   §8 the username: folded to a-z, 0-9 and "." from the legal name, else the
 *      email's local part, else investor<application id>, the first that keeps
 *      a letter or a digit; a number appended while it is taken: an account's
 *      username (trimmed, any case), or a name findDriverNameClash() finds — a
 *      reserved name ("Dispatch", "Investor", a built-in property name, also
 *      when the legal name only folds to one) or a driver's name (a directory
 *      row, or a Driver account's driver name). A legal name in another script
 *      or of punctuation only used to give "" (then "1") or ".". Every username
 *      made is found by the sign-in lookup as this account and no other.
 *   §9 MUTANTS: the company-name check dropped, the email check dropped, the
 *      status written before the checks; the letter-or-digit test, the email
 *      fallback, the application-id fallback, the name-clash test and (with the
 *      name-clash test off, since it compares usernames too) the trimmed
 *      comparison each dropped.
 *
 * Pure: no server, no app.db, no network, no mail (sendEmail is captured).
 *
 * Run: node scripts/test-investor-accept-guards.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
function liftRoute(head) {
	const hits = SRC.split(head).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(head);
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
function liftFunction(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return SRC.slice(a, end + 2);
}
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const ACCEPT_SRC = liftRoute('app.put("/api/investor-applications/:id/status", requireRole("Super Admin"), async (req, res) => {');
const escapeHtml = new Function(`${liftFunction("function escapeHtml(s) {")}\nreturn escapeHtml;`)();
const colLetter = new Function(`${liftFunction("function colLetter(idx) {")}\nreturn colLetter;`)();
const parseTruckAmount = (() => {
	const m = SRC.match(/\nconst TRUCK_AMOUNT_MAX = [^\n]*\n/);
	if (!m) die("could not locate TRUCK_AMOUNT_MAX");
	return new Function(`${m[0].trim()}\n${liftFunction("function parsePlainDecimal(raw) {")}\n${liftFunction('function parseTruckAmount(raw, label = "Amount", max = TRUCK_AMOUNT_MAX) {')}\nreturn parseTruckAmount;`)();
})();
const REGISTER_SRC = liftFunction("function registerApplicationVehicles(vehicles, appId, userId) {");
// The naming check the username candidates go through, with what it calls.
const CLASH_SRC = [
	"function normalizeDriverName(s) {",
	"function isBuiltInPropertyName(name) {",
	"function findDriverNameClashes(name, opts = {}) {",
	"function findDriverNameClash(name, opts = {}) {",
].map(liftFunction).join("\n");

// ── fixtures ────────────────────────────────────────────────────────────────
const USERS_DDL = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	const alters = ["full_name", "company_name", "must_change_password"].map((col) => {
		const a = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
		if (!a) die(`could not locate the users.${col} migration`);
		return a[0];
	});
	return [`CREATE TABLE users (${m[1]}\n)`, ...alters];
})();
if (!SRC.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_carrier ON investors(carrier_name)")) die("the investors.carrier_name UNIQUE index moved");

function makeDb() {
	const db = new Database(":memory:");
	for (const sql of USERS_DDL) db.exec(sql);
	db.exec(`
		CREATE TABLE investor_applications (
			id INTEGER PRIMARY KEY AUTOINCREMENT, legal_name TEXT NOT NULL, dba TEXT DEFAULT '',
			entity_type TEXT DEFAULT '', address TEXT DEFAULT '', contact_person TEXT DEFAULT '',
			contact_title TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', ein_ssn TEXT DEFAULT '',
			tax_classification TEXT DEFAULT '', vehicles_json TEXT DEFAULT '[]', status TEXT DEFAULT 'New',
			deleted_at TEXT DEFAULT NULL
		);
		CREATE TABLE investors (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT NOT NULL DEFAULT '',
			carrier_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Active', notes TEXT NOT NULL DEFAULT '',
			application_id INTEGER DEFAULT 0, entity_type TEXT DEFAULT '', address TEXT DEFAULT '', phone TEXT DEFAULT '',
			email TEXT DEFAULT '', ein_ssn TEXT DEFAULT '', tax_classification TEXT DEFAULT '', contact_person TEXT DEFAULT '',
			contact_title TEXT DEFAULT ''
		);
		CREATE UNIQUE INDEX idx_inv_carrier ON investors(carrier_name);
		CREATE TABLE trucks (
			id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT, model TEXT, year INTEGER,
			vin TEXT, license_plate TEXT, status TEXT, owner_id INTEGER, purchase_price REAL,
			title_status TEXT, title_state TEXT, notes TEXT
		);
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE);
	`);
	db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('super_admin', 'x', 'Super Admin', '', 'ops@logisx.example')").run();
	return db;
}
const TWO_VEHICLES = JSON.stringify([
	{ year: "2021", make: "Freightliner", model: "Cascadia", vin: "1FUJGLDR0MLAA0001" },
	{ year: "2019", make: "Volvo", model: "VNL", vin: "4V4NC9EH0KN000002" },
]);
function addApplication(db, fields = {}) {
	const row = { legal_name: "Same Name Hauling LLC", dba: "", email: "p@example.test", vehicles_json: TWO_VEHICLES, ...fields };
	return Number(db.prepare("INSERT INTO investor_applications (legal_name, dba, email, vehicles_json) VALUES (?, ?, ?, ?)")
		.run(row.legal_name, row.dba, row.email, row.vehicles_json).lastInsertRowid);
}
// Everything an acceptance could write.
const snapshot = (db) => JSON.stringify({
	users: db.prepare("SELECT id, username, email FROM users ORDER BY id").all(),
	investors: db.prepare("SELECT * FROM investors ORDER BY id").all(),
	trucks: db.prepare("SELECT * FROM trucks ORDER BY id").all(),
	statuses: db.prepare("SELECT id, status FROM investor_applications ORDER BY id").all(),
});
const statusOf = (db, id) => db.prepare("SELECT status FROM investor_applications WHERE id = ?").get(id).status;

// Runs the lifted handler once. `duringHash` runs inside the only await.
async function accept(db, appId, { status = "Accepted", routeSrc = ACCEPT_SRC, duringHash = null } = {}) {
	let handler = null;
	const mail = [];
	const audits = [];
	const registerApplicationVehicles = new Function("db", "colLetter", "parseTruckAmount",
		`${REGISTER_SRC}\nreturn registerApplicationVehicles;`)(db, colLetter, parseTruckAmount);
	const findDriverNameClash = new Function("db", `${CLASH_SRC}\nreturn findDriverNameClash;`)(db);
	const bcrypt = {
		hash: async (pw) => {
			await new Promise((done) => setImmediate(done));
			if (duringHash) duringHash(db);
			return `hashed:${pw.length}`;
		},
	};
	new Function("app", "requireRole", "db", "bcrypt", "crypto", "logAudit", "notifyChange", "colLetter", "escapeHtml", "sendEmail", "parseTruckAmount", "registerApplicationVehicles", "findDriverNameClash", routeSrc)(
		{ put: (p, guard, h) => { handler = h; } }, () => (req, res, next) => next(), db, bcrypt, crypto,
		(req, action, entity, entityId, details) => audits.push({ action, entityId, details }), () => {}, colLetter, escapeHtml,
		(to, subject) => { mail.push({ to, subject }); return Promise.resolve(true); }, parseTruckAmount, registerApplicationVehicles, findDriverNameClash);
	if (typeof handler !== "function") die("the lifted route did not register a handler");
	const out = { status: 200, body: null };
	const e = console.error;
	console.error = () => {};
	try {
		await handler({ params: { id: String(appId) }, body: { status }, session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } },
			{ status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } });
	} finally { console.error = e; }
	return { ...out, mail, audits };
}

// ─────────────────────────────────────────────────────── §1 company name
async function nameSection(routeSrc = ACCEPT_SRC) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const p = addApplication(db, { email: "p@example.test" });
	const q = addApplication(db, { email: "q@example.test" });
	const q2 = addApplication(db, { legal_name: "  same NAME hauling llc ", email: "q2@example.test" });
	const first = await accept(db, p, { routeSrc });
	t(first.status === 200 && first.body.accountCreated === true, `§1 the first application (P) is accepted (got ${first.status} ${JSON.stringify(first.body)})`);
	const before = snapshot(db);
	for (const [label, id] of [["Q, the same legal name", q], ["Q2, the same name in another case and spacing", q2]]) {
		const x = await accept(db, id, { routeSrc });
		t(x.status === 409 && x.body && x.body.code === "INVESTOR_RECORD_CONFLICT" && /"Same Name Hauling LLC"/.test(x.body.error || ""),
			`§1 ${label}: 409 INVESTOR_RECORD_CONFLICT naming P's record (got ${x.status} ${JSON.stringify(x.body)})`);
		t(x.mail.length === 0, `§1 ...and no mail for ${label}`);
		t(x.audits.some((a) => a.action === "accept_investor_blocked" && /\[INVESTOR_RECORD_CONFLICT\]/.test(a.details)), `§1 ...and the refusal is audited for ${label}`);
	}
	t(snapshot(db) === before, "§1 ...nothing written: no account, record or truck, both still New");
	t(statusOf(db, q) === "New" && statusOf(db, q2) === "New", "§1 ...Q and Q2 are not left Accepted");

	// A hand-added record holds the DBA an application would use.
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (NULL, 'Acme Holdings', 'Acme')").run();
	const d = addApplication(db, { legal_name: "Acme Trucking Partners", dba: "ACME ", email: "d@example.test" });
	const dx = await accept(db, d, { routeSrc });
	t(dx.status === 409 && dx.body.code === "INVESTOR_RECORD_CONFLICT" && /"Acme Holdings"/.test(dx.body.error), `§1 a DBA held by a hand-added record: 409 naming it (got ${dx.status} ${JSON.stringify(dx.body)})`);
	return r;
}

// ─────────────────────────────────────────────────────── §2 email
async function emailSection(routeSrc = ACCEPT_SRC) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('inv_a', 'x', 'Investor', '', 'Account.A@Example.test')").run();
	const c = addApplication(db, { legal_name: "Different Co", email: "account.a@example.test" });
	const before = snapshot(db);
	const x = await accept(db, c, { routeSrc });
	t(x.status === 409 && x.body && x.body.code === "USER_ALREADY_EXISTS", `§2 an email already on an account (another case): 409 USER_ALREADY_EXISTS (got ${x.status} ${JSON.stringify(x.body)})`);
	t(snapshot(db) === before && statusOf(db, c) === "New" && x.mail.length === 0, "§2 ...nothing written, the application still New, no mail");
	t(x.audits.some((a) => a.action === "accept_investor_blocked" && /\[USER_ALREADY_EXISTS\]/.test(a.details)), "§2 ...and the refusal is audited");
	return r;
}

// ─────────────────────────────────────────────────────── §3 success
async function successSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const id = addApplication(db, { legal_name: "Acme Hauling LLC", dba: "Acme", email: "owner@acme.example.test" });
	const x = await accept(db, id);
	const creds = (x.body && x.body.credentials) || {};
	t(x.status === 200 && x.body.accountCreated === true && JSON.stringify(x.body.vehicles) === JSON.stringify({ created: 2, existing: 0, heldByOther: 0, failed: 0 }),
		`§3 accepted: 200, account created, two trucks (got ${x.status} ${JSON.stringify(x.body)})`);
	const u = db.prepare("SELECT * FROM users WHERE id = ?").get(creds.userId) || {};
	const inv = db.prepare("SELECT * FROM investors WHERE user_id = ?").get(creds.userId) || {};
	const trucks = db.prepare("SELECT unit_number, owner_id FROM trucks ORDER BY unit_number").all();
	t(statusOf(db, id) === "Accepted" && u.role === "Investor" && u.must_change_password === 1 && u.password_hash === "hashed:8",
		"§3 the status, the account (Investor, forced password change, the hashed temporary password) are written");
	t(inv.application_id === id && inv.carrier_name === "Acme" && inv.full_name === "Acme Hauling LLC", "§3 ...the investors record, carrying the DBA as its company name");
	t(trucks.length === 2 && trucks.every((tr) => tr.owner_id === creds.userId) && trucks[0].unit_number === `INV-${id}-A`, "§3 ...and the trucks, owned by the new account");
	t(x.audits.some((a) => a.action === "accept_investor") && x.mail.length === 2 && x.mail.some((m) => m.to === "owner@acme.example.test") && x.mail.some((m) => m.to === "info@logisx.com"),
		"§3 the acceptance is audited and both emails are sent");
	return r;
}

// ─────────────────────────────────────────────────────── §4 atomicity
async function atomicSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const id = addApplication(db, { legal_name: "Boom Freight", email: "boom@example.test" });
	db.exec("CREATE TRIGGER refuse_investor BEFORE INSERT ON investors BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
	const before = snapshot(db);
	const x = await accept(db, id);
	t(x.status === 500, `§4 a write that fails inside the acceptance answers 500 (got ${x.status})`);
	t(snapshot(db) === before && statusOf(db, id) === "New", "§4 ...and rolls back: no account, no record, no truck, the status as it was");
	t(x.mail.length === 0, "§4 ...and no mail is sent");
	db.exec("DROP TRIGGER refuse_investor");
	const retry = await accept(db, id);
	t(retry.status === 200 && statusOf(db, id) === "Accepted", `§4 ...so the retry goes through (got ${retry.status} ${JSON.stringify(retry.body)})`);
	return r;
}

// ─────────────────────────────────────────────────────── §5 read after the await
async function raceSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	{
		const db = makeDb();
		const id = addApplication(db, { legal_name: "Late Email Co", email: "late@example.test" });
		const x = await accept(db, id, { duringHash: (d) => d.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('late', 'x', 'Investor', '', 'late@example.test')").run() });
		t(x.status === 409 && x.body.code === "USER_ALREADY_EXISTS" && statusOf(db, id) === "New",
			`§5 an account with the email created while the password hashes: still 409 (got ${x.status} ${JSON.stringify(x.body)})`);
	}
	{
		const db = makeDb();
		const id = addApplication(db, { legal_name: "Late Name Co", email: "late2@example.test" });
		const x = await accept(db, id, { duringHash: (d) => d.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (NULL, 'Late Name Co', 'Late Name Co')").run() });
		t(x.status === 409 && x.body.code === "INVESTOR_RECORD_CONFLICT" && statusOf(db, id) === "New" && db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 1,
			`§5 a record with the name created while the password hashes: still 409, no account (got ${x.status} ${JSON.stringify(x.body)})`);
	}
	return r;
}

// ─────────────────────────────────────────────────────── §6 unchanged
async function unchangedSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	const id = addApplication(db, { legal_name: "Again Co", email: "again@example.test" });
	await accept(db, id);
	await accept(db, id, { status: "Reviewed" });
	t(statusOf(db, id) === "Reviewed", "§6 an accepted application can be set back to Reviewed");
	const before = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
	const again = await accept(db, id);
	t(again.status === 200 && again.body.accountCreated === false && statusOf(db, id) === "Accepted" && db.prepare("SELECT COUNT(*) AS n FROM users").get().n === before && again.mail.length === 0,
		`§6 re-accepting an application whose record exists: Accepted again, nothing created, no mail (got ${again.status} ${JSON.stringify(again.body)})`);
	for (const status of ["Reviewed", "Rejected", "New"]) {
		const d = makeDb();
		const a = addApplication(d);
		const x = await accept(d, a, { status });
		t(x.status === 200 && JSON.stringify(x.body) === JSON.stringify({ success: true }) && statusOf(d, a) === status && d.prepare("SELECT COUNT(*) AS n FROM users").get().n === 1 && x.mail.length === 0,
			`§6 status "${status}": set, nothing else (got ${x.status} ${JSON.stringify(x.body)})`);
	}
	const bad = await accept(db, id, { status: "Approved" });
	t(bad.status === 400, "§6 an unknown status is 400");
	const gone = addApplication(db, { legal_name: "Gone Co", email: "gone@example.test" });
	db.prepare("UPDATE investor_applications SET deleted_at = '2026-09-30' WHERE id = ?").run(gone);
	const del = await accept(db, gone);
	t(del.status === 409 && del.body.code === "APPLICATION_DELETED" && statusOf(db, gone) === "New", "§6 a removed application: 409 APPLICATION_DELETED, unchanged");
	const missing = await accept(db, 9999);
	t(missing.status === 404, "§6 a missing application: 404");
	return r;
}

// ─────────────────────────────────────────────────────── §7 source pins
function pinSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const src = code(ACCEPT_SRC);
	const awaits = [...src.matchAll(/\bawait\b[^\n]*/g)].map((m) => m[0]);
	t(awaits.length === 1 && /await bcrypt\.hash\(tempPassword, 10\)/.test(awaits[0]), `§7 the only await is bcrypt.hash (got ${JSON.stringify(awaits)})`);
	const hashAt = src.indexOf("await bcrypt.hash");
	const reread = src.indexOf('db.prepare("SELECT id, deleted_at FROM investor_applications WHERE id = ?")');
	const txAt = src.indexOf("db.transaction(");
	t(hashAt > 0 && hashAt < src.indexOf("db.prepare("), "§7 the hash runs before the first read");
	t(reread > hashAt && txAt > reread && !/\bawait\b/.test(src.slice(reread, txAt)), "§7 no await between the re-read and the transaction");
	const tx = src.slice(txAt, src.indexOf("})();", txAt));
	t(/setStatus\.run\(status, appId\)/.test(tx) && /INSERT INTO users/.test(tx) && /INSERT INTO investors/.test(tx) && /registerApplicationVehicles\(vehicles, appId, userId\)/.test(tx),
		"§7 the status, the account, the record and the trucks are written inside the transaction");
	t(!/INSERT OR IGNORE INTO investors/.test(src), "§7 the record INSERT is not OR IGNORE (a collision must not be skipped silently)");
	t(src.indexOf("sendEmail(") > src.indexOf("})();", txAt), "§7 the emails are sent after the transaction");
	const beforeTx = src.slice(0, txAt);
	t(!/setStatus\.run\(/.test(beforeTx.slice(0, beforeTx.indexOf("const previous"))), "§7 no status is written before the checks");
	return r;
}

// ─────────────────────────────────────────────────────── §8 the username
// The sign-in lookup, as POST /api/auth/login runs it on the trimmed input
// (which refuses an empty username before it gets here).
const signInMatches = (db, typed) => db.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)")
	.all(typed.trim(), typed.trim()).map((u) => u.id);

async function usernameSection(routeSrc = ACCEPT_SRC) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const db = makeDb();
	// Accounts already on file: a username stored with spaces around it (as
	// POST /api/users stored it before it trimmed), and one in capitals.
	db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES (' trimmed.co ', 'x', 'Investor', '', 'old1@example.test')").run();
	db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('Taken.Name.LLC', 'x', 'Investor', '', 'old2@example.test')").run();
	// Drivers: two one-word names in the directory (the second is the first's
	// numbered candidate), and a Driver account whose driver name is one word,
	// stored with spaces around it.
	db.prepare("INSERT INTO drivers_directory (driver_name) VALUES ('Qatestsolo'), ('Qatestsolo1')").run();
	db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('LogisX-0101', 'x', 'Driver', ' Onename ', 'old3@example.test')").run();
	const TRADE_MARK = String.fromCodePoint(0x2122);
	const cases = [
		// [what, legal name, email, the username expected (given the application id), a user to add first]
		["a non-Latin legal name: the email's local part", "株式会社テスト", "QA.Owner+One@example.test", () => "qa.ownerone"],
		["a punctuation-only legal name with a space (it gave \".\")", "&& &&", "p-q_r@example.test", () => "pqr"],
		["a punctuation-only legal name", "---", "dash.co@example.test", () => "dash.co"],
		["a non-Latin legal name, an email local part with no letter or digit: investor<id>", "テスト合同会社", "___@example.test", (id) => `investor${id}`],
		["a non-Latin legal name and no email: investor<id>", "有限会社テスト", "", (id) => `investor${id}`],
		["a Latin legal name: from the name, as before", "Acme Hauling LLC", "someone@example.test", () => "acme.hauling.llc"],
		["the same email local part again (another domain): a number appended", "合資会社テスト", "qa.owner+one@other.example.test", () => "qa.ownerone1"],
		["a username held with spaces around it: a number appended", "株式会社トリム", "trimmed.co@example.test", () => "trimmed.co1"],
		["a username held in another case: a number appended", "Taken Name LLC", "new3@example.test", () => "taken.name.llc1"],
		["investor<id> already taken: a number appended", "合同会社テスト二", "", (id) => `investor${id}1`, (id) => `investor${id}`],
		["the reserved name \"Dispatch\" (the dispatch desk): a number appended", "Dispatch", "desk1@example.test", () => "dispatch1"],
		["\"Dis-patch\", which folds to the reserved name: past dispatch1 too", "Dis-patch", "desk2@example.test", () => "dispatch2"],
		["\"Dispatch\" and a trade mark sign, which folds to the reserved name", `Dispatch${TRADE_MARK}`, "desk3@example.test", () => "dispatch3"],
		["an email local part that is the reserved name", "株式会社デスク", "dispatch@example.test", () => "dispatch4"],
		["the reserved name \"Investor\"", "Investor", "inv@example.test", () => "investor1"],
		["a built-in property name", "Constructor", "proto@example.test", () => "constructor1"],
		["a one-word driver name in the directory: past the driver holding its numbered candidate too", "QATESTSOLO", "solo@example.test", () => "qatestsolo2"],
		["a one-word driver name on a Driver account, stored with spaces around it", "Onename", "one@example.test", () => "onename1"],
	];
	for (const [what, legal, email, expected, existing] of cases) {
		const id = addApplication(db, { legal_name: legal, email, vehicles_json: "[]" });
		if (existing) db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES (?, 'x', 'Investor', '', '')").run(existing(id));
		const x = await accept(db, id, { routeSrc });
		const creds = (x.body && x.body.credentials) || {};
		const stored = (db.prepare("SELECT username FROM users WHERE id = ?").get(creds.userId) || {}).username;
		const u = creds.username;
		t(x.status === 200 && u === expected(id) && stored === u,
			`§8 ${what}: ${JSON.stringify(expected(id))} (got ${x.status} ${JSON.stringify(u)}, stored ${JSON.stringify(stored)})`);
		t(typeof u === "string" && /^[a-z0-9.]+$/.test(u) && /[a-z0-9]/.test(u) && JSON.stringify(signInMatches(db, u)) === JSON.stringify([creds.userId]),
			`§8 ...a login-safe username that signs in as this account and no other (${JSON.stringify(u)})`);
		if (x.status !== 200) break;
	}
	return r;
}

// ─────────────────────────────────────────────────────── §9 mutants
async function mutantSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const failed = (results) => results.some((x) => !x.ok);
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	t(failed(await nameSection(swap(ACCEPT_SRC, "if (nameHolder) {", "if (false) {"))), "MUTANT the company-name check dropped: caught by §1");
	t(failed(await emailSection(swap(ACCEPT_SRC, "if (emailHolder) {", "if (false) {"))), "MUTANT the email check dropped: caught by §2");
	const early = swap(ACCEPT_SRC, 'const setStatus = db.prepare("UPDATE investor_applications SET status=? WHERE id=?");',
		'const setStatus = db.prepare("UPDATE investor_applications SET status=? WHERE id=?");\n\t\tsetStatus.run(status, appId);');
	t(failed(await nameSection(early)), "MUTANT the status written before the checks: caught by §1");
	t(failed(await usernameSection(swap(ACCEPT_SRC, ".find((u) => /[a-z0-9]/.test(u))", ".find((u) => typeof u === \"string\")"))),
		"MUTANT the letter-or-digit test dropped (the old empty username): caught by §8");
	t(failed(await usernameSection(swap(ACCEPT_SRC, '[fullName, email.split("@")[0]]', "[fullName]"))),
		"MUTANT the email fallback dropped: caught by §8");
	t(failed(await usernameSection(swap(ACCEPT_SRC, "|| `investor${appId}`", '|| ""'))),
		"MUTANT the application-id fallback dropped: caught by §8");
	const noClash = swap(ACCEPT_SRC, "\n\t\t\t\t|| !!findDriverNameClash(candidate);", ";");
	t(failed(await usernameSection(noClash)), "MUTANT the name-clash test dropped (reserved names, driver names): caught by §8");
	// findDriverNameClash() compares usernames too (trimmed, any case), so the
	// SQL test's trim is only observable with the name-clash test off.
	t(failed(await usernameSection(swap(noClash, 'SELECT id FROM users WHERE LOWER(TRIM(username)) = LOWER(?)', 'SELECT id FROM users WHERE LOWER(username) = LOWER(?)'))),
		"MUTANT the taken-username test not trimmed (the name-clash test off): caught by §8");
	return r;
}

function record(results) {
	for (const x of results) ok(x.ok, x.name);
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

(async () => {
	section("§1 company-name collision");
	record(await nameSection());
	section("§2 email collision");
	record(await emailSection());
	section("§3 the success path");
	record(await successSection());
	section("§4 one transaction");
	record(await atomicSection());
	section("§5 state read after the await");
	record(await raceSection());
	section("§6 unchanged behaviour");
	record(await unchangedSection());
	section("§7 source pins");
	record(pinSection());
	section("§8 the username");
	record(await usernameSection());
	section("§9 mutants");
	record(await mutantSection());

	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
