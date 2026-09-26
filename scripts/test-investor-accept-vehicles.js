#!/usr/bin/env node
/**
 * Accepting an investor application: what became of each vehicle on it.
 *
 * THE BUG. PUT /api/investor-applications/:id/status → "Accepted" inserts one
 * truck per vehicle on the application inside `try { … } catch { /* skip
 * duplicate *\/ }`. That swallowed EVERY error, not just a duplicate, while the
 * audit line and the welcome email both claimed `${vehicles.length}
 * vehicle(s)` — so a truck that was never written read as registered, to the
 * admin and to the investor.
 *
 * THE FIX, as asserted here. registerApplicationVehicles() writes the trucks and
 * returns { created, existing, heldByOther, failed }: SQLITE_CONSTRAINT_UNIQUE
 * (unit_number, the table's only UNIQUE column) is a truck already on file, and
 * any other error is logged and counted as failed. The route adds `vehicles` to
 * its JSON (every other field kept), names all four counts in the audit line,
 * and the welcome email — wording unchanged, it is investor-facing — counts the
 * vehicles actually registered to the new account (created + existing).
 *
 * THE OVER-COUNT (2026-09-26). A unit number INV-<id>-X already on file used to
 * count as "existing", i.e. "registered to your fleet". It never belongs to the
 * NEW account: it is an earlier acceptance's, or owner 0's once that account was
 * deleted, or someone else's. So `existing` is a truck whose owner_id is the new
 * account; any other holder is `heldByOther`, left exactly as it is (moving a
 * truck between investors' ledgers is a month-end-lock decision), counted out of
 * the welcome email and named in the admin email and the admin screen.
 *
 * WHAT IS ASSERTED — the shipped code, lifted out of server.js, on an in-memory
 * SQLite with production's `trucks` shape (the rename-recreate DDL and the
 * ALTERs after it):
 *   §1 the helper: every vehicle created, with the unit numbers, owner and
 *      prices the route always wrote; a truck already on file under ANOTHER
 *      owner (an investor, or owner 0) → heldByOther, never existing, never
 *      re-parented, not logged; one on file under the new account → existing; a
 *      CHECK violation (an OOS truck on a database whose CHECK predates OOS), an
 *      error raised inside the INSERT, and an entry that is not an object →
 *      failed, each logged naming its unit; a non-array → nothing.
 *   §2 the route, run for real: the response keeps every field and adds the
 *      counts; the audit line names all four; the welcome email's sentence is
 *      unchanged apart from its number, which is created + existing — a truck
 *      held by another owner is not in it; the admin email names the vehicles
 *      held by another owner and those that could not be added; a clean
 *      acceptance reads as before.
 *   §3 the admin screen (InvestorApplicationsView.vue): both counts are shown
 *      inside the credentials dialog, and turn the success toast into a warning
 *      that points at the Trucks page.
 *   §4 THE MUTANTS: the catch counting every error as "already exists" (a
 *      catch-all swallow again), and the catch counting a truck held by anyone
 *      as "existing" (the over-count again), must each be caught.
 *
 * Pure: no server, no app.db, no network, no mail (sendEmail is captured).
 *
 * Run: node scripts/test-investor-accept-vehicles.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
	return false;
}
const ok = (cond, label) => eq(!!cond, true, label);
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

// ── lift the shipped code ───────────────────────────────────────────────────
function liftFunction(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${name}()`);
	return SRC.slice(a, end + 2);
}
function liftRoute(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}

const HELPER_SRC = liftFunction("registerApplicationVehicles");
const COL_LETTER_SRC = liftFunction("colLetter");
const PARSE_AMOUNT_SRC = (() => {
	const m = SRC.match(/\nconst TRUCK_AMOUNT_MAX = [^\n]*\n/);
	if (!m) die("could not locate TRUCK_AMOUNT_MAX");
	return `${m[0].trim()}\n${liftFunction("parsePlainDecimal")}\n${liftFunction("parseTruckAmount")}`;
})();
const ESCAPE_SRC = liftFunction("escapeHtml");
const ACCEPT_SRC = liftRoute('app.put("/api/investor-applications/:id/status", requireRole("Super Admin"), async (req, res) => {');

const colLetter = new Function(`${COL_LETTER_SRC}\nreturn colLetter;`)();
const parseTruckAmount = new Function(`${PARSE_AMOUNT_SRC}\nreturn parseTruckAmount;`)();
const escapeHtml = new Function(`${ESCAPE_SRC}\nreturn escapeHtml;`)();
// The helper over one database, its console.error calls recorded.
function buildHelper(db, helperSrc = HELPER_SRC) {
	const logged = [];
	const fakeConsole = { error: (...a) => logged.push(a.map(String).join(" ")), log() {}, warn() {} };
	const fn = new Function("db", "colLetter", "parseTruckAmount", "console",
		`"use strict";\n${helperSrc}\nreturn registerApplicationVehicles;`)(db, colLetter, parseTruckAmount, fakeConsole);
	return { register: fn, logged };
}

// ── fixtures: production's trucks shape ─────────────────────────────────────
// The rename-recreate DDL (its CHECK admits OOS) plus the ALTERs that follow it,
// read out of server.js rather than retyped.
const TRUCKS_DDL = (() => {
	const m = SRC.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!m) die("could not locate the trucks rename-recreate DDL");
	return `CREATE TABLE trucks (${m[1]}\n)`;
})();
// The original CREATE, whose CHECK predates OOS — the shape of a database that
// never ran the recreate.
const TRUCKS_DDL_PRE_OOS = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS trucks \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE trucks");
	if (/'OOS'/.test(m[1])) die("the original trucks CREATE now admits OOS; revisit the pre-OOS fixture");
	return `CREATE TABLE trucks (${m[1]}\n)`;
})();
const TRUCK_ALTERS = ["owner_id", "purchase_price", "title_status", "title_state"].map((col) => {
	const m = SRC.match(new RegExp(`ALTER TABLE trucks ADD COLUMN ${col} [^"\`]*`));
	if (!m) die(`could not locate the trucks.${col} migration`);
	return m[0];
});
function trucksDb({ preOos = false } = {}) {
	const db = new Database(":memory:");
	if (preOos) {
		db.exec(TRUCKS_DDL_PRE_OOS);
		for (const sql of TRUCK_ALTERS) db.exec(sql);
	} else {
		db.exec(TRUCKS_DDL);
		for (const sql of TRUCK_ALTERS.slice(1)) db.exec(sql);   // owner_id is in the recreate
	}
	return db;
}
const vehicle = (i, extra = {}) => ({ make: "Freightliner", model: "Cascadia", year: "2021", vin: `1FUJHHDR0MLMV000${i}`,
	licensePlate: `TX-${i}`, status: "Active", titleStatus: "Clean", titleState: "TX", purchasePrice: "85000", ...extra });
const trucksOf = (db) => db.prepare("SELECT unit_number, owner_id, status, purchase_price FROM trucks ORDER BY id").all();

// ═══════════════════════════════════════════════════════════════ §1 the helper
function helperSection(helperSrc = HELPER_SRC) {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });

	{
		const db = trucksDb();
		const { register, logged } = buildHelper(db, helperSrc);
		const counts = register([vehicle(0), vehicle(1, { status: "OOS", purchasePrice: "85,000" }), vehicle(2, { status: "Bogus" })], 42, 7);
		t(JSON.stringify(counts) === JSON.stringify({ created: 3, existing: 0, heldByOther: 0, failed: 0 }), `every vehicle created (got ${JSON.stringify(counts)})`);
		t(JSON.stringify(trucksOf(db)) === JSON.stringify([
			{ unit_number: "INV-42-A", owner_id: 7, status: "Active", purchase_price: 85000 },
			{ unit_number: "INV-42-B", owner_id: 7, status: "OOS", purchase_price: 0 },
			{ unit_number: "INV-42-C", owner_id: 7, status: "Active", purchase_price: 85000 },
		]), `the trucks the route always wrote: unit numbers, owner, status (an unknown one is Active) and price (got ${JSON.stringify(trucksOf(db))})`);
		t(logged.length === 0, "nothing is logged when every vehicle is created");
	}
	{
		// A unit number already on file under ANOTHER owner — an earlier
		// acceptance's account (3), or owner 0 once that account was deleted — is
		// not the new account's truck. The over-count read it as "existing", i.e.
		// registered to the new investor's fleet.
		const db = trucksDb();
		db.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-A', 3)").run();
		db.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-C', 0)").run();
		const { register, logged } = buildHelper(db, helperSrc);
		const counts = register([vehicle(0), vehicle(1), vehicle(2)], 42, 7);
		t(JSON.stringify(counts) === JSON.stringify({ created: 1, existing: 0, heldByOther: 2, failed: 0 }),
			`a truck on file under another owner (an investor, or owner 0) is heldByOther, never existing (got ${JSON.stringify(counts)})`);
		t(logged.length === 0, `...and is not logged as a failure (got ${JSON.stringify(logged)})`);
		t(JSON.stringify(db.prepare("SELECT unit_number, owner_id FROM trucks WHERE unit_number IN ('INV-42-A', 'INV-42-C') ORDER BY unit_number").all()) ===
			JSON.stringify([{ unit_number: "INV-42-A", owner_id: 3 }, { unit_number: "INV-42-C", owner_id: 0 }]),
			"...and the trucks on file are left as they are: never re-parented to the new account");
		t(db.prepare("SELECT owner_id FROM trucks WHERE unit_number = 'INV-42-B'").get().owner_id === 7,
			"...while the vehicle with a free unit number is created under the new account");
	}
	{
		// The helper never throws: the account and its temporary password exist by
		// the time it runs. If reading who holds the unit number fails, the vehicle
		// is failed and logged.
		const real = trucksDb();
		real.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-A', 3)").run();
		const db = { prepare: (sql) => (/^SELECT owner_id FROM trucks/.test(sql) ? (() => { throw new Error("simulated read failure"); })() : real.prepare(sql)) };
		const { register, logged } = buildHelper(db, helperSrc);
		let counts = null, threw = null;
		try { counts = register([vehicle(0), vehicle(1)], 42, 7); } catch (e) { threw = e; }
		t(!threw && JSON.stringify(counts) === JSON.stringify({ created: 1, existing: 0, heldByOther: 0, failed: 1 }) && logged.length === 1 && /INV-42-A/.test(logged[0]),
			`the holder of a unit number that cannot be read: failed and logged, never thrown (got ${threw ? `a throw: ${threw.message}` : JSON.stringify(counts)}, ${JSON.stringify(logged)})`);
	}
	{
		// A truck on file that the new account already owns is `existing`.
		const db = trucksDb();
		db.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-A', 7)").run();
		const { register, logged } = buildHelper(db, helperSrc);
		const counts = register([vehicle(0), vehicle(1)], 42, 7);
		t(JSON.stringify(counts) === JSON.stringify({ created: 1, existing: 1, heldByOther: 0, failed: 0 }),
			`a truck on file under the new account's own id counts as existing (got ${JSON.stringify(counts)})`);
		t(logged.length === 0, `...and is not logged (got ${JSON.stringify(logged)})`);
	}
	{
		// A database whose CHECK predates OOS: the OOS truck is refused by SQLite
		// (SQLITE_CONSTRAINT_CHECK) — a failure, not a duplicate.
		const db = trucksDb({ preOos: true });
		const { register, logged } = buildHelper(db, helperSrc);
		const counts = register([vehicle(0), vehicle(1, { status: "OOS" })], 42, 7);
		t(JSON.stringify(counts) === JSON.stringify({ created: 1, existing: 0, heldByOther: 0, failed: 1 }),
			`a CHECK violation counts as failed, not existing (got ${JSON.stringify(counts)})`);
		t(logged.length === 1 && /INV-42-B/.test(logged[0]) && /CHECK/i.test(logged[0]),
			`...and is logged, naming the unit and the error (got ${JSON.stringify(logged)})`);
		t(trucksOf(db).map((r) => r.unit_number).join() === "INV-42-A", "...and only the other truck is written");
	}
	{
		// Any other error raised by the INSERT, and an entry that is not an object.
		const db = trucksDb();
		db.exec("CREATE TRIGGER refuse_vin BEFORE INSERT ON trucks WHEN NEW.vin = 'BOOM' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
		const { register, logged } = buildHelper(db, helperSrc);
		const counts = register([vehicle(0), vehicle(1, { vin: "BOOM" }), null, vehicle(3)], 42, 7);
		t(JSON.stringify(counts) === JSON.stringify({ created: 2, existing: 0, heldByOther: 0, failed: 2 }),
			`an error raised by the INSERT and a non-object entry count as failed (got ${JSON.stringify(counts)})`);
		t(logged.length === 2 && /INV-42-B/.test(logged[0]) && /simulated write failure/.test(logged[0]) && /INV-42-C/.test(logged[1]),
			`...each logged, naming its unit (got ${JSON.stringify(logged)})`);
		t(trucksOf(db).map((r) => r.unit_number).join() === "INV-42-A,INV-42-D", "...and the vehicles after them are still written");
	}
	{
		const db = trucksDb();
		const { register } = buildHelper(db, helperSrc);
		const none = { created: 0, existing: 0, heldByOther: 0, failed: 0 };
		t(JSON.stringify([register({ a: 1 }, 42, 7), register(null, 42, 7), register([], 42, 7)]) === JSON.stringify([none, none, none]),
			"a non-array or empty list registers nothing");
	}
	return results;
}

// ═══════════════════════════════════════════════════════════════ §2 the route
const APP_DDL = [
	`CREATE TABLE investor_applications (
		id INTEGER PRIMARY KEY, status TEXT DEFAULT 'New', deleted_at TEXT, legal_name TEXT, dba TEXT DEFAULT '', email TEXT,
		entity_type TEXT DEFAULT '', address TEXT DEFAULT '', phone TEXT DEFAULT '', ein_ssn TEXT DEFAULT '', tax_classification TEXT DEFAULT '',
		contact_person TEXT DEFAULT '', contact_title TEXT DEFAULT '', vehicles_json TEXT DEFAULT '[]')`,
	`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, password_hash TEXT, role TEXT, driver_name TEXT DEFAULT '', email TEXT,
		full_name TEXT DEFAULT '', company_name TEXT DEFAULT '', must_change_password INTEGER DEFAULT 0)`,
	`CREATE TABLE investors (
		id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT, carrier_name TEXT, status TEXT, application_id INTEGER,
		entity_type TEXT, address TEXT, phone TEXT, email TEXT, ein_ssn TEXT, tax_classification TEXT, contact_person TEXT, contact_title TEXT)`,
];
async function acceptOnce(vehicles, { helperSrc = HELPER_SRC, seed } = {}) {
	const db = trucksDb();
	for (const sql of APP_DDL) db.exec(sql);
	db.exec("CREATE TRIGGER refuse_vin BEFORE INSERT ON trucks WHEN NEW.vin = 'BOOM' BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
	if (seed) seed(db);
	db.prepare("INSERT INTO investor_applications (id, legal_name, dba, email, vehicles_json) VALUES (42, 'Acme Hauling LLC', 'Acme', 'owner@acme.example.test', ?)")
		.run(JSON.stringify(vehicles));
	const { register, logged } = buildHelper(db, helperSrc);
	const audits = [];
	const mail = [];
	let handler = null;
	new Function("app", "requireRole", "db", "bcrypt", "crypto", "logAudit", "notifyChange", "colLetter", "escapeHtml", "sendEmail",
		"parseTruckAmount", "registerApplicationVehicles", ACCEPT_SRC)(
		{ put: (p, guard, h) => { handler = h; } }, () => null, db, { hash: async () => "hashed" }, require("crypto"),
		(req, action, entity, entityId, details) => audits.push({ action, details }), () => {}, colLetter, escapeHtml,
		(to, subject, html) => { mail.push({ to, subject, html }); return Promise.resolve(true); }, parseTruckAmount, register);
	const out = { status: 200, body: null };
	await handler({ params: { id: "42" }, body: { status: "Accepted" }, session: { user: { id: 1, username: "super_admin", role: "Super Admin" } } },
		{ status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } });
	const welcome = (mail.find((m) => m.to === "owner@acme.example.test") || {}).html || "";
	const admin = (mail.find((m) => m.to === "info@logisx.com") || {}).html || "";
	return { ...out, audits, logged, welcome, admin, db };
}
const sentence = (html) => {
	const m = html.match(/Your account is ready and (\S+) vehicle\(s\) have been registered to your fleet\./);
	return m ? m[1] : null;
};
async function routeSection(helperSrc = HELPER_SRC) {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });

	// One created, one on file under another owner (an earlier acceptance's
	// account, 3), one refused by the INSERT.
	const r = await acceptOnce([vehicle(0), vehicle(1), vehicle(2, { vin: "BOOM" })], {
		helperSrc, seed: (db) => db.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-B', 3)").run(),
	});
	const b = r.body || {};
	t(r.status === 200 && JSON.stringify(Object.keys(b)) === JSON.stringify(["success", "accountCreated", "credentials", "vehicles"]),
		`the response keeps every field and adds vehicles (got ${r.status} ${JSON.stringify(Object.keys(b))})`);
	t(JSON.stringify(b.vehicles) === JSON.stringify({ created: 1, existing: 0, heldByOther: 1, failed: 1 }), `vehicles: the four counts (got ${JSON.stringify(b.vehicles)})`);
	const audit = r.audits.find((a) => a.action === "accept_investor") || {};
	t(audit.details === 'Accepted investor "Acme Hauling LLC", created account "acme.hauling.llc", 3 vehicle(s): 1 created, 0 already existed, 1 held by another owner, 1 failed',
		`the audit line names all four counts (got ${JSON.stringify(audit.details)})`);
	t(sentence(r.welcome) === "1",
		`the welcome email counts the vehicles registered to the new account, created + existing — not the one held by another owner (got ${sentence(r.welcome)})`);
	t(r.admin.includes("1 vehicle(s) added; 1 vehicle(s) are already on file under another owner (unit numbers INV-42-…) — reassign them from the Trucks page; 1 could not be added — add them from the Trucks page"),
		"the admin email counts the vehicles added, names the one held by another owner and the one that could not be added");
	t(r.db.prepare("SELECT owner_id FROM trucks WHERE unit_number = 'INV-42-B'").get().owner_id === 3,
		"...and the truck held by another owner is not re-parented");
	t(r.logged.length === 1 && /INV-42-C/.test(r.logged[0]), `the failure is logged (got ${JSON.stringify(r.logged)})`);

	// A truck on file that the new account owns is registered to its fleet. The
	// account is the first user on this database, so the route mints id 1.
	const o = await acceptOnce([vehicle(0), vehicle(1)], {
		helperSrc, seed: (db) => db.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-A', 1)").run(),
	});
	t(((o.body || {}).credentials || {}).userId === 1 &&
		JSON.stringify((o.body || {}).vehicles) === JSON.stringify({ created: 1, existing: 1, heldByOther: 0, failed: 0 }) && sentence(o.welcome) === "2",
		`a truck on file under the new account: existing, and in the welcome email's count (got ${JSON.stringify((o.body || {}).vehicles)}, ${sentence(o.welcome)})`);

	// A clean acceptance reads exactly as before.
	const c = await acceptOnce([vehicle(0), vehicle(1)], { helperSrc });
	const ca = c.audits.find((a) => a.action === "accept_investor") || {};
	t(JSON.stringify((c.body || {}).vehicles) === JSON.stringify({ created: 2, existing: 0, heldByOther: 0, failed: 0 }) && sentence(c.welcome) === "2",
		`a clean acceptance: two created, and the welcome email says 2 (got ${JSON.stringify((c.body || {}).vehicles)}, ${sentence(c.welcome)})`);
	t(ca.details === 'Accepted investor "Acme Hauling LLC", created account "acme.hauling.llc", 2 vehicle(s): 2 created, 0 already existed, 0 held by another owner, 0 failed',
		`...its audit line (got ${JSON.stringify(ca.details)})`);
	t(!/could not be added/.test(c.admin) && !/another owner/.test(c.admin) && /2 vehicle\(s\) added/.test(c.admin),
		"...and the admin email reports neither a truck held by another owner nor a failure");
	return results;
}

// The welcome email's wording is investor-facing copy: only its number moved.
function wordingSection() {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });
	t(ACCEPT_SRC.includes("Your investor application has been <b style=\"color:#16a34a\">approved</b>. Your account is ready and ${vehiclesRegistered} vehicle(s) have been registered to your fleet.</p>"),
		"the welcome email's sentence is unchanged apart from the count it interpolates");
	t(ACCEPT_SRC.includes("const vehiclesRegistered = vehicleCounts.created + vehicleCounts.existing;"),
		"the count it interpolates is created + existing");
	return results;
}

// ═══════════════════════════════════════════════════════════════ §3 the client
// updateStatus() is lifted out of the view and run against stubs of what it
// reads (the api, the dialog's refs, the toast); the dialog's markup is read as
// source, between its opening comment and the next dialog's.
async function clientSection() {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });
	const view = fs.readFileSync(path.join(ROOT, "client", "src", "views", "InvestorApplicationsView.vue"), "utf8");
	const fnAt = view.indexOf("async function updateStatus(");
	const fnEnd = view.indexOf("async function viewDetail(");
	if (fnAt < 0 || fnEnd < fnAt) die("could not locate updateStatus() in InvestorApplicationsView.vue");
	const fnSrc = view.slice(fnAt, fnEnd).trim();
	const accept = async (response) => {
		const toasts = [];
		const env = {
			api: { put: async () => response },
			credentials: { value: null }, showCredentials: { value: false }, acceptVehicles: { value: null },
			toast: (msg, kind) => { toasts.push([msg, kind]); }, load: async () => {},
		};
		const names = Object.keys(env);
		const updateStatus = new Function(...names, `${fnSrc}\nreturn updateStatus;`)(...names.map((k) => env[k]));
		await updateStatus(42, "Accepted");
		return { toasts, shown: env.showCredentials.value, vehicles: env.acceptVehicles.value };
	};
	const CREDS = { username: "acme.hauling.llc", tempPassword: "x", userId: 9, investorName: "Acme Hauling LLC" };
	{
		const out = await accept({ success: true, accountCreated: true, credentials: CREDS, vehicles: { created: 1, existing: 0, heldByOther: 2, failed: 1 } });
		t(out.shown && JSON.stringify(out.vehicles) === JSON.stringify({ registered: 1, heldByOther: 2, failed: 1, unitPrefix: "INV-42-" }),
			`after an accept, the credentials dialog is given the counts: created + existing registered, heldByOther and failed (got ${JSON.stringify(out.vehicles)})`);
		t(JSON.stringify(out.toasts) === JSON.stringify([["Investor accepted — account created. 2 vehicle(s) are already on file under another owner — reassign them from the Trucks page; 1 vehicle(s) could not be added — add them from the Trucks page", "warning"]]),
			`...and a warning toast names both and the Trucks page (got ${JSON.stringify(out.toasts)})`);
	}
	{
		const out = await accept({ success: true, accountCreated: true, credentials: CREDS, vehicles: { created: 2, existing: 0, heldByOther: 0, failed: 0 } });
		t(JSON.stringify(out.toasts) === JSON.stringify([["Investor accepted — account created", "success"]]) && out.vehicles && out.vehicles.registered === 2,
			`a clean accept keeps the success toast (got ${JSON.stringify(out.toasts)})`);
		const old = await accept({ success: true, accountCreated: true, credentials: CREDS });
		t(old.vehicles === null && JSON.stringify(old.toasts) === JSON.stringify([["Investor accepted — account created", "success"]]),
			"an answer carrying no vehicle counts shows none");
	}
	const dlgAt = view.indexOf("<!-- Credentials Dialog -->");
	const dlg = dlgAt >= 0 ? view.slice(dlgAt, view.indexOf("<!-- Detail Dialog -->", dlgAt)) : "";
	t(/v-if="acceptVehicles && acceptVehicles\.heldByOther > 0"/.test(dlg) &&
		dlg.includes("{{ acceptVehicles.heldByOther }} vehicle(s) are already on file under another owner (unit numbers {{ acceptVehicles.unitPrefix }}…) — reassign them from the Trucks page."),
		"the credentials dialog itself names the vehicles held by another owner and points at the Trucks page");
	t(/v-if="acceptVehicles && acceptVehicles\.failed > 0"/.test(dlg) &&
		dlg.includes("{{ acceptVehicles.failed }} vehicle(s) could not be added — add them from the Trucks page."),
		"...and the vehicles that could not be added");
	t(/\.toast\.warning\s*\{/.test(fs.readFileSync(path.join(ROOT, "client", "src", "assets", "shared.css"), "utf8")),
		"the warning toast type is styled");
	return results;
}

function record(results) {
	for (const r of results) ok(r.ok, r.name);
	console.log(`  ${results.filter((r) => r.ok).length}/${results.length} checks`);
}

(async () => {
	section("§1 registerApplicationVehicles()");
	record(helperSection());
	section("§2 PUT /api/investor-applications/:id/status → Accepted");
	record(await routeSection());
	record(wordingSection());
	section("§3 the admin screen");
	record(await clientSection());

	section("§4 the mutants — each must be caught");
	const OWNED = "if (held && Number(held.owner_id) === Number(userId)) {";
	for (const [label, src] of [
		// A catch-all swallow again: every error counted as "already exists",
		// nothing counted as failed, nothing logged.
		["M1 the catch counting every error as already existing (a catch-all swallow)", mutate(HELPER_SRC, OWNED, "if (true) {")],
		// The over-count again: a truck on file under anyone counted as the new
		// account's, and in the welcome email's "registered to your fleet".
		["M2 a truck on file under another owner counted as existing (the over-count)", mutate(HELPER_SRC, OWNED, "if (held) {")],
	]) {
		const caught = [...helperSection(src), ...await routeSection(src)].filter((r) => !r.ok);
		ok(caught.length > 0, `${label} is caught`);
		console.log(`  ${label}: caught by ${caught.length} check(s), e.g.`);
		for (const r of caught.slice(0, 3)) console.log(`      ✗ ${r.name}`);
	}

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((err) => {
	console.error("FAILED: runner crashed:", err && err.stack ? err.stack : err);
	process.exit(1);
});
