#!/usr/bin/env node
/**
 * An investor account minted by accepting an investor application must be
 * forced to change its emailed temporary password, exactly like a driver's.
 *
 * Accepting an investor application (PUT /api/investor-applications/:id/status
 * with status "Accepted") creates the account, generates an 8-hex-char
 * temporary password and emails it. Like the driver acceptance
 * (PUT /api/applications/:id/status), it sets users.must_change_password = 1 on
 * the account it creates, and since PR #357 the server enforces that flag in
 * requireAuth / requireRole for every role.
 *
 * WHAT IS ASSERTED:
 *   §1 the SHIPPED route, lifted out of server.js and run against an in-memory
 *      SQLite whose users table is built from server.js's own CREATE/ALTERs:
 *      the new Investor row carries must_change_password = 1, the emailed
 *      temporary password is the stored credential, and #357's
 *      currentMustChangePassword() reports the account as forced
 *   §2 NOTHING ELSE about acceptance changed: the investors row, the trucks
 *      from the application's vehicles, company_name, the response shape, the
 *      "user already exists" short-circuit, and non-Accepted statuses
 *   §3 EVERY route that mints an emailed temporary password sets the flag in
 *      the INSERT that creates the account (today: driver + investor), so a
 *      third such route cannot quietly skip it
 *   §4 DISCRIMINATION: an INSERT without the flag must be caught
 *
 * Pure: no server, no app.db, no network, no mail (sendEmail is captured).
 *
 * Run: node scripts/test-investor-temp-password.js    # exits 1 on failure
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

let Database, bcrypt;
try {
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
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

const ACCEPT_HEAD = 'app.put("/api/investor-applications/:id/status", requireRole("Super Admin"), async (req, res) => {';
const DRIVER_ACCEPT_HEAD = 'app.put("/api/applications/:id/status", requireRole("Super Admin"), async (req, res) => {';
const ACCEPT_SRC = liftRoute(ACCEPT_HEAD);
const DRIVER_ACCEPT_SRC = liftRoute(DRIVER_ACCEPT_HEAD);
const ESCAPE_SRC = liftFunction("function escapeHtml(s) {");
const COL_LETTER_SRC = liftFunction("function colLetter(idx) {");
// The acceptance writes the vehicles through this helper (its own subject is
// scripts/test-investor-accept-vehicles.js).
const REGISTER_VEHICLES_SRC = liftFunction("function registerApplicationVehicles(vehicles, appId, userId) {");
const CURRENT_FLAG_SRC = liftFunction("function currentMustChangePassword(sessionUser) {");
// The reader of each vehicle's purchase price, with the ceiling it reads (its
// own subject is scripts/test-truck-cost-amounts.js §6).
const PARSE_AMOUNT_SRC = (() => {
	const m = SRC.match(/\nconst TRUCK_AMOUNT_MAX = [^\n]*\n/);
	if (!m) die("could not locate TRUCK_AMOUNT_MAX");
	return `${m[0].trim()}\n${liftFunction("function parsePlainDecimal(raw) {")}\n${liftFunction('function parseTruckAmount(raw, label = "Amount", max = TRUCK_AMOUNT_MAX) {')}`;
})();

const USERS_CREATE = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	return `CREATE TABLE users (${m[1]}\n)`;
})();
const USERS_ALTERS = ["full_name", "company_name", "must_change_password", "last_login_at"].map((col) => {
	const m = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
	if (!m) die(`could not locate the users.${col} migration`);
	return m[0];
});

// ── fixtures ────────────────────────────────────────────────────────────────
function makeDb() {
	const db = new Database(":memory:");
	db.exec(USERS_CREATE);
	for (const alter of USERS_ALTERS) db.exec(alter);
	// The columns the route reads and writes; these tables' own correctness is
	// not what is under test here.
	db.exec(`
		CREATE TABLE investor_applications (
			id INTEGER PRIMARY KEY AUTOINCREMENT, legal_name TEXT NOT NULL, dba TEXT DEFAULT '',
			entity_type TEXT DEFAULT '', address TEXT DEFAULT '', contact_person TEXT DEFAULT '',
			contact_title TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', ein_ssn TEXT DEFAULT '',
			tax_classification TEXT DEFAULT '', vehicles_json TEXT DEFAULT '[]', status TEXT DEFAULT 'New',
			deleted_at TEXT DEFAULT NULL
		);
		CREATE TABLE investors (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT, carrier_name TEXT,
			status TEXT, application_id INTEGER, entity_type TEXT, address TEXT, phone TEXT, email TEXT,
			ein_ssn TEXT, tax_classification TEXT, contact_person TEXT, contact_title TEXT
		);
		CREATE TABLE trucks (
			id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT UNIQUE, make TEXT, model TEXT, year INTEGER,
			vin TEXT, license_plate TEXT, status TEXT, owner_id INTEGER, purchase_price REAL,
			title_status TEXT, title_state TEXT, notes TEXT
		);
	`);
	return db;
}

function addApplication(db, fields = {}) {
	const row = {
		legal_name: "Acme Hauling LLC", dba: "Acme", entity_type: "LLC", email: "owner@acme.example.test",
		vehicles_json: JSON.stringify([
			{ year: "2021", make: "Freightliner", model: "Cascadia", vin: "1FUJGLDR0MLAA0001", status: "Active", purchasePrice: "98000" },
			{ year: "2019", make: "Volvo", model: "VNL", vin: "4V4NC9EH0KN000002" },
		]),
		...fields,
	};
	return Number(db.prepare(
		"INSERT INTO investor_applications (legal_name, dba, entity_type, email, vehicles_json) VALUES (?, ?, ?, ?, ?)",
	).run(row.legal_name, row.dba, row.entity_type, row.email, row.vehicles_json).lastInsertRowid);
}

// Runs the lifted handler. bcrypt is the real bcryptjs at cost 4 (the route
// asks for 10), so the stored hash is a real one the emailed password must match.
async function accept(db, appId, { status = "Accepted", routeSrc = ACCEPT_SRC } = {}) {
	let handler = null;
	const app = { put: (p, guard, h) => { handler = h; } };
	const requireRole = () => (req, res, next) => next();
	const fastBcrypt = { hash: (pw) => bcrypt.hash(pw, 4), compare: bcrypt.compare };
	const mail = [];
	const sendEmail = (to, subject, html) => { mail.push({ to, subject, html }); return Promise.resolve(true); };
	const escapeHtml = new Function(`${ESCAPE_SRC}\nreturn escapeHtml;`)();
	const colLetter = new Function(`${COL_LETTER_SRC}\nreturn colLetter;`)();
	const parseTruckAmount = new Function(`${PARSE_AMOUNT_SRC}\nreturn parseTruckAmount;`)();
	const registerApplicationVehicles = new Function("db", "colLetter", "parseTruckAmount",
		`${REGISTER_VEHICLES_SRC}\nreturn registerApplicationVehicles;`)(db, colLetter, parseTruckAmount);
	new Function("app", "requireRole", "db", "bcrypt", "crypto", "logAudit", "notifyChange", "colLetter", "escapeHtml", "sendEmail", "parseTruckAmount", "registerApplicationVehicles", routeSrc)(
		app, requireRole, db, fastBcrypt, crypto, () => {}, () => {}, colLetter, escapeHtml, sendEmail, parseTruckAmount, registerApplicationVehicles);
	if (typeof handler !== "function") die("the lifted route did not register a handler");
	const out = { status: 200, body: null };
	const res = {
		status(c) { out.status = c; return this; },
		json(b) { out.body = b; return this; },
	};
	await handler({
		params: { id: String(appId) }, body: { status },
		session: { user: { id: 99, username: "super_admin", role: "Super Admin" } },
	}, res);
	return { ...out, mail };
}

// ─────────────────────────────── §1 the new investor must change the password
async function sectionFlag() {
	const db = makeDb();
	const appId = addApplication(db);
	const r = await accept(db, appId);
	ok(r.status === 200 && r.body && r.body.success === true && r.body.accountCreated === true,
		`§1 accepting the application must create the account (got ${r.status} ${JSON.stringify(r.body)})`);
	const creds = (r.body && r.body.credentials) || {};
	const row = db.prepare("SELECT * FROM users WHERE id = ?").get(creds.userId);
	ok(!!row && row.role === "Investor", "§1 the created account must be an Investor");
	ok(!!row && row.must_change_password === 1,
		`§1 THE NEW INVESTOR ACCOUNT MUST CARRY must_change_password = 1, as a new driver's does (got ${row && row.must_change_password})`);
	ok(!!row && typeof creds.tempPassword === "string" && /^[0-9a-f]{8}$/.test(creds.tempPassword) && bcrypt.compareSync(creds.tempPassword, row.password_hash),
		"§1 the temporary password handed out must be the stored credential");
	const welcome = r.mail.find((m) => m.to === "owner@acme.example.test");
	ok(!!welcome && welcome.html.includes(creds.tempPassword) && welcome.html.includes(creds.username),
		"§1 the welcome email must still carry the username and the temporary password");

	// #357's gate reads the flag from the database on every request; the new
	// account must read as forced even through a session copy that says not.
	const currentMustChangePassword = new Function("db", `${CURRENT_FLAG_SRC}\nreturn currentMustChangePassword;`)(db);
	ok(currentMustChangePassword({ id: creds.userId, mustChangePassword: false }) === true,
		"§1 the server-side gate (currentMustChangePassword) must report the new investor as forced to change the password");
	return db;
}

// ─────────────────────────────── §2 nothing else about acceptance changed
async function sectionUnchanged() {
	const db = makeDb();
	const appId = addApplication(db);
	const r = await accept(db, appId);
	const creds = (r.body && r.body.credentials) || {};
	// Every field the response has carried is kept; `vehicles` (what became of
	// each vehicle on the application) was added after it.
	ok(JSON.stringify(Object.keys(r.body || {})) === JSON.stringify(["success", "accountCreated", "credentials", "vehicles"]) &&
		JSON.stringify(Object.keys(creds)) === JSON.stringify(["username", "tempPassword", "userId", "investorName"]) &&
		JSON.stringify((r.body || {}).vehicles) === JSON.stringify({ created: 2, existing: 0, heldByOther: 0, failed: 0 }),
		`§2 the response shape must be unchanged, plus the vehicle counts: ${JSON.stringify(r.body)}`);
	ok(creds.username === "acme.hauling.llc" && creds.investorName === "Acme Hauling LLC",
		`§2 the username derivation must be unchanged (got ${creds.username})`);
	const u = db.prepare("SELECT * FROM users WHERE id = ?").get(creds.userId) || {};
	ok(u.email === "owner@acme.example.test" && u.full_name === "Acme Hauling LLC" && u.company_name === "Acme" && u.driver_name === "",
		`§2 the account's other columns must be unchanged: ${JSON.stringify({ email: u.email, full_name: u.full_name, company_name: u.company_name, driver_name: u.driver_name })}`);
	const inv = db.prepare("SELECT * FROM investors WHERE user_id = ?").get(creds.userId);
	ok(!!inv && inv.application_id === appId && inv.carrier_name === "Acme" && inv.status === "Active",
		"§2 the investors row must still be created from the application");
	const trucks = db.prepare("SELECT unit_number, owner_id FROM trucks ORDER BY unit_number").all();
	ok(trucks.length === 2 && trucks.every((t) => t.owner_id === creds.userId) && trucks[0].unit_number === `INV-${appId}-A`,
		`§2 the application's vehicles must still become trucks owned by the new account: ${JSON.stringify(trucks)}`);
	ok(r.mail.length === 2 && r.mail.some((m) => m.to === "info@logisx.com"), "§2 both emails must still be sent (applicant + admin)");
	ok(db.prepare("SELECT status FROM investor_applications WHERE id = ?").get(appId).status === "Accepted",
		"§2 the application must be marked Accepted");

	// A second application from the same email: accepted, but no second account.
	const again = addApplication(db, { legal_name: "Acme Hauling Two LLC" });
	const r2 = await accept(db, again);
	ok(r2.body && r2.body.message === "Accepted (user already exists)" && r2.mail.length === 0,
		"§2 accepting for an email that already has an account must still create nothing and mail nothing");
	ok(db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 1, "§2 ...and leave exactly one account");

	// Any other status creates no account at all.
	for (const status of ["Reviewed", "Rejected", "New"]) {
		const d = makeDb();
		const id = addApplication(d);
		const rr = await accept(d, id, { status });
		ok(rr.body && rr.body.success === true && d.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0 && rr.mail.length === 0,
			`§2 status "${status}" must not create an account or send mail`);
	}
}

// ─────────────────────────────── §3 every temporary-password route sets the flag
function sectionEveryTempPasswordRoute() {
	// Each place that mints an emailed temporary password, and the account
	// INSERT that follows it inside the same route.
	const MINT = 'const tempPassword = crypto.randomBytes(';
	const sites = [];
	for (let i = SRC.indexOf(MINT); i >= 0; i = SRC.indexOf(MINT, i + 1)) sites.push(i);
	ok(sites.length === 2, `§3 expected the 2 known temporary-password routes (driver, investor), found ${sites.length} — a new one must set the flag too; update this count once it does`);
	for (const at of sites) {
		const routeStart = SRC.lastIndexOf("\napp.", at);
		const routeHead = SRC.slice(routeStart + 1, SRC.indexOf("\n", routeStart + 1));
		const insertAt = SRC.indexOf('"INSERT INTO users (', at);
		const insertSql = insertAt > 0 ? SRC.slice(insertAt, SRC.indexOf('"', insertAt + 1) + 1) : "";
		const routeEnd = SRC.indexOf("\n});", at);
		ok(insertAt > 0 && insertAt < routeEnd, `§3 ${routeHead}: the account INSERT must follow the temporary password in the same route`);
		const m = insertSql.match(/INSERT INTO users \(([^)]*)\) VALUES \(([^)]*)\)/);
		const cols = m ? m[1].split(",").map((s) => s.trim()) : [];
		const vals = m ? m[2].split(",").map((s) => s.trim()) : [];
		const idx = cols.indexOf("must_change_password");
		ok(idx >= 0 && vals[idx] === "1", `§3 ${routeHead}: the INSERT must set must_change_password = 1 — got ${insertSql}`);
	}
	// The two INSERTs are the same statement apart from the role.
	const sqlOf = (src) => { const m = src.match(/"INSERT INTO users \([^"]*"/); return m ? m[0] : ""; };
	const driverSql = sqlOf(DRIVER_ACCEPT_SRC), investorSql = sqlOf(ACCEPT_SRC);
	ok(driverSql.includes("'Driver'") && investorSql.includes("'Investor'") &&
		driverSql.replace(/\(\?, \?, 'Driver', \?, \?, \?, '', 1\)/, "") === investorSql.replace(/\(\?, \?, 'Investor', '', \?, \?, \?, 1\)/, ""),
		`§3 the investor INSERT must set the flag exactly as the driver INSERT does:\n       driver:   ${driverSql}\n       investor: ${investorSql}`);
}

// ─────────────────────────────── §4 discrimination
async function sectionMutant() {
	const FLAGGED = "company_name, must_change_password) VALUES (?, ?, 'Investor', '', ?, ?, ?, 1)";
	const UNFLAGGED = "company_name) VALUES (?, ?, 'Investor', '', ?, ?, ?)";
	const mutant = ACCEPT_SRC.replace(FLAGGED, UNFLAGGED);
	ok(mutant !== ACCEPT_SRC, "§4 the unflagged mutant did not change the source — its marker text moved");
	if (mutant === ACCEPT_SRC) return;
	const db = makeDb();
	const appId = addApplication(db);
	const r = await accept(db, appId, { routeSrc: mutant });
	const row = db.prepare("SELECT must_change_password FROM users WHERE id = ?").get(((r.body || {}).credentials || {}).userId);
	ok(!!row && row.must_change_password === 0,
		"§4 MUTANT NOT CAUGHT — an INSERT without the flag must leave the flag at its column default of 0, which §1 rejects");
}

(async () => {
	await sectionFlag();
	await sectionUnchanged();
	sectionEveryTempPasswordRoute();
	await sectionMutant();
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
