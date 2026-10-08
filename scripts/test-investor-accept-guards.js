#!/usr/bin/env node
/**
 * Accepting an investor application is refused before anything is written
 * when it would collide, and otherwise writes everything in one transaction.
 *
 * PUT /api/investor-applications/:id/status with "Accepted" creates the
 * investor's account, their investors record and one truck per vehicle. It is
 * refused, with nothing written and the application left as it was, when
 * another investors record already holds the company name the new record would
 * take (carrier_name = the DBA, else the legal name; compared trimmed and
 * case-insensitively) → 409 INVESTOR_RECORD_CONFLICT, naming it; and when an
 * account that is not an Investor (a Driver, a Dispatcher, a Super Admin) has
 * the applicant's email → 409 USER_ALREADY_EXISTS, naming its role and id.
 * When only Investor accounts have the email, the application is marked
 * Accepted and nothing else is written or sent: 200 { success: true,
 * accountCreated: false, existingUserId, message }, the status and its audit
 * row in one transaction.
 * It is also refused, nothing written, when the company name the new account
 * takes (the DBA, else the legal name) links a driver whose history reaches a
 * finalized month to its ledger → 409 PERIOD_FINALIZED, audited as
 * accept_investor_blocked (investorCompanyLockBlockers(), 2026-10-08).
 * bcrypt.hash and the Job Tracking read for that lock are the handler's only
 * awaits and run first; the checks read the state after them, and the status,
 * account, record and trucks are written in one synchronous transaction. The
 * emails are sent after it commits.
 *
 * WHAT IS ASSERTED. The shipped handler is lifted out of server.js with the
 * helpers it calls (registerApplicationVehicles, colLetter, parseTruckAmount,
 * escapeHtml) and run against an in-memory SQLite whose users table is built
 * from server.js's own DDL; investors carries the production UNIQUE index on
 * carrier_name.
 *   §1 company-name collision: the second of two same-name applications is
 *      409 INVESTOR_RECORD_CONFLICT (naming the record), in any case or
 *      spacing, and against a hand-added record; nothing written, no mail.
 *   §2 an email already on an Investor account (in any case): 200,
 *      accountCreated false, the account's id, the agreed message naming it;
 *      the status Accepted with an audit row saying so; no account, record or
 *      truck written and no mail. A status write that fails writes no audit
 *      row. The same email on a Driver, Dispatcher or Super Admin account, or
 *      on an Investor AND a Driver account: 409 USER_ALREADY_EXISTS with the
 *      agreed words naming the non-investor account; nothing written (the
 *      status stays, no audit row), no mail. Two Investor accounts: the
 *      lowest id is named.
 *   §3 the success path: status, account, investors record and trucks all
 *      written, the audit line and both emails after.
 *   §4 one transaction: a write that fails part-way leaves no account, no
 *      record, no truck and the status as it was, and sends no mail.
 *   §5 the state is read AFTER the await: an account with the email that
 *      appears while the password hashes is found (nothing created; a Driver
 *      account refused), and a colliding record that appears then is still
 *      refused.
 *   §6 unchanged: re-accepting an application whose record exists, New /
 *      Reviewed / Rejected, a removed application (409) and a missing one (404).
 *   §7 source pins: the only awaits are bcrypt.hash and the Job Tracking read,
 *      above the first read; none
 *      between the re-read and the transaction; the record INSERT is not
 *      OR IGNORE; the emails follow the transaction; the existing-account
 *      branch writes the status and its audit row in one transaction and
 *      nothing else.
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
 *      role check dropped (any account's email accepted, the old form), the
 *      status written before the checks; the letter-or-digit test, the email
 *      fallback, the application-id fallback, the name-clash test and (with the
 *      name-clash test off, since it compares usernames too) the trimmed
 *      comparison each dropped.
 *   §10 the month-end lock on the new account's company name, with server.js's
 *      own investorsHoldingDriver() and lock helpers: a DBA that links a driver
 *      with finalized-month history (a carrier name an earlier rename left in
 *      the carrier history) is 409 PERIOD_FINALIZED, nothing written, no mail,
 *      audited; one that links only a new hire, or nobody, is accepted; Job
 *      Tracking unreadable holds a linked driver in every finalized month.
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

// The month-end lock on the new account's company name, judging nothing: §1-§9
// are about the other checks, and §10 hands in server.js's own (lockFor()).
const NO_COMPANY_LOCK = {
	getJobTrackingCached: async () => ({ headers: [], data: [] }),
	investorCompanyLockBlockers: () => null,
	periodBlockedResponse: () => { throw new Error("no refusal expected"); },
	periodLockUnreadableResponse: () => { throw new Error("no refusal expected"); },
	auditText: (v, max) => String(v ?? "").slice(0, max),
};

// Runs the lifted handler once. `duringHash` runs inside the first await.
async function accept(db, appId, { status = "Accepted", routeSrc = ACCEPT_SRC, duringHash = null, lock = NO_COMPANY_LOCK } = {}) {
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
	// The payout basis the acceptance records is scripts/test-payout-basis-routes.js's
	// subject; here these applications sign the standard contract, so none is.
	const lockNames = Object.keys(NO_COMPANY_LOCK);
	const lockEnv = typeof lock === "function" ? lock(audits) : lock;
	new Function("app", "requireRole", "db", "bcrypt", "crypto", "logAudit", "notifyChange", "colLetter", "escapeHtml", "sendEmail", "parseTruckAmount", "registerApplicationVehicles", "findDriverNameClash", "recordSignedPayoutBasis", "unrecordedLeaseNote", "ADMIN_NOTIFY_EMAIL", ...lockNames, routeSrc)(
		{ put: (p, guard, h) => { handler = h; } }, () => (req, res, next) => next(), db, bcrypt, crypto,
		(req, action, entity, entityId, details) => audits.push({ action, entityId, details }), () => {}, colLetter, escapeHtml,
		(to, subject) => { mail.push({ to, subject }); return Promise.resolve(true); }, parseTruckAmount, registerApplicationVehicles, findDriverNameClash,
		() => null, () => "", "admin@example.test", ...lockNames.map((k) => lockEnv[k]));
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
	const holder = Number(db.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('inv_a', 'x', 'Investor', '', 'Account.A@Example.test')").run().lastInsertRowid);
	const c = addApplication(db, { legal_name: "Different Co", email: "account.a@example.test" });
	// Everything but the statuses: what an acceptance must not write here.
	const written = () => { const s = JSON.parse(snapshot(db)); delete s.statuses; return JSON.stringify(s); };
	const before = written();
	const x = await accept(db, c, { routeSrc });
	t(x.status === 200 && JSON.stringify(x.body) === JSON.stringify({
		success: true, accountCreated: false, existingUserId: holder,
		message: EXISTING_INVESTOR_MESSAGE(holder),
	}), `§2 an email already on an Investor account (another case): 200, accountCreated false, the account named (got ${x.status} ${JSON.stringify(x.body)})`);
	t(statusOf(db, c) === "Accepted", "§2 ...the application is Accepted");
	t(written() === before && x.mail.length === 0, "§2 ...no account, investor record or truck written, and no mail");
	t(x.audits.length === 1 && x.audits[0].action === "accept_investor_existing_account" && x.audits[0].entityId === c
		&& new RegExp(`already on user ${holder} \\(Investor\\).*no account, investor record or trucks were created and no email was sent \\[USER_ALREADY_EXISTS\\]$`).test(x.audits[0].details),
	`§2 ...and one audit row says so (got ${JSON.stringify(x.audits)})`);

	// The audit row is written after the status, inside its transaction: a
	// status write that fails leaves no audit row and the application as it was.
	const d = makeDb();
	d.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('inv_b', 'x', 'Investor', '', 'b@example.test')").run();
	const e = addApplication(d, { legal_name: "Other Co", email: "b@example.test" });
	d.exec("CREATE TRIGGER refuse_status BEFORE UPDATE ON investor_applications BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
	const y = await accept(d, e, { routeSrc });
	t(y.status === 500 && y.audits.length === 0 && statusOf(d, e) === "New" && y.mail.length === 0,
		`§2 a status write that fails: 500, no audit row, the application still New (got ${y.status} ${JSON.stringify(y.audits)})`);

	// The email on an account that is not an Investor: refused, nothing written.
	const cases = [
		// [what, the accounts holding the email (role, driver name), the one named]
		["a Driver account", [["Driver", "QA Test Driver"]], 0],
		["a Dispatcher account", [["Dispatcher", ""]], 0],
		["an Investor account and a Driver account", [["Investor", ""], ["Driver", "QA Test Driver Two"]], 1],
	];
	for (const [what, holders, named] of cases) {
		const f = makeDb();
		const ids = holders.map(([role, driverName], i) => Number(f.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES (?, 'x', ?, ?, ?)")
			.run(`qa_holder_${i}`, role, driverName, i ? "shared@example.test" : "Shared@Example.test").lastInsertRowid));
		const g = addApplication(f, { legal_name: "Shared Email Co", email: "shared@example.test" });
		const all = snapshot(f);
		const z = await accept(f, g, { routeSrc });
		const [role] = holders[named];
		t(z.status === 409 && JSON.stringify(z.body) === JSON.stringify({ error: NOT_INVESTOR_ERROR(role, ids[named]), code: "USER_ALREADY_EXISTS" }),
			`§2 the email on ${what}: 409 USER_ALREADY_EXISTS naming ${role} #${ids[named]} (got ${z.status} ${JSON.stringify(z.body)})`);
		t(snapshot(f) === all && statusOf(f, g) === "New" && z.audits.length === 0 && z.mail.length === 0,
			`§2 ...nothing written for ${what}: the application still New, no account, record, truck or audit row, and no mail`);
	}
	// The fixture's own Super Admin (user 1) holds ops@logisx.example.
	const s = makeDb();
	const sa = addApplication(s, { legal_name: "Admin Email Co", email: "OPS@logisx.example" });
	const sx = await accept(s, sa, { routeSrc });
	t(sx.status === 409 && sx.body.code === "USER_ALREADY_EXISTS" && sx.body.error === NOT_INVESTOR_ERROR("Super Admin", 1) && statusOf(s, sa) === "New",
		`§2 the email on the Super Admin account: 409 naming Super Admin #1 (got ${sx.status} ${JSON.stringify(sx.body)})`);
	// Two Investor accounts with the email: the lowest id is named.
	const w = makeDb();
	const first = Number(w.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('inv_w1', 'x', 'Investor', '', 'w@example.test')").run().lastInsertRowid);
	w.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('inv_w2', 'x', 'Investor', '', 'W@example.test')").run();
	const wa = addApplication(w, { legal_name: "Twice Co", email: "w@example.test" });
	const wx = await accept(w, wa, { routeSrc });
	t(wx.status === 200 && wx.body.existingUserId === first && wx.body.message === EXISTING_INVESTOR_MESSAGE(first),
		`§2 two Investor accounts with the email: 200 naming the lowest id, #${first} (got ${wx.status} ${JSON.stringify(wx.body)})`);
	return r;
}
const EXISTING_INVESTOR_MESSAGE = (id) => `Accepted. This application's email matches Investor account #${id}, so no new account, investor record or trucks were created. Confirm it is the same person before acting on its banking or vehicle details.`;
const NOT_INVESTOR_ERROR = (role, id) => `An account with this email already exists (${role} #${id}) and it is not an investor account, so this application can't be accepted with that email.`;

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
	t(x.audits.some((a) => a.action === "accept_investor") && x.mail.length === 2 && x.mail.some((m) => m.to === "owner@acme.example.test") && x.mail.some((m) => m.to === "admin@example.test"),
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
		let late = null;
		const x = await accept(db, id, { duringHash: (d) => { late = Number(d.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('late', 'x', 'Investor', '', 'late@example.test')").run().lastInsertRowid); } });
		t(x.status === 200 && x.body.accountCreated === false && x.body.existingUserId === late && statusOf(db, id) === "Accepted"
			&& db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 2 && db.prepare("SELECT COUNT(*) AS n FROM investors").get().n === 0 && x.mail.length === 0,
		`§5 an account with the email created while the password hashes: found, nothing created (got ${x.status} ${JSON.stringify(x.body)})`);
	}
	{
		const db = makeDb();
		const id = addApplication(db, { legal_name: "Late Driver Co", email: "late3@example.test" });
		let late = null;
		const x = await accept(db, id, { duringHash: (d) => { late = Number(d.prepare("INSERT INTO users (username, password_hash, role, driver_name, email) VALUES ('late3', 'x', 'Driver', 'Late Driver', 'late3@example.test')").run().lastInsertRowid); } });
		t(x.status === 409 && x.body.code === "USER_ALREADY_EXISTS" && x.body.error.includes(`(Driver #${late})`) && statusOf(db, id) === "New"
			&& db.prepare("SELECT COUNT(*) AS n FROM investors").get().n === 0,
		`§5 a Driver account with the email created while the password hashes: still refused (got ${x.status} ${JSON.stringify(x.body)})`);
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
	t(awaits.length === 2 && /await bcrypt\.hash\(tempPassword, 10\)/.test(awaits[0]) && /await getJobTrackingCached\(\)/.test(awaits[1]),
		`§7 the only awaits are bcrypt.hash and the Job Tracking read (got ${JSON.stringify(awaits)})`);
	const hashAt = src.indexOf("await bcrypt.hash");
	const jtAt = src.indexOf("await getJobTrackingCached()");
	const reread = src.indexOf('db.prepare("SELECT id, deleted_at FROM investor_applications WHERE id = ?")');
	const txAt = src.indexOf("const { userId, vehicleCounts, payoutBasis } = db.transaction(");
	t(hashAt > 0 && hashAt < src.indexOf("db.prepare("), "§7 the hash runs before the first read");
	t(jtAt > hashAt && jtAt < src.indexOf("db.prepare("), "§7 ...and so does the Job Tracking read");
	const lockAt = src.indexOf("investorCompanyLockBlockers(");
	t(lockAt > reread && lockAt < txAt, "§7 the company-name lock is judged after the re-read and before the transaction");
	t(reread > hashAt && txAt > reread && !/\bawait\b/.test(src.slice(reread, txAt)), "§7 no await between the re-read and the transaction");
	const tx = src.slice(txAt, src.indexOf("})();", txAt));
	t(/setStatus\.run\(status, appId\)/.test(tx) && /INSERT INTO users/.test(tx) && /INSERT INTO investors/.test(tx) && /registerApplicationVehicles\(vehicles, appId, userId\)/.test(tx)
		&& /recordSignedPayoutBasis\(req, \{ applicationId: appId, ownerId: userId, investorId \}\)/.test(tx),
		"§7 the status, the account, the record, the trucks and the payout basis are written inside the transaction");
	t(!/INSERT OR IGNORE INTO investors/.test(src), "§7 the record INSERT is not OR IGNORE (a collision must not be skipped silently)");
	t(src.indexOf("sendEmail(") > src.indexOf("})();", txAt), "§7 the emails are sent after the transaction");
	const beforeTx = src.slice(0, txAt);
	t(!/setStatus\.run\(/.test(beforeTx.slice(0, beforeTx.indexOf("const previous"))), "§7 no status is written before the checks");
	const existingAt = src.indexOf("if (emailHolder) {");
	const existing = existingAt > 0 ? src.slice(existingAt, src.indexOf("\n\t\t\t}\n", existingAt)) : "";
	const existingTx = existing.slice(existing.indexOf("db.transaction("), existing.indexOf("})();"));
	t(/^db\.transaction\(\(\) => \{\s*setStatus\.run\(status, appId\);\s*logAudit\(req, "accept_investor_existing_account"/.test(existingTx),
		"§7 the existing-account branch writes the status, then its audit row, in one transaction");
	t(existing.length > 0 && !/INSERT|sendEmail\(|registerApplicationVehicles\(/.test(existing) && /return res\.json\(/.test(existing),
		"§7 ...and writes nothing else, sends nothing, and answers there");
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
	t(failed(await emailSection(swap(ACCEPT_SRC, 'const otherRole = emailHolders.find((u) => u.role !== "Investor");', "const otherRole = null;"))),
		"MUTANT the role check dropped (any account's email accepted, the old form): caught by §2");
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
	t(failed(await companyLockSection(swap(ACCEPT_SRC, "if (companyLock && (companyLock.unreadable || companyLock.blockers.length)) {", "if (false) {"))),
		"MUTANT the company-name lock dropped: caught by §10");
	return r;
}

// ─────────────────────────────────────────────────────── §10 the company-name lock
// server.js's own month-end lock on the new account's company name, over the
// tables it reads. "" when a helper is missing (a base commit), and §10 then
// fails rather than the runner dying.
function liftNamed(name) {
	const needle = `\nfunction ${name}(`;
	if (SRC.split(needle).length - 1 !== 1) return "";
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
const LOCK_HELPERS = ["investorAccountState", "investorCompanyMoves", "investorCompanyLockBlockers"];
const LOCK_SRC = [
	(SRC.match(/\nconst AUDITED_UPSTREAM = [^\n]*\n/) || [""])[0],
	...["normalizeDriverName", "findCol", "getCarrierDBFromSQLite", "getInvestorDriverSet", "driverPayLockedMonths", "lockedPeriodsDesc", "periodLockStmt", "periodLocksReadable",
		"periodLabel", "scrubPurgeMarker", "auditText", "periodBlockedResponse", "periodLockUnreadableResponse", ...LOCK_HELPERS].map(liftNamed),
].join("\n");
const LOCKED = ["2026-06", "2026-07", "2026-08"];
// driverHistoryFloorMonth()'s answer per driver; without Job Tracking nothing can be dated.
const FLOORS = { "hank history": { floor: "2026-07", unbounded: false } };

function makeLockDb() {
	const db = makeDb();
	db.exec(`
		ALTER TABLE drivers_directory ADD COLUMN carrier_name TEXT DEFAULT '';
		ALTER TABLE trucks ADD COLUMN assigned_driver TEXT DEFAULT '';
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER, driver_name TEXT, start_date TEXT, end_date TEXT DEFAULT '');
		CREATE TABLE carrier_driver_history (id INTEGER PRIMARY KEY AUTOINCREMENT, carrier_name TEXT, driver_name TEXT, started_at TEXT, ended_at TEXT);
		CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked');
	`);
	for (const p of LOCKED) db.prepare("INSERT INTO period_locks (period) VALUES (?)").run(p);
	// A carrier name an earlier rename left in the carrier history, no investors
	// record holding it; and a new hire filed under another company.
	db.prepare("INSERT INTO carrier_driver_history (carrier_name, driver_name, started_at) VALUES ('Old Acme Name', 'Hank History', '2026-07-03T15:00:00.000Z')").run();
	db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name) VALUES ('Gil New', 'Gamma Haul')").run();
	return db;
}
// The `lock` accept() hands the route: server.js's helpers over `db`, the
// refusal recorded beside the route's own audit rows.
function lockFor(db, { jtFails = false } = {}) {
	return (audits) => {
		const m = new Function("db", "driverHistoryFloorMonth", "recordPeriodRefusal",
			`"use strict";\n${LOCK_SRC}\nreturn { ${["auditText", "periodBlockedResponse", "periodLockUnreadableResponse", ...LOCK_HELPERS].filter((n) => LOCK_SRC.includes(`\nfunction ${n}(`) || LOCK_SRC.startsWith(`function ${n}(`)).join(", ")} };`)(
			db,
			(name, jt) => (jt ? FLOORS[String(name || "").trim().toLowerCase()] || { floor: "", unbounded: false } : { floor: "", unbounded: true }),
			(audit, code, periods) => audits.push({ action: audit.action, entityId: audit.entityId, details: `${audit.subject} [${code}] periods=${periods.join(",")}` }));
		return {
			...NO_COMPANY_LOCK, ...m,
			getJobTrackingCached: async () => { if (jtFails) throw new Error("Job Tracking could not be read"); return { headers: ["Load ID", "Driver"], data: [] }; },
		};
	};
}

async function companyLockSection(routeSrc = ACCEPT_SRC) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	t(LOCK_HELPERS.every((n) => liftNamed(n)), `§10 server.js defines ${LOCK_HELPERS.join(", ")}`);
	const drivers = (x) => (x.body && Array.isArray(x.body.blockers) ? x.body.blockers.flatMap((b) => b.drivers || []) : []);
	for (const dba of ["Old Acme Name", "  OLD ACME name "]) {
		const db = makeLockDb();
		const id = addApplication(db, { legal_name: "Acme Holdings LLC", dba, email: "acme@example.test" });
		const before = snapshot(db);
		const x = await accept(db, id, { routeSrc, lock: lockFor(db) });
		t(x.status === 409 && x.body && x.body.code === "PERIOD_FINALIZED" && JSON.stringify(x.body.periods) === JSON.stringify(["2026-07", "2026-08"])
			&& JSON.stringify(drivers(x)) === JSON.stringify(["Hank History"]),
		`§10 a DBA (${JSON.stringify(dba)}) that links a driver with finalized-month history: 409 PERIOD_FINALIZED over 2026-07, 2026-08 naming the driver (got ${x.status} ${JSON.stringify(x.body && x.body.code)})`);
		t(typeof (x.body && x.body.error) === "string" && /Hank History/.test(x.body.error) && /July 2026/.test(x.body.error), "§10 ...the reason names the driver and the months");
		t(snapshot(db) === before && statusOf(db, id) === "New" && x.mail.length === 0, "§10 ...nothing written (no account, record or truck, still New), no mail");
		t(x.audits.some((a) => a.action === "accept_investor_blocked" && a.entityId === String(id) && /\[PERIOD_FINALIZED\]/.test(a.details)),
			"§10 ...audited as accept_investor_blocked [PERIOD_FINALIZED]");
	}
	for (const [label, fields, company] of [
		["a DBA that links only a new hire (no finalized-month history)", { legal_name: "Gamma Holdings LLC", dba: "Gamma Haul" }, "Gamma Haul"],
		["no DBA, a legal name that links nobody", { legal_name: "Fresh Start Hauling LLC", dba: "" }, "Fresh Start Hauling LLC"],
	]) {
		const db = makeLockDb();
		const id = addApplication(db, { ...fields, email: "ok@example.test" });
		const x = await accept(db, id, { routeSrc, lock: lockFor(db) });
		const userId = x.body && x.body.credentials && x.body.credentials.userId;
		const row = userId ? db.prepare("SELECT role, company_name FROM users WHERE id = ?").get(userId) : null;
		t(x.status === 200 && x.body.accountCreated === true && row && row.role === "Investor" && row.company_name === company,
			`§10 ${label}: accepted, the account's company name ${JSON.stringify(company)} (got ${x.status} ${JSON.stringify(row)})`);
	}
	{
		const db = makeLockDb();
		const id = addApplication(db, { legal_name: "Gamma Holdings LLC", dba: "Gamma Haul", email: "jt@example.test" });
		const before = snapshot(db);
		const x = await accept(db, id, { routeSrc, lock: lockFor(db, { jtFails: true }) });
		t(x.status === 409 && x.body.code === "PERIOD_FINALIZED" && JSON.stringify(x.body.periods) === JSON.stringify(LOCKED) && snapshot(db) === before,
			`§10 Job Tracking unreadable, a DBA that links a driver: 409 over every finalized month, nothing written (got ${x.status} ${JSON.stringify(x.body && x.body.periods)})`);
	}
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
	section("§10 the month-end lock on the new account's company name");
	record(await companyLockSection());
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
