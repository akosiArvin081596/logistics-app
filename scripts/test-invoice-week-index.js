#!/usr/bin/env node
// Locks the idx_invoices_driver_week migration in server.js.
//
// WHAT THE INDEX IS. The one-invoice-per-driver-week constraint: UNIQUE over
// (driver, week_start), scoped to LIVE GENERATED invoices (deleted_at = '' AND
// is_manual = 0). It is the only structural thing stopping a driver being paid
// twice for one week.
//
// THE BUG. Its collation was BINARY while every reader folds case
// (`driverOwnsInvoice()`, `LOWER(driver) = ?`). Readers merge the spellings; the
// constraint permitted them — so `"Shorn King"` and `"shorn king"` were two
// index entries and a SECOND live weekly invoice for one driver-week was
// structurally insertable. Production carries exactly one mixed-case row
// (invoice #40, PAID, in two locked periods) beside 13 lowercase ones.
//
// THE MIGRATION IS THE DANGEROUS PART, and is most of what this file tests. The
// previous version did DROP INDEX then CREATE UNIQUE INDEX as two statements,
// not in a transaction, inside a catch that only console.error'd and let boot
// continue. A failure landing between them left the table with NO UNIQUE INDEX
// AT ALL, silently — strictly weaker than never migrating. So three properties
// are asserted, each with the mutant that proves the assertion is live:
//
//   (a) COLLISION PRE-FLIGHT — existing fold-to-one duplicates abort the
//       migration LOUDLY and leave the old index byte-identical. Scoped to the
//       index's own predicate, so a soft-deleted or manual duplicate must NOT
//       block the upgrade (they are legal rows).
//   (b) CREATE-THEN-DROP — the replacement is built under a temporary name and
//       verified BEFORE the old one is dropped. Tested by simulating a crash in
//       the exact window the old code left unprotected, and asserting a
//       duplicate insert is STILL refused.
//   (c) REBUILD PREDICATE — it used to test only /\bWHERE\b/, which is true
//       forever once the partial index exists, so this migration would have been
//       DEAD ON ARRIVAL on every database that had already been upgraded, i.e.
//       all of them. The predicate must test the collation too.
//
// The migration source is EXTRACTED from server.js and executed against
// scratch in-memory databases — testing a re-implementation would prove nothing
// about the code that runs at boot. No network, no filesystem, no app.db.
//
//   node scripts/test-invoice-week-index.js     # exits 1 on any failure

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
// Anchored on the declaration and the terminating catch. Asserts a single hit
// so a rename or an accidental second copy is a loud failure, not a silent
// no-op suite.
const START = `const INVOICE_WEEK_IDX = "idx_invoices_driver_week";`;
const END = `console.error("invoices unique-index migration failed:", err.message);`;
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

// Run the extracted migration against a database, capturing its console output.
function runMigration(db, src = MIGRATION_SRC) {
	const logs = [];
	const fakeConsole = {
		log: (...a) => logs.push(["log", a.join(" ")]),
		error: (...a) => logs.push(["error", a.join(" ")]),
	};
	let threw = null;
	try {
		new Function("db", "console", src)(db, fakeConsole);
	} catch (err) { threw = err.message; }
	return { logs, threw };
}

// A scratch database in the shape the migration meets at boot: the invoices
// table plus whichever index generation we are starting from.
function scratch({ index = "partial-binary", rows = [] } = {}) {
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE invoices (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			invoice_number TEXT NOT NULL UNIQUE,
			driver TEXT NOT NULL,
			week_start TEXT NOT NULL,
			week_end TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'Draft',
			deleted_at TEXT DEFAULT '',
			is_manual INTEGER DEFAULT 0
		);
	`);
	let n = 0;
	for (const r of rows) {
		db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, deleted_at, is_manual) VALUES (?,?,?,?,?)")
			.run(r.invoice_number || `INV-${++n}`, r.driver, r.week_start, r.deleted_at || "", r.is_manual || 0);
	}
	if (index === "full-binary") {
		// A fresh install straight off the bootstrap line.
		db.exec(`CREATE UNIQUE INDEX idx_invoices_driver_week ON invoices(driver, week_start)`);
	} else if (index === "partial-binary") {
		// origin/main's end state: partial, but BINARY. This is the one the old
		// /\bWHERE\b/ predicate calls "already migrated".
		db.exec(`CREATE UNIQUE INDEX idx_invoices_driver_week ON invoices(driver, week_start) WHERE deleted_at = '' AND is_manual = 0`);
	} else if (index === "none") { /* nothing */ }
	return db;
}

function indexSql(db, name) {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name);
	return row ? row.sql : null;
}
function indexNames(db) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_invoices_driver_week%' ORDER BY name").all().map(r => r.name);
}
// The property the whole exercise exists for: can a second LIVE weekly invoice
// be inserted for one driver-week under a different spelling?
function insertRefused(db, driver, week, opts = {}) {
	try {
		db.prepare("INSERT INTO invoices (invoice_number, driver, week_start, deleted_at, is_manual) VALUES (?,?,?,?,?)")
			.run(`INV-probe-${Math.random().toString(36).slice(2)}`, driver, week, opts.deleted_at || "", opts.is_manual || 0);
		return false;
	} catch { return true; }
}

// ---------------------------------------------------------------------------
// (c) THE PREDICATE — dead on arrival without the collation test.
// ---------------------------------------------------------------------------
{
	const db = scratch({ index: "partial-binary" });
	const before = indexSql(db, "idx_invoices_driver_week");
	check("origin/main's index is partial but BINARY", /WHERE/i.test(before) && !/NOCASE/i.test(before), true);
	// The historical predicate. If the shipped code still used it, the migration
	// would never fire on any already-upgraded database.
	check("the OLD /WHERE/ predicate calls it already-migrated (the DOA bug)", /\bWHERE\b/i.test(before), true);

	runMigration(db);
	const after = indexSql(db, "idx_invoices_driver_week");
	check("(c) migration fires on a partial BINARY index", /NOCASE/i.test(after), true);
	check("(c) and keeps the partial predicate", /WHERE/i.test(after), true);
	check("(c) predicate still scopes to live generated rows", /deleted_at\s*=\s*''\s*AND\s*is_manual\s*=\s*0/i.test(after), true);
	db.close();
}

// ---------------------------------------------------------------------------
// THE BEHAVIOUR — case-variant double billing is refused after, permitted before.
// ---------------------------------------------------------------------------
{
	const rows = [{ driver: "shorn king", week_start: "2026-05-09" }];
	const pre = scratch({ index: "partial-binary", rows });
	check("BEFORE: a case-variant second live invoice is INSERTABLE (the bug)",
		insertRefused(pre, "Shorn King", "2026-05-09"), false);
	pre.close();

	const post = scratch({ index: "partial-binary", rows });
	runMigration(post);
	check("AFTER: a case-variant second live invoice is REFUSED",
		insertRefused(post, "Shorn King", "2026-05-09"), true);
	check("AFTER: an exact-duplicate second live invoice is REFUSED",
		insertRefused(post, "shorn king", "2026-05-09"), true);
	// The partial predicate must survive: these are legal rows, not duplicates.
	check("AFTER: a SOFT-DELETED row for the same driver-week is still allowed",
		insertRefused(post, "SHORN KING", "2026-05-09", { deleted_at: "2026-06-01" }), false);
	check("AFTER: a MANUAL invoice for the same payee-week is still allowed",
		insertRefused(post, "Shorn King", "2026-05-09", { is_manual: 1 }), false);
	check("AFTER: a different week is still allowed",
		insertRefused(post, "Shorn King", "2026-05-16"), false);
	post.close();
}

// ---------------------------------------------------------------------------
// (a) COLLISION PRE-FLIGHT — abort loudly, leave the old index untouched.
// ---------------------------------------------------------------------------
{
	const db = scratch({ index: "partial-binary", rows: [
		{ invoice_number: "INV-SK-2026W19-01", driver: "Shorn King", week_start: "2026-05-09" },
		{ invoice_number: "INV-SK-2026W19-02", driver: "shorn king", week_start: "2026-05-09" },
	]});
	const before = indexSql(db, "idx_invoices_driver_week");
	const { logs, threw } = runMigration(db);
	const after = indexSql(db, "idx_invoices_driver_week");

	check("(a) collision: migration does not throw (boot must continue)", threw, null);
	check("(a) collision: the OLD index is byte-identical afterwards", after, before);
	check("(a) collision: no temp index is left behind", indexNames(db), ["idx_invoices_driver_week"]);
	check("(a) collision: the table is still protected against exact duplicates",
		insertRefused(db, "Shorn King", "2026-05-09"), true);

	const errs = logs.filter(([lvl]) => lvl === "error").map(([, m]) => m);
	check("(a) collision: exactly one error is logged", errs.length, 1);
	check("(a) collision: it says SKIPPED", /SKIPPED/.test(errs[0] || ""), true);
	check("(a) collision: it names the driver", /shorn king/i.test(errs[0] || ""), true);
	check("(a) collision: it names the week", /2026-05-09/.test(errs[0] || ""), true);
	check("(a) collision: it says the existing index is intact", /intact/i.test(errs[0] || ""), true);
	check("(a) collision: it refuses to auto-resolve", /business decision|Do NOT resolve/i.test(errs[0] || ""), true);
	db.close();
}

// A collision that is NOT a collision: both rows outside the index predicate.
// Blocking on these would refuse the upgrade forever on a database with any
// soft-deleted history — the commonest state there is.
{
	const db = scratch({ index: "partial-binary", rows: [
		{ driver: "Shorn King", week_start: "2026-05-09", deleted_at: "2026-06-01" },
		{ driver: "shorn king", week_start: "2026-05-09" },
		{ driver: "HOWARD REDDIE", week_start: "2026-05-09", is_manual: 1 },
		{ driver: "howard reddie", week_start: "2026-05-09" },
	]});
	runMigration(db);
	check("(a) scope: a soft-deleted / manual duplicate does NOT block the upgrade",
		/NOCASE/i.test(indexSql(db, "idx_invoices_driver_week") || ""), true);
	db.close();
}

// ---------------------------------------------------------------------------
// (b) CREATE-THEN-DROP — the table is never left unprotected.
//
// Simulated by mutating the extracted source to throw in the exact window the
// old code left open: after DROP INDEX, before the canonical CREATE succeeds.
// ---------------------------------------------------------------------------
{
	const crashAfterDrop = MIGRATION_SRC.replace(
		/db\.exec\(`CREATE UNIQUE INDEX \$\{INVOICE_WEEK_IDX\} ON \$\{INVOICE_WEEK_IDX_COLS\}`\);/,
		'throw new Error("simulated crash between DROP and CREATE");'
	);
	check("(b) the crash mutant patched the real statement",
		crashAfterDrop !== MIGRATION_SRC, true);

	const db = scratch({ index: "partial-binary", rows: [{ driver: "shorn king", week_start: "2026-05-09" }] });
	const { threw } = runMigration(db, crashAfterDrop);
	check("(b) the simulated crash is caught, boot continues", threw, null);
	check("(b) the canonical index is gone (that is the crash)", indexSql(db, "idx_invoices_driver_week"), null);
	check("(b) the TEMP index survives to hold the constraint",
		/NOCASE/i.test(indexSql(db, "idx_invoices_driver_week_migrating") || ""), true);
	// The whole point: even mid-crash, double billing is impossible.
	check("(b) a duplicate is STILL refused with the canonical index missing",
		insertRefused(db, "Shorn King", "2026-05-09"), true);

	// And a later boot completes the job rather than compounding it.
	runMigration(db);
	check("(b) a later boot finishes the migration",
		/NOCASE/i.test(indexSql(db, "idx_invoices_driver_week") || ""), true);
	check("(b) and cleans up the temp index", indexNames(db), ["idx_invoices_driver_week"]);
	db.close();
}

// ---------------------------------------------------------------------------
// IDEMPOTENCE + the fresh-install path.
// ---------------------------------------------------------------------------
{
	const db = scratch({ index: "full-binary" });
	runMigration(db);
	const first = indexSql(db, "idx_invoices_driver_week");
	check("fresh install: bootstrap index is upgraded to partial NOCASE",
		/NOCASE/i.test(first) && /WHERE/i.test(first), true);

	const { logs } = runMigration(db);
	check("idempotent: a second boot changes nothing", indexSql(db, "idx_invoices_driver_week"), first);
	check("idempotent: a second boot logs nothing", logs.length, 0);
	check("idempotent: no temp index accumulates", indexNames(db), ["idx_invoices_driver_week"]);
	db.close();
}

// ---------------------------------------------------------------------------
// (d) THE ORPHANED TEMP INDEX — the one state nothing ever revisited.
//
// Every step of the migration is resumable EXCEPT the last. If the final
// `DROP INDEX ..._migrating` is what fails — or the process dies between the
// canonical CREATE and that DROP — the canonical index is ALREADY current, so
// the next boot's `invoiceWeekIndexIsCurrent()` check is true, the whole block
// is skipped, and the temp index survives forever. The crash test above only
// covers a crash BEFORE the canonical index exists, which the next boot repairs;
// this is the half that repaired itself into a permanent leftover.
//
// Harmless in the sense that it duplicates a constraint already enforced — but
// permanent, and it costs a second index write on every invoice insert.
// ---------------------------------------------------------------------------
const ORPHAN_COLS = `invoices(driver COLLATE NOCASE, week_start) WHERE deleted_at = '' AND is_manual = 0`;
function orphanState() {
	const db = scratch({ index: "none", rows: [{ driver: "shorn king", week_start: "2026-05-09" }] });
	// The exact end state of a run that did everything except its final DROP.
	db.exec(`CREATE UNIQUE INDEX idx_invoices_driver_week ON ${ORPHAN_COLS}`);
	db.exec(`CREATE UNIQUE INDEX idx_invoices_driver_week_migrating ON ${ORPHAN_COLS}`);
	return db;
}

{
	const db = orphanState();
	check("(d) setup: canonical is already current, temp is left over",
		indexNames(db), ["idx_invoices_driver_week", "idx_invoices_driver_week_migrating"]);

	const { threw, logs } = runMigration(db);
	check("(d) the sweep does not throw", threw, null);
	check("(d) the orphaned temp index is dropped", indexNames(db), ["idx_invoices_driver_week"]);
	check("(d) the canonical index is untouched",
		/NOCASE/i.test(indexSql(db, "idx_invoices_driver_week") || ""), true);
	// The sweep must not weaken anything on its way past.
	check("(d) the constraint still holds afterwards",
		insertRefused(db, "Shorn King", "2026-05-09"), true);
	check("(d) it is silent — a cleanup is not a migration", logs.length, 0);

	const second = runMigration(db);
	check("(d) a second boot is a no-op", indexNames(db), ["idx_invoices_driver_week"]);
	check("(d) and stays silent", second.logs.length, 0);
	db.close();
}

// MUTANT — the shipped code had no `else`, so the orphan was permanent.
{
	const elseAt = MIGRATION_SRC.indexOf("\n\t} else {\n");
	const catchAt = MIGRATION_SRC.indexOf("\n} catch (err) {", elseAt);
	check("(d) the no-sweep mutant found the else branch to remove",
		elseAt > 0 && catchAt > elseAt, true);
	const noSweep = MIGRATION_SRC.slice(0, elseAt) + "\n\t}" + MIGRATION_SRC.slice(catchAt);
	// ⚠️ Count the DROP, don't grep for `} else {` — the clashes pre-flight has an
	// `else` of its own (at two tabs), so a bare test for "no else" is false here
	// even on a correctly mutated source and would silently pass a no-op mutant.
	const drops = (s) => s.split("DROP INDEX IF EXISTS ${INVOICE_WEEK_IDX_TMP}").length - 1;
	check("(d) the mutant removed exactly the sweep, leaving the in-migration DROP",
		[drops(MIGRATION_SRC), drops(noSweep)], [2, 1]);
	check("(d) the one-tab else branch is gone",
		noSweep.includes("\n\t} else {\n"), false);

	const db = orphanState();
	const { threw } = runMigration(db, noSweep);
	check("(d) mutant still boots cleanly — the leak is silent, which is the problem", threw, null);
	check("(d) MUTANT REJECTED — without the sweep the temp index is permanent",
		indexNames(db), ["idx_invoices_driver_week", "idx_invoices_driver_week_migrating"]);
	db.close();
}

{
	// Index missing entirely (a database that lost it to the old two-statement
	// failure). The migration must rebuild rather than assume.
	const db = scratch({ index: "none" });
	check("recovery: the table starts unprotected", indexNames(db), []);
	runMigration(db);
	check("recovery: the migration rebuilds the constraint",
		/NOCASE/i.test(indexSql(db, "idx_invoices_driver_week") || ""), true);
	db.close();
}

// ---------------------------------------------------------------------------
// MUTANTS — proof this suite fails against the pre-fix code.
// ---------------------------------------------------------------------------
function mutantRejected(label, mutate, probe) {
	let rejected = false;
	try { rejected = probe(mutate(MIGRATION_SRC)); } catch { rejected = true; }
	check(`mutant rejected — ${label}`, rejected, true);
}

// M1: origin/main's predicate. Migration never fires on an upgraded database.
mutantRejected("M1 predicate tests only /WHERE/ (dead on arrival)",
	s => s.replace(/return \/\\bWHERE\\b\/i\.test\(sql\) && \/\\bNOCASE\\b\/i\.test\(sql\);/, "return /\\bWHERE\\b/i.test(sql);"),
	src => {
		const db = scratch({ index: "partial-binary" });
		runMigration(db, src);
		const stillBinary = !/NOCASE/i.test(indexSql(db, "idx_invoices_driver_week") || "");
		db.close();
		return stillBinary;   // rejected because the collation never lands
	});

// M2: origin/main's ordering. Drop first, no temp — the unprotected window.
mutantRejected("M2 DROP before CREATE with no temp index (unprotected window)",
	s => s
		.replace(/db\.exec\(`CREATE UNIQUE INDEX IF NOT EXISTS \$\{INVOICE_WEEK_IDX_TMP\} ON \$\{INVOICE_WEEK_IDX_COLS\}`\);/, "")
		.replace(/if \(!invoiceWeekIndexIsCurrent\(INVOICE_WEEK_IDX_TMP\)\) \{[\s\S]*?\n\t\t\t\}/, "")
		.replace(/db\.exec\(`CREATE UNIQUE INDEX \$\{INVOICE_WEEK_IDX\} ON \$\{INVOICE_WEEK_IDX_COLS\}`\);/, 'throw new Error("simulated crash between DROP and CREATE");'),
	src => {
		const db = scratch({ index: "partial-binary", rows: [{ driver: "shorn king", week_start: "2026-05-09" }] });
		runMigration(db, src);
		const unprotected = !insertRefused(db, "shorn king", "2026-05-09");
		db.close();
		return unprotected;   // rejected because an EXACT duplicate now inserts
	});

// M3: pre-flight ignoring the index predicate. Refuses the upgrade forever on
// any database carrying soft-deleted or manual history.
mutantRejected("M3 pre-flight not scoped to the index predicate (false abort)",
	s => s.replace(/WHERE deleted_at = '' AND is_manual = 0\n\t\t\tGROUP BY/, "GROUP BY"),
	src => {
		const db = scratch({ index: "partial-binary", rows: [
			{ driver: "Shorn King", week_start: "2026-05-09", deleted_at: "2026-06-01" },
			{ driver: "shorn king", week_start: "2026-05-09" },
		]});
		runMigration(db, src);
		const refused = !/NOCASE/i.test(indexSql(db, "idx_invoices_driver_week") || "");
		db.close();
		return refused;   // rejected because a legal pair blocked the upgrade
	});

// M4: pre-flight that "resolves" collisions instead of aborting. The old index
// must never be dropped while duplicates exist.
mutantRejected("M4 collision path drops the old index anyway",
	s => s.replace(
		/console\.error\(\s*\n?\s*`invoices unique-index migration SKIPPED/,
		'db.exec(`DROP INDEX IF EXISTS ${INVOICE_WEEK_IDX}`); console.error(\n\t\t\t\t`invoices unique-index migration SKIPPED'
	),
	src => {
		const db = scratch({ index: "partial-binary", rows: [
			{ driver: "Shorn King", week_start: "2026-05-09" },
			{ driver: "shorn king", week_start: "2026-05-09" },
		]});
		runMigration(db, src);
		const lost = indexSql(db, "idx_invoices_driver_week") === null;
		db.close();
		return lost;   // rejected because the constraint vanished
	});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
