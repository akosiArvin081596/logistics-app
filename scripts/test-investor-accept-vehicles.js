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
 * returns { created, existing, failed }: SQLITE_CONSTRAINT_UNIQUE (unit_number,
 * the table's only UNIQUE column) is a truck already on file, and any other
 * error is logged and counted as failed. The route adds `vehicles` to its JSON
 * (every other field kept), names all three counts in the audit line, and the
 * welcome email — wording unchanged, it is investor-facing — counts the
 * vehicles actually registered (created + existing). The admin screen warns
 * when any failed.
 *
 * WHAT IS ASSERTED — the shipped code, lifted out of server.js, on an in-memory
 * SQLite with production's `trucks` shape (the rename-recreate DDL and the
 * ALTERs after it):
 *   §1 the helper: every vehicle created, with the unit numbers, owner and
 *      prices the route always wrote; a truck already on file → existing, not
 *      failed and not logged; a CHECK violation (an OOS truck on a database
 *      whose CHECK predates OOS), an error raised inside the INSERT, and an
 *      entry that is not an object → failed, each logged naming its unit;
 *      a non-array → nothing.
 *   §2 the route, run for real: the response keeps every field and adds the
 *      counts; the audit line names all three; the welcome email's sentence is
 *      unchanged apart from its number, which is created + existing; the admin
 *      email says how many could not be added; a clean acceptance reads as
 *      before.
 *   §3 the admin screen (InvestorApplicationsView.vue): a failed count turns the
 *      success toast into a warning that points at the Trucks page.
 *   §4 THE MUTANT: the catch counting every error as "already exists" (a
 *      catch-all swallow again) must be caught.
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
		t(JSON.stringify(counts) === JSON.stringify({ created: 3, existing: 0, failed: 0 }), `every vehicle created (got ${JSON.stringify(counts)})`);
		t(JSON.stringify(trucksOf(db)) === JSON.stringify([
			{ unit_number: "INV-42-A", owner_id: 7, status: "Active", purchase_price: 85000 },
			{ unit_number: "INV-42-B", owner_id: 7, status: "OOS", purchase_price: 0 },
			{ unit_number: "INV-42-C", owner_id: 7, status: "Active", purchase_price: 85000 },
		]), `the trucks the route always wrote: unit numbers, owner, status (an unknown one is Active) and price (got ${JSON.stringify(trucksOf(db))})`);
		t(logged.length === 0, "nothing is logged when every vehicle is created");
	}
	{
		// Accepting again meets this application's own trucks: already on file.
		const db = trucksDb();
		db.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-A', 3)").run();
		const { register, logged } = buildHelper(db, helperSrc);
		const counts = register([vehicle(0), vehicle(1)], 42, 7);
		t(JSON.stringify(counts) === JSON.stringify({ created: 1, existing: 1, failed: 0 }),
			`a truck already on file under the unit number counts as existing (got ${JSON.stringify(counts)})`);
		t(logged.length === 0, `...and is not logged as a failure (got ${JSON.stringify(logged)})`);
		t(db.prepare("SELECT owner_id FROM trucks WHERE unit_number = 'INV-42-A'").get().owner_id === 3,
			"...and the truck on file is left as it is");
	}
	{
		// A database whose CHECK predates OOS: the OOS truck is refused by SQLite
		// (SQLITE_CONSTRAINT_CHECK) — a failure, not a duplicate.
		const db = trucksDb({ preOos: true });
		const { register, logged } = buildHelper(db, helperSrc);
		const counts = register([vehicle(0), vehicle(1, { status: "OOS" })], 42, 7);
		t(JSON.stringify(counts) === JSON.stringify({ created: 1, existing: 0, failed: 1 }),
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
		t(JSON.stringify(counts) === JSON.stringify({ created: 2, existing: 0, failed: 2 }),
			`an error raised by the INSERT and a non-object entry count as failed (got ${JSON.stringify(counts)})`);
		t(logged.length === 2 && /INV-42-B/.test(logged[0]) && /simulated write failure/.test(logged[0]) && /INV-42-C/.test(logged[1]),
			`...each logged, naming its unit (got ${JSON.stringify(logged)})`);
		t(trucksOf(db).map((r) => r.unit_number).join() === "INV-42-A,INV-42-D", "...and the vehicles after them are still written");
	}
	{
		const db = trucksDb();
		const { register } = buildHelper(db, helperSrc);
		t(JSON.stringify([register({ a: 1 }, 42, 7), register(null, 42, 7), register([], 42, 7)]) ===
			JSON.stringify([{ created: 0, existing: 0, failed: 0 }, { created: 0, existing: 0, failed: 0 }, { created: 0, existing: 0, failed: 0 }]),
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

	// One created, one already on file, one refused by the INSERT.
	const r = await acceptOnce([vehicle(0), vehicle(1), vehicle(2, { vin: "BOOM" })], {
		helperSrc, seed: (db) => db.prepare("INSERT INTO trucks (unit_number, owner_id) VALUES ('INV-42-B', 3)").run(),
	});
	const b = r.body || {};
	t(r.status === 200 && JSON.stringify(Object.keys(b)) === JSON.stringify(["success", "accountCreated", "credentials", "vehicles"]),
		`the response keeps every field and adds vehicles (got ${r.status} ${JSON.stringify(Object.keys(b))})`);
	t(JSON.stringify(b.vehicles) === JSON.stringify({ created: 1, existing: 1, failed: 1 }), `vehicles: the three counts (got ${JSON.stringify(b.vehicles)})`);
	const audit = r.audits.find((a) => a.action === "accept_investor") || {};
	t(audit.details === 'Accepted investor "Acme Hauling LLC", created account "acme.hauling.llc", 3 vehicle(s): 1 created, 1 already existed, 1 failed',
		`the audit line names all three counts (got ${JSON.stringify(audit.details)})`);
	t(sentence(r.welcome) === "2", `the welcome email counts the vehicles registered, created + existing (got ${sentence(r.welcome)})`);
	t(/2 vehicle\(s\) added; 1 could not be added — add them from the Trucks page/.test(r.admin),
		"the admin email counts the vehicles added and says how many could not be");
	t(r.logged.length === 1 && /INV-42-C/.test(r.logged[0]), `the failure is logged (got ${JSON.stringify(r.logged)})`);

	// A clean acceptance reads exactly as before.
	const c = await acceptOnce([vehicle(0), vehicle(1)], { helperSrc });
	const ca = c.audits.find((a) => a.action === "accept_investor") || {};
	t(JSON.stringify((c.body || {}).vehicles) === JSON.stringify({ created: 2, existing: 0, failed: 0 }) && sentence(c.welcome) === "2",
		`a clean acceptance: two created, and the welcome email says 2 (got ${JSON.stringify((c.body || {}).vehicles)}, ${sentence(c.welcome)})`);
	t(ca.details === 'Accepted investor "Acme Hauling LLC", created account "acme.hauling.llc", 2 vehicle(s): 2 created, 0 already existed, 0 failed',
		`...its audit line (got ${JSON.stringify(ca.details)})`);
	t(!/could not be added/.test(c.admin) && /2 vehicle\(s\) added/.test(c.admin), "...and the admin email reports no failure");
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
function clientSection() {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });
	const view = fs.readFileSync(path.join(ROOT, "client", "src", "views", "InvestorApplicationsView.vue"), "utf8");
	const fn = view.slice(view.indexOf("async function updateStatus("), view.indexOf("async function viewDetail("));
	t(/const failed = result\.vehicles\?\.failed \|\| 0/.test(fn) && /if \(failed > 0\)/.test(fn),
		"after an accept, the view reads result.vehicles?.failed");
	t(/toast\(`Investor accepted — account created\. \$\{failed\} vehicle\(s\) could not be added — add them from the Trucks page`, 'warning'\)/.test(fn),
		"a failed count shows a warning toast naming the count and the Trucks page");
	t(/toast\('Investor accepted — account created', 'success'\)/.test(fn), "...and a clean accept keeps the success toast");
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
	record(clientSection());

	section("§4 the mutant — it must be caught");
	// A catch-all swallow again: every error counted as "already exists", nothing
	// counted as failed, nothing logged.
	const CATCH_ALL = mutate(HELPER_SRC, 'if (err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {', "if (true) {");
	const caught = [...helperSection(CATCH_ALL), ...await routeSection(CATCH_ALL)].filter((r) => !r.ok);
	ok(caught.length > 0, "M1 the catch counting every error as already existing (a catch-all swallow) is caught");
	console.log(`  M1 catch-all swallow: caught by ${caught.length} check(s), e.g.`);
	for (const r of caught.slice(0, 3)) console.log(`      ✗ ${r.name}`);

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
