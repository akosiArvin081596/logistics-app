#!/usr/bin/env node
// Locks the duplicate-receipt guard: the WRITE-time block/override decision and
// the UNIQUE PARTIAL index that stands behind it.
//
// WHY THIS EXISTS. Deshorn's ask was "make sure that the receipt doesn't have
// any duplicate and if it has duplicate just let it automatically send me a
// ping." Two of the three pieces that answer it are one-line predicates whose
// WRONG version is indistinguishable from the right one at a glance, and whose
// wrong version fails SILENTLY — no error, no log, just money booked twice:
//
//   (1) `wantsDuplicateCheck` decides whether a POST /api/expenses is checked at
//       all. It used to be `req.body?.checkDuplicate === true && ...`, i.e.
//       OPT-IN, so only the two admin surfaces that happened to send the flag
//       were ever checked. The driver app, and anything scripted, could book a
//       known duplicate with no check. A guard nobody has to ask for is not a
//       guard, and its failure mode is an expense that simply appears twice.
//
//   (2) `receiptHashIndexIsCurrent` decides whether the UNIQUE index migration
//       runs. Testing only /WHERE/ is TRUE FOREVER once a partial index exists;
//       testing only /UNIQUE/ is TRUE FOREVER once a unique one does. Either
//       single test can leave the migration permanently convinced it is done
//       while the constraint it was supposed to install is half-absent. This is
//       not hypothetical — it is the exact bug idx_invoices_driver_week shipped
//       with, which is why that migration's header names it as rule (c).
//
// ⚠️ EVERY CASE IS PAIRED, so a trivial implementation cannot pass. A predicate
// that always says "check it" passes every blocking case and fails the audited
// override; one that always says "don't" fails the reverse. The index predicate
// is run against BOTH half-done index shapes, and the two single-property
// mutants are executed alongside the shipped one and asserted to get it WRONG —
// a test that only proves the correct answer proves nothing about whether the
// assertion is still live.
//
// The partial clause gets the same treatment. `WHERE receipt_hash <> ''` reads
// like a tidy-up and is load-bearing: '' is the value on every legacy row and
// every expense filed with no photo (3 live rows today), so a plain UNIQUE index
// makes those collide WITH EACH OTHER — the first receipt-less expense takes the
// '' slot and every one after it is refused. That counter-case is executed here
// against a real non-partial index, not asserted in a comment.
//
// Source is EXTRACTED from server.js and executed — testing a re-implementation
// would prove nothing about the code that boots. The extraction asserts exactly
// one hit per anchor, so a rename or a second copy fails the run loudly rather
// than silently testing nothing.
//
// No network, no filesystem writes, no app.db — scratch in-memory databases only.
//
//   node scripts/test-duplicate-guard.js     # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SERVER = path.join(__dirname, "..", "server.js");
const SRC = fs.readFileSync(SERVER, "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(name, actual, expected) {
	const a = JSON.stringify(actual), e = JSON.stringify(expected);
	if (a === e) { pass++; return true; }
	fail++; failures.push(`${name}\n     expected ${e}\n     actual   ${a}`);
	console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
	return false;
}

// ---------------------------------------------------------------- extraction
function extractFn(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	let depth = 0;
	for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
		if (SRC[j] === "{") depth++;
		else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

function extractOne(re, label) {
	const all = SRC.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
	if (!all || all.length !== 1) {
		throw new Error(`expected exactly 1 ${label} in server.js, found ${all ? all.length : 0}`);
	}
	return SRC.match(re);
}

// ═══════════════════════════════════════════════════════════════════════════
// §1  THE WRITE-TIME DECISION — is this POST checked for a content duplicate?
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n§1  wantsDuplicateCheck — block by default, one audited override");

const wantsSrc = extractOne(/const wantsDuplicateCheck = ([^;]+);/, "`wantsDuplicateCheck` assignment")[1];
const wantsDuplicateCheck = new Function("req", `return (${wantsSrc});`);

// THE REGRESSION LOCK. The opt-in form is what made the guard unreachable from
// every surface that did not know to ask for it. Pinned textually because the
// behavioural table below would still pass a predicate that reintroduced it
// alongside something else.
check("the opt-in `checkDuplicate === true &&` form is gone from server.js",
	SRC.includes("req.body?.checkDuplicate === true &&"), false);

// (a) BLOCKS — the cases that must all be checked.
check("no flags at all → CHECKED (this is the whole fix)", wantsDuplicateCheck({ body: {} }), true);
check("empty body → CHECKED", wantsDuplicateCheck({ body: undefined }), true);
check("checkDuplicate:true → CHECKED (the two admin surfaces still work)", wantsDuplicateCheck({ body: { checkDuplicate: true } }), true);
// ⚠️ NOT an opt-out. A second, silent door around the guard is how the first
// version came to be unenforced everywhere, and an override that leaves no
// audit row cannot dismiss anything in duplicateReceiptGroups().
check("checkDuplicate:false → STILL CHECKED (no silent opt-out door)", wantsDuplicateCheck({ body: { checkDuplicate: false } }), true);
check("unrelated body keys → CHECKED", wantsDuplicateCheck({ body: { amount: 200, driver: "x" } }), true);

// (b) OVERRIDES — the single audited escape, and only on a strict boolean true.
check("allowDuplicate:true → NOT checked (audited override)", wantsDuplicateCheck({ body: { allowDuplicate: true } }), false);
check("allowDuplicate:true + checkDuplicate:true → NOT checked", wantsDuplicateCheck({ body: { allowDuplicate: true, checkDuplicate: true } }), false);
// Truthiness is not consent. A stringly-typed client sending "true" must not
// silently book a duplicate; === true is what keeps the override deliberate.
check("allowDuplicate:'true' (string) → CHECKED", wantsDuplicateCheck({ body: { allowDuplicate: "true" } }), true);
check("allowDuplicate:1 → CHECKED", wantsDuplicateCheck({ body: { allowDuplicate: 1 } }), true);
check("allowDuplicate:false → CHECKED", wantsDuplicateCheck({ body: { allowDuplicate: false } }), true);

// (c) THE PAIRING, made explicit: both trivial implementations must fail this
// table. Without this the §1 assertions above could all be satisfied by a
// constant, which is exactly what an opt-in predicate degenerates to on every
// surface that does not send the flag.
{
	const alwaysCheck = () => true;
	const neverCheck = () => false;
	check("mutant `() => true` gets the audited override WRONG",
		alwaysCheck({ body: { allowDuplicate: true } }) === wantsDuplicateCheck({ body: { allowDuplicate: true } }), false);
	check("mutant `() => false` gets the default WRONG",
		neverCheck({ body: {} }) === wantsDuplicateCheck({ body: {} }), false);
	// And the historical predicate, run as written, gets the default wrong —
	// which is the bug in one line.
	const optIn = (req) => req.body?.checkDuplicate === true && req.body?.allowDuplicate !== true;
	check("the historical opt-in predicate leaves a bare POST UNCHECKED", optIn({ body: {} }), false);
	check("...where the shipped predicate checks it", wantsDuplicateCheck({ body: {} }), true);
}

// ═══════════════════════════════════════════════════════════════════════════
// §2  THE REBUILD PREDICATE — true ONLY when the index is UNIQUE *and* PARTIAL
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n§2  receiptHashIndexIsCurrent — both properties, or false-forever");

// Every index shape this predicate can meet on a real database. The two in the
// middle are the ones that matter: each is what a single-property test calls
// "already migrated", and each leaves half the constraint missing.
const SHAPES = {
	absent: null,
	// Today's production shape — the bootstrap line, neither unique nor partial.
	legacy: `CREATE INDEX idx_expenses_receipt_hash ON expenses(receipt_hash)`,
	// Half-done A: partial, NOT unique. A /WHERE/-only predicate calls this done.
	partialOnly: `CREATE INDEX idx_expenses_receipt_hash ON expenses(receipt_hash) WHERE receipt_hash <> ''`,
	// Half-done B: unique, NOT partial. A /UNIQUE/-only predicate calls this done,
	// and this is the shape that breaks receipt-less expenses (see §4).
	uniqueOnly: `CREATE UNIQUE INDEX idx_expenses_receipt_hash ON expenses(receipt_hash)`,
	// The target.
	current: `CREATE UNIQUE INDEX idx_expenses_receipt_hash ON expenses(receipt_hash) WHERE receipt_hash <> ''`,
	// SQLite echoes back the statement as written, so casing is not ours to
	// assume. Both regexes are /i for this reason.
	currentLower: `create unique index idx_expenses_receipt_hash on expenses(receipt_hash) where receipt_hash <> ''`,
};

function predicateDb(sql) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, receipt_hash TEXT DEFAULT '')`);
	if (sql) db.exec(sql);
	return db;
}
function shippedPredicate(db) {
	const M = new Function("db", `${extractFn("receiptHashIndexSql")}\n${extractFn("receiptHashIndexIsCurrent")}\nreturn receiptHashIndexIsCurrent;`)(db);
	return M("idx_expenses_receipt_hash");
}

const EXPECTED = {
	absent: false, legacy: false, partialOnly: false, uniqueOnly: false,
	current: true, currentLower: true,
};
for (const [name, sql] of Object.entries(SHAPES)) {
	check(`shipped predicate on ${name}`, shippedPredicate(predicateDb(sql)), EXPECTED[name]);
}

// THE MUTANTS, executed. Each is a predicate somebody could plausibly write, and
// each is asserted to get exactly one shape wrong — which is what proves the
// cases above are load-bearing rather than decorative.
{
	const sqlOf = (db) => {
		const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_expenses_receipt_hash'").get();
		return r && r.sql ? r.sql : "";
	};
	const whereOnly = (db) => /\bWHERE\b/i.test(sqlOf(db));
	const uniqueOnly = (db) => /\bUNIQUE\b/i.test(sqlOf(db));

	check("mutant /WHERE/-only calls the partial-but-NOT-unique index 'done'", whereOnly(predicateDb(SHAPES.partialOnly)), true);
	check("...while the shipped one refuses it", shippedPredicate(predicateDb(SHAPES.partialOnly)), false);
	check("mutant /UNIQUE/-only calls the unique-but-NOT-partial index 'done'", uniqueOnly(predicateDb(SHAPES.uniqueOnly)), true);
	check("...while the shipped one refuses it", shippedPredicate(predicateDb(SHAPES.uniqueOnly)), false);
	// Both mutants agree with the shipped predicate on the target, which is
	// precisely why neither is caught by testing only the happy path.
	check("both mutants agree on the target shape (so the happy path proves nothing)",
		whereOnly(predicateDb(SHAPES.current)) && uniqueOnly(predicateDb(SHAPES.current)), true);
}

// ═══════════════════════════════════════════════════════════════════════════
// §3  THE MIGRATION, EXECUTED
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n§3  the migration — pre-flight, create-then-drop, resumability");

const START = `const RECEIPT_HASH_IDX = "idx_expenses_receipt_hash";`;
const END = `console.error("expenses receipt_hash unique-index migration failed:", err.message);`;
function extractMigration() {
	const startHits = SRC.split(START).length - 1;
	if (startHits !== 1) throw new Error(`expected exactly 1 '${START}' in server.js, found ${startHits}`);
	const endHits = SRC.split(END).length - 1;
	if (endHits !== 1) throw new Error(`expected exactly 1 migration catch in server.js, found ${endHits}`);
	const s = SRC.indexOf(START);
	const e = SRC.indexOf(END, s);
	const close = SRC.indexOf("\n}", e);
	if (close < 0) throw new Error("could not find the end of the migration try/catch");
	return SRC.slice(s, close + 2);
}
const MIGRATION_SRC = extractMigration();

function runMigration(db) {
	const logs = [];
	const fakeConsole = {
		log: (...a) => logs.push(["log", a.join(" ")]),
		error: (...a) => logs.push(["error", a.join(" ")]),
	};
	let threw = null;
	try { new Function("db", "console", MIGRATION_SRC)(db, fakeConsole); }
	catch (err) { threw = err.message; }
	return { logs, threw };
}

// A scratch database in the shape the migration meets at boot.
function scratch({ index = "legacy", rows = [] } = {}) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE expenses (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		driver TEXT DEFAULT '',
		amount REAL DEFAULT 0,
		date TEXT DEFAULT '',
		receipt_hash TEXT DEFAULT ''
	)`);
	for (const r of rows) {
		db.prepare("INSERT INTO expenses (driver, amount, date, receipt_hash) VALUES (?,?,?,?)")
			.run(r.driver || "d", r.amount || 1, r.date || "2026-08-01", r.receipt_hash === undefined ? "" : r.receipt_hash);
	}
	if (index === "legacy") db.exec(SHAPES.legacy);
	else if (index === "current") db.exec(SHAPES.current);
	else if (index === "uniqueOnly") db.exec(SHAPES.uniqueOnly);
	// "none" → nothing
	return db;
}
function indexSql(db, name) {
	const r = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name);
	return r ? r.sql : null;
}
function indexNames(db) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_expenses_receipt_hash%' ORDER BY name")
		.all().map((r) => r.name);
}
// The property the whole exercise exists for.
function insertRefused(db, hash) {
	try {
		db.prepare("INSERT INTO expenses (driver, amount, date, receipt_hash) VALUES ('d', 1, '2026-08-01', ?)").run(hash);
		return false;
	} catch { return true; }
}

// ── (a) the happy path, from today's production shape ──────────────────────
{
	const db = scratch({ index: "legacy", rows: [{ receipt_hash: "aaa" }, { receipt_hash: "bbb" }, { receipt_hash: "" }] });
	check("before: the legacy index does NOT stop a duplicate hash", insertRefused(db, "aaa"), false);
	db.prepare("DELETE FROM expenses WHERE id = (SELECT MAX(id) FROM expenses)").run(); // undo the probe
	const { threw, logs } = runMigration(db);
	check("migration does not throw", threw, null);
	check("canonical index is now UNIQUE + PARTIAL", shippedPredicate(db), true);
	check("only the canonical index survives (temp swept)", indexNames(db), ["idx_expenses_receipt_hash"]);
	check("after: a duplicate hash is REFUSED", insertRefused(db, "aaa"), true);
	check("after: a NEW hash still inserts", insertRefused(db, "ccc"), false);
	check("it announced the migration", logs.some(([lvl, m]) => lvl === "log" && /Migrated idx_expenses_receipt_hash/.test(m)), true);
}

// ── (b) fresh install: no index at all ─────────────────────────────────────
{
	const db = scratch({ index: "none" });
	runMigration(db);
	check("fresh install ends UNIQUE + PARTIAL", shippedPredicate(db), true);
	check("fresh install leaves no temp behind", indexNames(db), ["idx_expenses_receipt_hash"]);
}

// ── (c) COLLISION PRE-FLIGHT — abort loudly, change nothing ────────────────
// Which of two rows sharing a receipt is the real expense is a business
// question, and both rows are money already booked into a P&L. The migration
// must refuse rather than pick one.
{
	const db = scratch({ index: "legacy", rows: [{ receipt_hash: "dup" }, { receipt_hash: "dup" }, { receipt_hash: "ok" }] });
	const before = indexSql(db, "idx_expenses_receipt_hash");
	const { threw, logs } = runMigration(db);
	check("pre-flight: does not throw (boot must continue)", threw, null);
	check("pre-flight: SKIPPED loudly on console.error",
		logs.some(([lvl, m]) => lvl === "error" && /SKIPPED/.test(m) && /dup/.test(m)), true);
	check("pre-flight: the existing index is byte-identical", indexSql(db, "idx_expenses_receipt_hash"), before);
	check("pre-flight: no unique index was created", shippedPredicate(db), false);
	check("pre-flight: no temp index left behind", indexNames(db), ["idx_expenses_receipt_hash"]);
	// Not silently half-applied: without a unique index the duplicate is still
	// insertable, which is the honest (and reversible) state.
	check("pre-flight: leaves the table exactly as it found it", insertRefused(db, "dup"), false);
	// Nothing was deleted or rewritten.
	check("pre-flight: row count untouched", db.prepare("SELECT COUNT(*) c FROM expenses").get().c, 4);
}

// ⚠️ PAIRED: the pre-flight is scoped to the index's OWN predicate, so rows the
// index would never cover must NOT block the upgrade. Three receipt-less
// expenses share receipt_hash = '' in production today; a pre-flight that
// counted them would refuse to ever run.
{
	const db = scratch({ index: "legacy", rows: [{ receipt_hash: "" }, { receipt_hash: "" }, { receipt_hash: "" }, { receipt_hash: "x" }] });
	const { logs } = runMigration(db);
	check("pre-flight ignores the '' rows and the migration APPLIES", shippedPredicate(db), true);
	check("...and did not report a collision", logs.some(([lvl]) => lvl === "error"), false);
}

// ── (d) CREATE-THEN-DROP — the window the old shape left unprotected ───────
// SQLite cannot rename an index, so the replacement is built under a temp name
// first. Simulate a crash in the exact window where the canonical name does not
// exist and assert the constraint is STILL being enforced by the temp.
{
	const db = scratch({ index: "legacy", rows: [{ receipt_hash: "aaa" }] });
	db.exec(`CREATE UNIQUE INDEX idx_expenses_receipt_hash_migrating ON expenses(receipt_hash) WHERE receipt_hash <> ''`);
	db.exec(`DROP INDEX idx_expenses_receipt_hash`);   // ← crash lands here
	check("mid-migration: canonical index is absent", indexSql(db, "idx_expenses_receipt_hash"), null);
	check("mid-migration: a duplicate is STILL refused (the temp holds it)", insertRefused(db, "aaa"), true);
	// Next boot resumes and converges.
	const { threw } = runMigration(db);
	check("resume: no throw", threw, null);
	check("resume: canonical index restored, UNIQUE + PARTIAL", shippedPredicate(db), true);
	check("resume: temp swept", indexNames(db), ["idx_expenses_receipt_hash"]);
	check("resume: duplicate still refused", insertRefused(db, "aaa"), true);
}

// ── (e) already-current + a stranded temp → branch (d) sweeps it ───────────
// If the FINAL drop is what failed, the canonical index is already current, so
// every later boot skips the whole block and the temp survives forever, costing
// a second write on every expense insert.
{
	const db = scratch({ index: "current" });
	db.exec(`CREATE UNIQUE INDEX idx_expenses_receipt_hash_migrating ON expenses(receipt_hash) WHERE receipt_hash <> ''`);
	runMigration(db);
	check("already-current: stranded temp is swept", indexNames(db), ["idx_expenses_receipt_hash"]);
	check("already-current: canonical index untouched", shippedPredicate(db), true);
}

// ── (f) idempotent: running it twice changes nothing ───────────────────────
{
	const db = scratch({ index: "legacy", rows: [{ receipt_hash: "aaa" }] });
	runMigration(db);
	const after1 = indexSql(db, "idx_expenses_receipt_hash");
	runMigration(db);
	check("second run is a no-op", indexSql(db, "idx_expenses_receipt_hash"), after1);
	check("second run leaves no temp", indexNames(db), ["idx_expenses_receipt_hash"]);
}

// ═══════════════════════════════════════════════════════════════════════════
// §4  THE PARTIAL CLAUSE IS LOAD-BEARING, NOT DECORATION
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n§4  WHERE receipt_hash <> '' — the receipt-less rows must coexist");

// The shipped index: many '' rows, at most one of each real hash.
{
	const db = scratch({ index: "legacy" });
	runMigration(db);
	check("three receipt-less expenses ('') all insert", [insertRefused(db, ""), insertRefused(db, ""), insertRefused(db, "")], [false, false, false]);
	check("two DIFFERENT hashes both insert", [insertRefused(db, "h1"), insertRefused(db, "h2")], [false, false]);
	check("the SAME hash a second time is refused", insertRefused(db, "h1"), true);
	// NULL is excluded twice over — `NULL <> ''` is NULL (not true) so the partial
	// predicate skips the row, and SQLite treats NULLs in a UNIQUE index as
	// distinct anyway. Nothing writes NULL here, but it must not be a trap.
	check("NULL rows coexist", [insertRefused(db, null), insertRefused(db, null)], [false, false]);
}

// ⚠️ THE COUNTER-CASE. The same table under a NON-partial unique index — the
// "uniqueOnly" half-done shape from §2. The first receipt-less expense takes the
// '' slot and every one after it is refused, which is a hard failure on an
// ordinary no-photo expense. This is what the WHERE clause buys.
{
	const db = scratch({ index: "uniqueOnly" });
	check("non-partial UNIQUE: the FIRST '' row inserts", insertRefused(db, ""), false);
	check("non-partial UNIQUE: the SECOND '' row is REFUSED (the bug)", insertRefused(db, ""), true);
	// And the shipped predicate correctly refuses to accept that index as done,
	// so a database in this state gets repaired rather than left broken.
	check("...and the shipped predicate does not call it migrated", shippedPredicate(db), false);
}

// ═══════════════════════════════════════════════════════════════════════════
// §5  THE ALERT'S DEDUPE KEY IS VALIDATED, NOT MERELY TRIMMED
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n§5  alertDuplicateReceipts — the group key must be validated");

// duplicateKey() builds `t:<truck_unit>|<date>|<cents>` (or `d:<driver>|...`),
// and BOTH the truck unit and the driver name are free text that reaches the
// database through a form. The key therefore carries attacker-influenced text
// into a PRIMARY KEY, a mail subject and a pm2 log line. Anything off-shape must
// collapse into the shared per-day bucket rather than minting a fresh key — a
// fresh key per sighting turns "once per group" into "once per sweep".
const KEY_RE = new Function(`return ${extractOne(/const key = (\/\^\[td\][^/\n]*\/)\.test\(raw\)/, "group-key validation regex")[1]};`)();

const keyOk = (k) => KEY_RE.test(k);
check("real truck-scoped key", keyOk("t:logisx-#33|2026-06-18|20000"), true);
check("real driver-scoped key", keyOk("d:shorn king|2026-08-01|40000"), true);
check("scope letter must be t or d", keyOk("x:foo|2026-06-18|20000"), false);
// ⚠️ The newline cases are the point: a truck unit typed with a line break
// forges pm2 log lines and mail headers. nodemailer strips CR/LF from a Subject,
// but relying on a dependency for that is not a control we own.
check("embedded newline rejected", keyOk("t:unit\n2026|2026-06-18|20000"), false);
check("embedded CR rejected", keyOk("t:unit\r|2026-06-18|20000"), false);
check("extra pipe in the scope segment rejected", keyOk("t:a|b|2026-06-18|20000"), false);
check("empty scope segment rejected", keyOk("t:|2026-06-18|20000"), false);
check("81-char scope segment rejected (bounded)", keyOk(`t:${"u".repeat(81)}|2026-06-18|20000`), false);
check("80-char scope segment accepted (bound is inclusive)", keyOk(`t:${"u".repeat(80)}|2026-06-18|20000`), true);
check("malformed date rejected", keyOk("t:unit|18-06-2026|20000"), false);
check("non-numeric cents rejected", keyOk("t:unit|2026-06-18|20o00"), false);
check("13-digit cents rejected (bounded)", keyOk("t:unit|2026-06-18|1234567890123"), false);
check("trailing junk rejected (anchored)", keyOk("t:unit|2026-06-18|20000 extra"), false);
check("leading junk rejected (anchored)", keyOk(" t:unit|2026-06-18|20000"), false);
check("empty string rejected", keyOk(""), false);
// PAIRED, against the mutant the code comment names by hand: "validated, NOT
// merely trimmed". A trim-and-use check is the obvious implementation and it is
// the one that admits every case above, so these assertions are not just
// restating the regex back to itself.
{
	const trimmedOnly = (k) => String(k == null ? "" : k).trim().length > 0;
	const nasty = "t:unit\n2026|2026-06-18|20000";
	check("mutant `trim().length > 0` accepts an embedded newline", trimmedOnly(nasty), true);
	check("...while the shipped regex refuses it", keyOk(nasty), false);
	check("mutant `trim().length > 0` accepts an unbounded key", trimmedOnly("t:" + "u".repeat(5000) + "|2026-06-18|20000"), true);
	check("...while the shipped regex refuses it", keyOk("t:" + "u".repeat(5000) + "|2026-06-18|20000"), false);
	// It even accepts a bare attacker-chosen string, i.e. a fresh PRIMARY KEY per
	// sighting — which is precisely how "once per group" becomes "once per sweep".
	check("mutant `trim().length > 0` accepts arbitrary text as a key", trimmedOnly("whatever I like"), true);
	check("...while the shipped regex refuses it", keyOk("whatever I like"), false);
}


// ===========================================================================
// §6  THE ALERT LEDGER'S RE-OPEN — a recurrence must never be silenced forever
// ===========================================================================
//
// WHY THIS EXISTS. `alertDuplicateReceipts()` is a STANDING-CONDITION ledger:
// a group can be alerted, settled, and then come BACK when a fresh copy is
// filed. Three pieces have to agree for that to work, and until 2026-09-19 they
// did not:
//
//   (a) the dedupe guard   `if (seen && seen.alerted_at && !seen.resolved_at)`
//   (b) the UPSERT         cleared `resolved_at` on a re-open...
//   (c) the delivery stamp `... WHERE group_key = ? AND alerted_at IS NULL`
//
// (b) did NOT clear `alerted_at`. The stamp in (c) is deliberately gated on
// `delivered = emailed || notified`, so when BOTH channels fail nothing is
// stamped — correct, that is the retry design. But the row still carried the
// PREVIOUS episode's `alerted_at` while (b) had just set `resolved_at` to NULL,
// which is exactly the shape (a) reads as "already told you". Every later sweep
// took the dedupe branch and THE RECURRENCE WAS NEVER REPORTED AGAIN.
//
// The same stale stamp also counts toward the rolling-24h cap, spending the
// day's alert budget on an episode that was closed and a send that never landed.
//
// ⚠️ THE MUTANT IS THE POINT. Asserting the fixed behaviour alone proves
// nothing — a test that never sees the bug cannot tell you the bug is gone. The
// shipped UPSERT and a mutant with `alerted_at = NULL` stripped are driven
// through the IDENTICAL lifecycle, and the mutant is asserted to get it WRONG.
{
	console.log("\n§6  expense_duplicate_alerts — settle, recur, and a failed re-open");

	// ⚠️ SCOPE EVERY EXTRACTION TO THIS FUNCTION. The dedupe-guard line is
	// character-for-character identical in alertEldFeedSilence() (server.js:2944),
	// which copied this ledger's shape ON PURPOSE — a file-wide match finds two
	// and cannot tell you which one it grabbed. extractFn() cannot help: it looks
	// for `\nfunction NAME(` and both of these are `async function`.
	function fnBody(name) {
		const needle = `\nasync function ${name}(`;
		const hits = SRC.split(needle).length - 1;
		if (hits !== 1) throw new Error(`expected exactly 1 async ${name}() in server.js, found ${hits}`);
		const start = SRC.indexOf(needle) + 1;
		let depth = 0;
		for (let j = SRC.indexOf("{", start); j < SRC.length; j++) {
			if (SRC[j] === "{") depth++;
			else if (SRC[j] === "}") { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
		}
		throw new Error(`unbalanced braces extracting ${name}()`);
	}
	const FN = fnBody("alertDuplicateReceipts");
	function one(re, label) {
		const all = FN.match(new RegExp(re.source, "g"));
		if (!all || all.length !== 1) {
			throw new Error(`expected exactly 1 ${label} in alertDuplicateReceipts(), found ${all ? all.length : 0}`);
		}
		return FN.match(re)[0];
	}

	const ddl = extractOne(
		/CREATE TABLE IF NOT EXISTS expense_duplicate_alerts \([\s\S]*?\n\t\)/,
		"expense_duplicate_alerts DDL",
	)[0];
	// The shipped UPSERT, lifted verbatim. Executing the real string is the only
	// thing that proves the SQL is valid at all — `node --check` parses the JS
	// around it, never the SQL inside it. (Not hypothetical: the first cut of
	// this fix put backticks in the SQL comment and silently terminated the
	// template literal.)
	// ⚠️ Capture to the END OF THE STATEMENT, never to the clause under test.
	// Anchoring on `alerted_at = NULL` makes this extraction throw the moment
	// someone reverts the fix — a red build, but one that says "found 0" instead
	// of "the recurrence is silenced forever", and it skips every lifecycle
	// assertion below. A test should fail where it means something.
	const upsertShipped = one(/INSERT INTO expense_duplicate_alerts[\s\S]*?(?=\n\t\t`\)\.run\()/, "the UPSERT");
	const stampSql = one(
		/UPDATE expense_duplicate_alerts SET alerted_at = \? WHERE group_key = \? AND alerted_at IS NULL/,
		"the delivery stamp",
	);
	const capSql = one(
		/SELECT COUNT\(\*\) AS c FROM expense_duplicate_alerts WHERE alerted_at > datetime\('now', '-1 day'\)/,
		"the rolling-24h cap query",
	);
	const GUARD_RE = /if \(seen && seen\.alerted_at && !seen\.resolved_at\) return \{ alerted: false, reason: "already_alerted", key \};/;
	const guardSrc = one(GUARD_RE, "the dedupe guard");

	// The duplication is deliberate; pin it so an accidental THIRD copy is loud.
	const guardCopies = (SRC.match(new RegExp(GUARD_RE.source, "g")) || []).length;
	check("the dedupe guard is duplicated exactly twice, on purpose", guardCopies, 2);
	check(
		"...and the other copy is alertEldFeedSilence()",
		GUARD_RE.test(fnBody("alertEldFeedSilence")),
		true,
	);

	check("the shipped UPSERT clears alerted_at", /alerted_at = NULL/.test(upsertShipped), true);
	check("the shipped UPSERT clears resolved_at", /resolved_at = NULL/.test(upsertShipped), true);
	check("the stamp is still gated on alerted_at IS NULL", /alerted_at IS NULL/.test(stampSql), true);

	// The guard, executed rather than eyeballed.
	const guard = new Function("seen", `const key = "k"; ${guardSrc} return null;`);
	check("guard: alerted + unresolved  -> dedupe", guard({ alerted_at: "t", resolved_at: null }) !== null, true);
	check("guard: alerted + RESOLVED    -> let through", guard({ alerted_at: "t", resolved_at: "t" }), null);
	check("guard: never alerted         -> let through", guard({ alerted_at: null, resolved_at: null }), null);

	// Strip exactly the clause this fix added — nothing else changes.
	const upsertMutant = upsertShipped.replace(/resolved_at = NULL,[\s\S]*?alerted_at = NULL/, "resolved_at = NULL");
	check("mutant really did drop the clause", /alerted_at = NULL/.test(upsertMutant), false);
	check("...and kept everything else", /resolved_at = NULL/.test(upsertMutant), true);

	const KEY = "t:LogisX-#33|2026-09-18|12000";
	const MAX_PER_DAY = 25;

	// One sweep of the shipped decision path, with the send result injected.
	function sweepOnce(db, upsertSql, { delivered }) {
		const seen = db
			.prepare("SELECT group_key, alerted_at, resolved_at FROM expense_duplicate_alerts WHERE group_key = ?")
			.get(KEY);
		if (guard(seen) !== null) return "already_alerted";
		if (db.prepare(capSql).get().c >= MAX_PER_DAY) return "daily_cap";
		db.prepare(upsertSql).run(KEY, "LogisX-#33", "Howard Reddie", "2026-09-18", 120, 60, "high", "1,2", KEY);
		if (delivered) db.prepare(stampSql).run(new Date().toISOString(), KEY);
		return delivered ? "alerted" : "send_failed";
	}
	const rowOf = (db) => db.prepare("SELECT * FROM expense_duplicate_alerts WHERE group_key = ?").get(KEY);
	const resolve = (db) =>
		db.prepare("UPDATE expense_duplicate_alerts SET resolved_at = CURRENT_TIMESTAMP WHERE group_key = ?").run(KEY);

	// Drive the IDENTICAL lifecycle through both builds.
	function lifecycle(upsertSql) {
		const db = new Database(":memory:");
		db.exec(ddl);
		const out = {};
		out.episode1 = sweepOnce(db, upsertSql, { delivered: true });
		out.firstSeen = rowOf(db).first_seen;
		out.whileStanding = sweepOnce(db, upsertSql, { delivered: true });
		resolve(db);
		// The recurrence — and both channels are down.
		out.reopenFailed = sweepOnce(db, upsertSql, { delivered: false });
		out.alertedAtAfterReopen = rowOf(db).alerted_at;
		out.capAfterReopen = db.prepare(capSql).get().c;
		// The very next sweep is the one that decides whether this is ever told.
		out.nextSweep = sweepOnce(db, upsertSql, { delivered: true });
		const r = rowOf(db);
		out.finalAlertedAt = r.alerted_at;
		out.firstSeenPreserved = r.first_seen === out.firstSeen;
		db.close();
		return out;
	}

	const fixed = lifecycle(upsertShipped);
	const buggy = lifecycle(upsertMutant);

	// ── the shipped build ──────────────────────────────────────────────────
	check("episode 1 alerts", fixed.episode1, "alerted");
	check("a second sweep while STANDING is deduped", fixed.whileStanding, "already_alerted");
	check("a re-open whose sends both fail reports send_failed", fixed.reopenFailed, "send_failed");
	check("...and leaves alerted_at NULL, so the retry is live", fixed.alertedAtAfterReopen, null);
	check("...and does NOT spend the 24h budget", fixed.capAfterReopen, 0);
	check("THE REGRESSION: the next sweep re-alerts", fixed.nextSweep, "alerted");
	check("...stamping alerted_at at last", fixed.finalAlertedAt !== null, true);
	check("first_seen survives the settle-and-recur cycle", fixed.firstSeenPreserved, true);

	// ── the mutant, driven through the same steps, must get it WRONG ───────
	check("mutant: episode 1 also alerts", buggy.episode1, "alerted");
	check("mutant: carries the stale stamp through the re-open", buggy.alertedAtAfterReopen !== null, true);
	check("mutant: and that stale stamp poisons the 24h cap", buggy.capAfterReopen, 1);
	check("mutant: so the recurrence is silenced FOREVER", buggy.nextSweep, "already_alerted");
}

// ---------------------------------------------------------------------------
if (failures.length) {
	console.log("\n─── failures ───");
	for (const f of failures) console.log("  " + f);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
