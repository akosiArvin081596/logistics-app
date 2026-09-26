#!/usr/bin/env node
/**
 * The directory sync finds a driver's drivers_directory row, and their truck,
 * under another spacing of the name.
 *
 * THE BUG. syncDriverToCarrierSheet()'s "update" branch found the directory row
 * with `LOWER(driver_name) = LOWER(?)` and the truck with
 * `LOWER(assigned_driver) = LOWER(?)`. LOWER() folds case, not spacing, so when
 * the stored and the caller's spellings differed in spacing ("Shorn  King" vs
 * "Shorn King"):
 *   - "update" missed the row and fell into "add";
 *   - "add" asked findDriverNameClash(…, { users: false }), found the row (it
 *     compares through normalizeDriverName()), and returned without writing;
 *   - so the row's `trucks` column was never refreshed when the driver was
 *     assigned a truck — and a truck stored under another spacing was not found
 *     at all, so a sync for that driver wrote `trucks = ""`.
 * "delete" had the same LOWER() lookup and left the spacing variant behind.
 *
 * THE FIX, as asserted here. findDirectoryRowForDriver() is the row equal to the
 * name case aside (the old lookup), else the first row by id that
 * normalizeDriverName() matches (findDriverNameClashes(name, { users: false })).
 * "update" and "delete" use it, and the truck is found the same two ways. A
 * row found only through normalizeDriverName() keeps its stored spelling unless
 * an explicit oldName rename asks for another; a case-aside match is rewritten
 * as it always was. GET /api/driver/:driverName finds its row through the same
 * helper (scripts/test-driver-page-role-gate.js §5).
 *
 * Production (2026-09-26): one directory row and two driver accounts carry a
 * doubled or edge space, and none has a truck, so this is preventive.
 *
 *   §1 findDirectoryRowForDriver() on its own.
 *   §2 "update": a driver assigned a truck the way the truck routes do it
 *      (canonicalDriverName() → assignDriverToTruck() → the sync) gets the
 *      unit in the `trucks` column of a row stored with a doubled or edge space,
 *      under its own spelling, and no row is added; a truck stored under
 *      another spelling is found; the other fields; case-only and explicit
 *      renames as before.
 *   §3 "delete": the spacing variant is removed, a case-aside match is still
 *      preferred, and a blank name removes nothing.
 *   §4 source pins.
 *   §5 THE MUTANT: findDirectoryRowForDriver() back to LOWER() equality.
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-directory-spacing-match.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

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
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) die(`mutant target found ${n}x (expected 1): ${from.slice(0, 70)}`);
	return src.replace(from, to);
}
const FUNCTIONS = ["normalizeDriverName", "findDriverNameClashes", "findDriverNameClash", "canonicalDriverName",
	"findDirectoryRowForDriver", "syncDriverToCarrierSheet", "assignDriverToTruck"];
const FN_SRC = Object.fromEntries(FUNCTIONS.map((n) => [n, liftFunction(n)]));
function buildModule(db, overrides = {}) {
	const s = { ...FN_SRC, ...overrides };
	const logged = [];
	const fakeConsole = { error: (...a) => logged.push(a.map(String).join(" ")), log() {}, warn() {} };
	const m = new Function("db", "console",
		`"use strict";\n${FUNCTIONS.map((n) => s[n]).join("\n")}\nreturn { ${FUNCTIONS.join(", ")} };`)(db, fakeConsole);
	return { ...m, logged };
}

// ── fixtures ────────────────────────────────────────────────────────────────
function ddl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table}`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}
const DDL = [
	ddl("users"),
	...["full_name", "company_name"].map((col) => {
		const m = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"\`]*`));
		if (!m) die(`could not locate the users.${col} migration`);
		return m[0];
	}),
	ddl("truck_assignments"),
	ddl("carrier_driver_history"),
	// The migrated production shapes (several migrations deep in server.js); the
	// NOCASE UNIQUE is what lets "Shorn King" and "Shorn  King" coexist.
	`CREATE TABLE drivers_directory (
		id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		carrier_name TEXT DEFAULT '', email TEXT DEFAULT '', trucks TEXT DEFAULT '', status TEXT DEFAULT 'active',
		pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0, pay_daily REAL DEFAULT 0)`,
	`CREATE TABLE trucks (
		id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL UNIQUE, status TEXT DEFAULT 'Active',
		assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0)`,
];
// `directory`: [[id, driver_name, trucks]]; `trucks`: [[id, unit, assigned_driver]];
// `accounts`: driver names that hold a Driver account.
function makeDb({ directory = [], trucks = [], accounts = [] } = {}) {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const u = db.prepare("INSERT INTO users (username, password_hash, role, driver_name) VALUES (?, 'x', 'Driver', ?)");
	accounts.forEach((name, i) => u.run(`LogisX-${1001 + i}`, name));
	const d = db.prepare("INSERT INTO drivers_directory (id, driver_name, trucks, pay_daily) VALUES (?, ?, ?, ?)");
	for (const [id, name, t, pay = 0] of directory) d.run(id, name, t, pay);
	const t = db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver) VALUES (?, ?, ?)");
	for (const [id, unit, driver] of trucks) t.run(id, unit, driver);
	return db;
}
const dirRows = (db) => db.prepare("SELECT id, driver_name, trucks FROM drivers_directory ORDER BY id").all()
	.map((r) => `${r.id}:${r.driver_name}:${r.trucks}`).join(" | ");

// PUT /api/trucks/:id's assignment sequence, in order: resolve the spelling,
// assign, sync the driver the truck now has.
function assignLikeTheTruckRoutes(m, truckId, requested) {
	const name = m.canonicalDriverName(requested);
	m.assignDriverToTruck(truckId, name);
	m.syncDriverToCarrierSheet(name, { action: "update" });
	return name;
}

// ═══════════════════════════════════════════════════════════════ batteries
function lookupBattery(overrides) {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });
	const db = makeDb({ directory: [[11, "Deshorn King", ""], [12, "Shorn  King", ""], [13, " Pat  Driver ", ""], [14, "BOB DRIVER", ""]] });
	const f = buildModule(db, overrides).findDirectoryRowForDriver;
	const show = (r) => (r ? `${r.id}/${r.matchedBy}` : "null");
	t(show(f("Shorn King")) === "12/normalized", `a doubled-space row is found through normalizeDriverName() (got ${show(f("Shorn King"))})`);
	t(show(f("pat driver")) === "13/normalized", `an edge- and doubled-space row is found (got ${show(f("pat driver"))})`);
	t(show(f("Bob Driver")) === "14/case", `a case-aside match is found as before, and says so (got ${show(f("Bob Driver"))})`);
	t(show(f("Shorn  King")) === "12/case", `the row's own spelling is a case-aside match (got ${show(f("Shorn  King"))})`);
	t(f("Deshorn") === null && f("King") === null, "a part of a name is no match");
	t(show(f("Deshorn King")) === "11/case" && !show(f("Shorn King")).startsWith("11/"), "Deshorn King and Shorn King stay two drivers");
	t(f("") === null && f("   ") === null && f(null) === null && f(42) === null, "a blank or non-string name matches nothing");
	const both = makeDb({ directory: [[21, "Shorn  King", ""], [22, "SHORN KING", ""]] });
	t(show(buildModule(both, overrides).findDirectoryRowForDriver("Shorn King")) === "22/case",
		"the case-aside match is preferred to an earlier spacing variant");
	return results;
}

function updateBattery(overrides) {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });
	for (const [label, stored] of [["a doubled space", "Shorn  King"], ["edge spaces", " Shorn King "]]) {
		// The account spells it one way, the directory row another; the truck takes
		// the account's spelling (canonicalDriverName()).
		const db = makeDb({ directory: [[1, stored, ""], [2, "Deshorn King", "205"]], trucks: [[1, "101", ""], [2, "205", "Deshorn King"]], accounts: ["Shorn King"] });
		const m = buildModule(db, overrides);
		const name = assignLikeTheTruckRoutes(m, 1, "Shorn King");
		t(name === "Shorn King", `(fixture) the truck takes the account's spelling (got ${name})`);
		t(dirRows(db) === `1:${stored}:101 | 2:Deshorn King:205`,
			`assigned a truck, a directory row stored with ${label} gets the unit in \`trucks\`, keeps its spelling, and no row is added (got ${dirRows(db)})`);
		t(m.logged.length === 0, `...with nothing logged (got ${JSON.stringify(m.logged)})`);
	}
	{
		// Unassigning refreshes it back to blank the same way.
		const db = makeDb({ directory: [[1, "Shorn  King", "101"]], trucks: [[1, "101", "Shorn King"]], accounts: ["Shorn King"] });
		const m = buildModule(db, overrides);
		m.assignDriverToTruck(1, "");
		m.syncDriverToCarrierSheet("Shorn King", { action: "update" });
		t(dirRows(db) === "1:Shorn  King:", `unassigned, the spacing variant's \`trucks\` is cleared (got ${dirRows(db)})`);
	}
	{
		// A truck stored under another spacing is still this driver's truck: a sync
		// under the account's spelling (an email change on PUT /api/users/:id) must
		// not write trucks = "".
		const db = makeDb({ directory: [[1, "Shorn King", "101"]], trucks: [[1, "101", "Shorn  King"]], accounts: ["Shorn King"] });
		const m = buildModule(db, overrides);
		m.syncDriverToCarrierSheet("Shorn King", { email: "sk@example.test", companyName: "SK Freight", action: "update" });
		const row = db.prepare("SELECT driver_name, trucks, email, carrier_name FROM drivers_directory WHERE id = 1").get();
		t(JSON.stringify(row) === JSON.stringify({ driver_name: "Shorn King", trucks: "101", email: "sk@example.test", carrier_name: "SK Freight" }),
			`a truck stored under another spacing is found; the email and company land (got ${JSON.stringify(row)})`);
	}
	{
		// The other fields land on a spacing variant too, and its name is kept.
		const db = makeDb({ directory: [[1, "Shorn  King", ""]], accounts: ["Shorn King"] });
		const m = buildModule(db, overrides);
		m.syncDriverToCarrierSheet("Shorn King", { email: "sk@example.test", action: "update" });
		const row = db.prepare("SELECT driver_name, email FROM drivers_directory WHERE id = 1").get();
		t(JSON.stringify(row) === JSON.stringify({ driver_name: "Shorn  King", email: "sk@example.test" }) && dirRows(db).split(" | ").length === 1,
			`the email lands on the spacing variant, whose name is kept, and no row is added (got ${JSON.stringify(row)}, ${dirRows(db)})`);
	}
	{
		// Today's behaviour on a case-aside match: the stored name is rewritten.
		const db = makeDb({ directory: [[1, "SHORN KING", ""]] });
		buildModule(db, overrides).syncDriverToCarrierSheet("Shorn King", { action: "update" });
		t(dirRows(db) === "1:Shorn King:", `a case-aside match is rewritten to the caller's spelling, as before (got ${dirRows(db)})`);
	}
	{
		// An explicit rename renames, whichever way the old name matched.
		const db = makeDb({ directory: [[1, "Shorn  King", ""]] });
		buildModule(db, overrides).syncDriverToCarrierSheet("Shaun King", { oldName: "Shorn King", action: "update" });
		t(dirRows(db) === "1:Shaun King:", `an explicit oldName rename renames a spacing variant (got ${dirRows(db)})`);
		const same = makeDb({ directory: [[1, "Shorn  King", ""]] });
		buildModule(same, overrides).syncDriverToCarrierSheet("Shorn King", { oldName: "Shorn King", action: "update" });
		t(dirRows(same) === "1:Shorn  King:", `an oldName equal to the new name is not a rename (got ${dirRows(same)})`);
	}
	{
		// A name with no row still gets a pending one through "add", as before.
		const db = makeDb({ directory: [[1, "Shorn  King", ""]] });
		buildModule(db, overrides).syncDriverToCarrierSheet("Fresh Person", { action: "update" });
		t(dirRows(db) === "1:Shorn  King: | 2:Fresh Person:", `a new driver still gets a row (got ${dirRows(db)})`);
	}
	return results;
}

function deleteBattery(overrides) {
	const results = [];
	const t = (cond, name) => results.push({ ok: !!cond, name });
	{
		const db = makeDb({ directory: [[1, "Shorn  King", "101"], [2, "Deshorn King", ""]] });
		buildModule(db, overrides).syncDriverToCarrierSheet("Shorn King", { action: "delete" });
		t(dirRows(db) === "2:Deshorn King:", `"delete" removes the doubled-space variant, and only it (got ${dirRows(db)})`);
	}
	{
		const db = makeDb({ directory: [[1, " Shorn King ", ""], [2, "Deshorn King", ""]] });
		buildModule(db, overrides).syncDriverToCarrierSheet("shorn king", { action: "delete" });
		t(dirRows(db) === "2:Deshorn King:", `"delete" removes the edge-space variant (got ${dirRows(db)})`);
	}
	{
		// Today's statement on a case-aside match; a spacing variant beside it is
		// a second row for one driver and is left for a person to resolve.
		const db = makeDb({ directory: [[1, "Shorn  King", ""], [2, "SHORN KING", ""]] });
		buildModule(db, overrides).syncDriverToCarrierSheet("Shorn King", { action: "delete" });
		t(dirRows(db) === "1:Shorn  King:", `a case-aside match is still the one removed (got ${dirRows(db)})`);
	}
	{
		const db = makeDb({ directory: [[1, "", ""], [2, "Deshorn King", ""]] });
		buildModule(db, overrides).syncDriverToCarrierSheet("   ", { action: "delete" });
		t(dirRows(db) === "1:: | 2:Deshorn King:", `a blank name removes nothing (got ${dirRows(db)})`);
	}
	return results;
}

function record(results) {
	for (const r of results) ok(r.ok, r.name);
	console.log(`  ${results.filter((r) => r.ok).length}/${results.length} checks`);
}

section("§1 findDirectoryRowForDriver()");
record(lookupBattery());
section('§2 syncDriverToCarrierSheet() "update"');
record(updateBattery());
section('§3 syncDriverToCarrierSheet() "delete"');
record(deleteBattery());

section("§4 source pins");
{
	const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const sync = code(FN_SRC.syncDriverToCarrierSheet);
	const upd = sync.slice(sync.indexOf('action === "update"'), sync.indexOf('action === "delete"'));
	const del = sync.slice(sync.indexOf('action === "delete"'));
	ok(upd.includes("findDirectoryRowForDriver(oldName || driverName") && !/SELECT id FROM drivers_directory/.test(upd),
		'§4 "update" finds its row through findDirectoryRowForDriver(), with no lookup of its own');
	ok(del.includes("findDirectoryRowForDriver(name)"), '§4 "delete" finds its row through findDirectoryRowForDriver()');
	ok(/normalizeDriverName\(t\.assigned_driver\) === normalizeDriverName\(name\)/.test(sync),
		"§4 the truck is also found through normalizeDriverName()");
	ok(code(FN_SRC.findDirectoryRowForDriver).includes("findDriverNameClashes(trimmed, { users: false })"),
		"§4 the helper's second step is the naming check's own comparison");
	console.log("  source pins checked");
}

section("§5 the mutant — it must be caught");
{
	// findDirectoryRowForDriver() back to LOWER() equality alone: the lookup the
	// sync (and the driver page) used before.
	const LOWER_ONLY = {
		findDirectoryRowForDriver: mutate(FN_SRC.findDirectoryRowForDriver,
			"const hit = findDriverNameClashes(trimmed, { users: false })[0];", "const hit = null;"),
	};
	const caught = [...lookupBattery(LOWER_ONLY), ...updateBattery(LOWER_ONLY), ...deleteBattery(LOWER_ONLY)].filter((r) => !r.ok);
	ok(caught.length > 0, "M1 the directory lookup reverted to LOWER() equality is caught");
	console.log(`  M1 LOWER() equality: caught by ${caught.length} check(s), e.g.`);
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
