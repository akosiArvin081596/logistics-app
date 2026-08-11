#!/usr/bin/env node
// Locks DELETE /api/users/:id — the FK-bearing children, the signed-evidence
// archive, the detaches, and the invoices blocker.
//
// THE BUG, and it is not the one it looks like. `db.pragma("foreign_keys = ON")`
// plus three FOREIGN KEYs on users(id) — driver_onboarding, onboarding_documents
// and driver_payment_info, the ONLY three in the schema — meant
// `DELETE FROM users` raised `FOREIGN KEY constraint failed` for anybody who had
// ever been onboarded. The whole cascade rolled back and the route answered a
// 500 `DELETE_ROLLED_BACK` naming no cause. So the observable defect was never
// orphaned rows: ONBOARDED DRIVERS WERE SIMPLY UNDELETABLE, silently, and the
// error blamed the app rather than the data.
//
// ⚠️ A test that only asserted "the delete succeeds" would pass on a fix that
// unlinked the signed W-9s and contractor agreements. `onboarding_documents.signed
// = 1` is described a few lines from its own CREATE as "a legal assertion —
// this person signed this contract, and we hold the document", and
// guardDriverSignedDoc() resolves authority from the ROW, so a deleted row means
// the file can never be read by anyone again. Every signed artifact is therefore
// COPIED into evidence-archive/signed-artifacts/ first, and the ORIGINAL IS NOT
// UNLINKED — both halves are asserted below, because either one alone is the
// wrong outcome.
//
// The cascade body and every helper are EXTRACTED from server.js and executed
// against scratch databases with `foreign_keys = ON`, so this exercises the SQL
// that actually runs. The pre-fix cascade is reconstructed by deleting the three
// child statements and is required to fail with a FOREIGN KEY error — that is
// the assertion that fails against origin/main.
//
// No network, no app.db, no server. Files are written only under a fresh
// mkdtemp.
//
//   node scripts/test-user-delete-cascade.js      # exits 1 on any failure

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
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
// Terminates on a `}` in COLUMN 0. A brace counter cannot be used here: these
// functions contain `${…}` template placeholders and `"{"` string literals, both
// of which it would read as real blocks.
function extract(name) {
	const needle = `\nfunction ${name}(`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", start);
	if (end < 0) throw new Error(`could not find the top-level end of ${name}()`);
	const body = SRC.slice(start, end + 3);
	if (body.split("\nfunction ").length - 1 !== 0) throw new Error(`extraction of ${name}() spanned more than one declaration`);
	return body;
}

// The cascade body, verbatim, out of the route handler.
// Anchored on `DELETE FROM users WHERE id = ?` — the one statement that is
// unique in the file — then walked back to the transaction that encloses it.
// `db.transaction(() => {` appears three times; picking the first would extract
// somebody else's cascade and silently test nothing.
function extractCascade() {
	const marker = 'DELETE FROM users WHERE id = ?';
	const markerHits = SRC.split(marker).length - 1;
	if (markerHits !== 1) throw new Error(`expected exactly 1 '${marker}' in server.js, found ${markerHits}`);
	const at = SRC.indexOf(marker);
	const open = SRC.lastIndexOf("db.transaction(() => {\n", at);
	if (open < 0) throw new Error("the user delete is not inside a db.transaction()");
	const start = open + "db.transaction(() => {\n".length;
	const end = SRC.indexOf("\n\t\t})();", start);
	if (end < 0 || end < at) throw new Error("could not find the end of the delete-user transaction");
	return SRC.slice(start, end);
}
const CASCADE = extractCascade();
check("cascade extraction found the three FK-bearing children", [
	/DELETE FROM onboarding_documents WHERE user_id = \?/.test(CASCADE),
	/DELETE FROM driver_onboarding WHERE user_id = \?/.test(CASCADE),
	/DELETE FROM driver_payment_info WHERE user_id = \?/.test(CASCADE),
], [true, true, true]);

function runCascade(db, user, name, id, body = CASCADE) {
	const removed = {}, detached = {};
	const fn = new Function("db", "user", "name", "id", "removed", "detached", body);
	let threw = null;
	try { db.transaction(() => fn(db, user, name, id, removed, detached))(); }
	catch (err) { threw = err.message; }
	return { removed, detached, threw };
}

// ---------------------------------------------------------------- scratch DB
// The real schema for every table the cascade touches, including the three
// FOREIGN KEY declarations verbatim — they are the whole point.
function scratch() {
	const db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, driver_name TEXT DEFAULT '', full_name TEXT DEFAULT '', role TEXT);
		CREATE TABLE driver_onboarding (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, application_id INTEGER NOT NULL,
			driver_name TEXT NOT NULL, status TEXT DEFAULT 'documents_pending',
			FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE onboarding_documents (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, doc_key TEXT NOT NULL, doc_name TEXT NOT NULL,
			signed INTEGER DEFAULT 0, signed_pdf_url TEXT DEFAULT '', UNIQUE(user_id, doc_key),
			FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE driver_payment_info (
			id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE,
			bank_routing TEXT DEFAULT '', bank_account TEXT DEFAULT '',
			FOREIGN KEY (user_id) REFERENCES users(id)
		);
		CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT, amount REAL DEFAULT 0, date TEXT DEFAULT '');
		CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, "from" TEXT, "to" TEXT);
		CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT);
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT);
		CREATE TABLE load_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT);
		CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT);
		CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT, assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0);
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER NOT NULL, driver_name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT DEFAULT '');
		CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT DEFAULT '', carrier_name TEXT DEFAULT '');
		CREATE TABLE investor_config (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER);
		CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT, driver TEXT, week_start TEXT, week_end TEXT, paid_at TEXT DEFAULT '', deleted_at TEXT DEFAULT '');
	`);
	return db;
}

// An onboarded driver: an account plus a row in each of the three FK children.
function seedOnboardedDriver(db) {
	db.prepare("INSERT INTO users (id, username, driver_name, full_name, role) VALUES (7,'sking','Shorn King','Shorn King','Driver')").run();
	db.prepare("INSERT INTO driver_onboarding (user_id, application_id, driver_name) VALUES (7, 3, 'Shorn King')").run();
	db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signed_pdf_url) VALUES (7,'w9','W-9 Tax Form',1,'/uploads/onboarding-signed/w9-7-signed.pdf')").run();
	db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signed_pdf_url) VALUES (7,'contractor_agreement','Contractor Agreement',1,'/uploads/onboarding-signed/contractor_agreement-7-signed.pdf')").run();
	db.prepare("INSERT INTO driver_payment_info (user_id, bank_routing, bank_account) VALUES (7,'000000000','000000000')").run();
	db.prepare("INSERT INTO expenses (driver, amount, date) VALUES ('shorn king', 120.50, '2026-08-02')").run();
	db.prepare("INSERT INTO trucks (id, unit_number, assigned_driver) VALUES (1,'LogisX-#33','Shorn King')").run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (1,'Shorn King','2026-01-02','')").run();
	db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (1,'Shorn King','2025-06-01','2026-01-01')").run();
	return { id: 7, username: "sking", driver_name: "Shorn King", role: "Driver" };
}

// ---------------------------------------------------------------------------
// THE BUG — an onboarded driver was undeletable, and the fix makes them
// deletable without destroying anything that matters.
// ---------------------------------------------------------------------------
{
	// PRE-FIX: the same cascade with the three child DELETEs removed.
	const preFix = CASCADE
		.replace(/removed\.onboarding_documents = [^\n]*\n/, "")
		.replace(/removed\.driver_onboarding = [^\n]*\n/, "")
		.replace(/removed\.driver_payment_info = [^\n]*\n/, "");
	check("pre-fix mutant actually removed the three statements",
		[/onboarding_documents WHERE user_id/.test(preFix), /driver_onboarding WHERE user_id/.test(preFix), /driver_payment_info WHERE user_id/.test(preFix)],
		[false, false, false]);

	const db = scratch();
	const user = seedOnboardedDriver(db);
	const pre = runCascade(db, user, "shorn king", 7, preFix);
	check("PRE-FIX: the delete raises FOREIGN KEY constraint failed",
		/FOREIGN KEY constraint failed/i.test(pre.threw || ""), true);
	check("PRE-FIX: the account survives (rolled back, undeletable)",
		db.prepare("SELECT COUNT(*) AS c FROM users WHERE id = 7").get().c, 1);
	check("PRE-FIX: nothing else was removed either — the whole cascade rolled back",
		db.prepare("SELECT COUNT(*) AS c FROM expenses").get().c, 1);
	db.close();
}
{
	const db = scratch();
	const user = seedOnboardedDriver(db);
	const { removed, detached, threw } = runCascade(db, user, "shorn king", 7);
	check("FIXED: the cascade completes", threw, null);
	check("FIXED: the account is gone", db.prepare("SELECT COUNT(*) AS c FROM users WHERE id = 7").get().c, 0);
	check("FIXED: driver_onboarding removed", removed.driver_onboarding, 1);
	check("FIXED: onboarding_documents removed", removed.onboarding_documents, 2);
	check("FIXED: driver_payment_info removed (bank routing/account leaves with the account)", removed.driver_payment_info, 1);
	check("FIXED: no bank details remain", db.prepare("SELECT COUNT(*) AS c FROM driver_payment_info").get().c, 0);
	check("FIXED: expenses still cascade as before", removed.expenses, 1);
	check("FIXED: trucks.assigned_driver still cleared", removed.trucks_unassigned, 1);

	// DETACH, not delete.
	check("DETACH: the OPEN truck_assignments row is closed, not deleted", detached.truck_assignments_closed, 1);
	check("DETACH: both assignment rows survive (history preserved)",
		db.prepare("SELECT COUNT(*) AS c FROM truck_assignments").get().c, 2);
	check("DETACH: no assignment is left open",
		db.prepare("SELECT COUNT(*) AS c FROM truck_assignments WHERE end_date = ''").get().c, 0);
	check("DETACH: the historical row's end_date is untouched",
		db.prepare("SELECT end_date FROM truck_assignments WHERE start_date = '2025-06-01'").get().end_date, "2026-01-01");
	db.close();
}
{
	// The investor branch: the record survives, the dangling pointer does not.
	const db = scratch();
	db.prepare("INSERT INTO users (id, username, driver_name, role) VALUES (5,'johnny','','Investor')").run();
	db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (5,'Johnny Rocks','Johnny Rocks Spirits LLC')").run();
	db.prepare("INSERT INTO investor_config (owner_id) VALUES (5)").run();
	db.prepare("INSERT INTO trucks (id, unit_number, owner_id) VALUES (2,'LogisX-#302',5)").run();
	const { removed, detached, threw } = runCascade(db, { id: 5, username: "johnny", role: "Investor" }, "johnny", 5);
	check("investor: cascade completes", threw, null);
	check("investor: trucks reparented to owner 0", removed.trucks_reparented, 1);
	check("investor: investor_config removed", removed.investor_config, 1);
	check("investor: the investors RECORD survives", db.prepare("SELECT COUNT(*) AS c FROM investors").get().c, 1);
	check("investor: its dangling user_id is NULLed, not left pointing at a dead id", detached.investors_unlinked, 1);
	check("investor: user_id really is NULL", db.prepare("SELECT user_id FROM investors").get().user_id, null);
	check("investor: the carrier name is intact", db.prepare("SELECT carrier_name FROM investors").get().carrier_name, "Johnny Rocks Spirits LLC");
	db.close();
}
{
	// A user who was never onboarded must behave exactly as before — the three
	// new DELETEs are no-ops, not a behaviour change.
	const db = scratch();
	db.prepare("INSERT INTO users (id, username, driver_name, role) VALUES (9,'amir','Amir Serrano','Dispatcher')").run();
	const { removed, threw } = runCascade(db, { id: 9, username: "amir", driver_name: "Amir Serrano", role: "Dispatcher" }, "amir serrano", 9);
	check("never-onboarded: cascade completes", threw, null);
	check("never-onboarded: the three child deletes are no-ops",
		[removed.onboarding_documents, removed.driver_onboarding, removed.driver_payment_info], [0, 0, 0]);
	db.close();
}

// ---------------------------------------------------------------------------
// THE SIGNED EVIDENCE — archived, and the original NOT unlinked.
// ---------------------------------------------------------------------------
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "user-delete-archive-"));
	const signedDir = path.join(root, "uploads", "onboarding-signed");
	fs.mkdirSync(signedDir, { recursive: true });
	const archiveDir = path.join(root, "evidence-archive", "signed-artifacts");

	// A plausible signed PDF: the magic prefix plus enough bytes to clear the
	// artifact floor, so signedArtifactLooksValid() accepts it.
	const realPdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0x20), Buffer.from("\n%%EOF\n")]);
	fs.writeFileSync(path.join(signedDir, "w9-7-signed.pdf"), realPdf);
	fs.writeFileSync(path.join(signedDir, "contractor_agreement-7-signed.pdf"), realPdf);
	// A stub that never passed the artifact tests — evidence of nothing.
	fs.writeFileSync(path.join(signedDir, "mobile_policy-7-signed.pdf"), Buffer.from("%PDF-1.7\n"));

	const minBytes = (SRC.match(/const SIGNED_ARTIFACT_MIN_BYTES = (\d+)/) || [])[1];
	if (!minBytes) throw new Error("SIGNED_ARTIFACT_MIN_BYTES not found in server.js");

	const A = new Function(
		"__dirname", "fs", "path", "crypto", "db", "SIGNED_ARTIFACT_MIN_BYTES",
		`const SIGNED_ARCHIVE_DIR = path.join(__dirname, "evidence-archive", "signed-artifacts");
		 ${extract("sha256File")}
		 ${extract("signedArtifactLooksValid")}
		 ${extract("archiveSignedArtifact")}
		 ${extract("archiveUserSignedArtifacts")}
		 return { archiveUserSignedArtifacts, archiveSignedArtifact };`
	);

	const db = scratch();
	seedOnboardedDriver(db);
	db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signed_pdf_url) VALUES (7,'mobile_policy','Mobile Policy',1,'/uploads/onboarding-signed/mobile_policy-7-signed.pdf')").run();
	db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signed_pdf_url) VALUES (7,'substance_policy','Substance Policy',1,'/uploads/onboarding-signed/gone-7-signed.pdf')").run();
	db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, doc_name, signed, signed_pdf_url) VALUES (7,'equipment_policy','Equipment Policy',0,'')").run();

	const M = A(root, fs, path, crypto, db, Number(minBytes));
	const archived = M.archiveUserSignedArtifacts(7);

	check("archive: both real signed artifacts are archived", archived.length, 2);
	check("archive: the archive lives OUTSIDE uploads/, where express.static cannot reach",
		fs.existsSync(archiveDir), true);
	for (const rec of archived) {
		check(`archive: ${rec.docKey} landed in evidence-archive`, fs.existsSync(path.join(archiveDir, rec.file)), true);
		check(`archive: ${rec.docKey} copy is byte-identical`,
			fs.readFileSync(path.join(archiveDir, rec.file)).equals(realPdf), true);
		check(`archive: ${rec.docKey} record carries a sha256`, /^[0-9a-f]{64}$/.test(rec.sha256 || ""), true);
		check(`archive: ${rec.docKey} record carries the byte count`, rec.bytes, realPdf.length);
	}
	// ⚠️ The instruction is ARCHIVE, not move. Both files must still be there.
	check("archive: the ORIGINAL w9 is NOT unlinked", fs.existsSync(path.join(signedDir, "w9-7-signed.pdf")), true);
	check("archive: the ORIGINAL contractor agreement is NOT unlinked",
		fs.existsSync(path.join(signedDir, "contractor_agreement-7-signed.pdf")), true);
	check("archive: a sub-minimum stub is skipped — a broken file is not evidence",
		archived.some((a) => a.docKey === "mobile_policy"), false);
	check("archive: a row whose file is missing is skipped, not fatal",
		archived.some((a) => a.docKey === "substance_policy"), false);
	check("archive: an unsigned row is never considered",
		archived.some((a) => a.docKey === "equipment_policy"), false);

	// Path safety: the row supplies a filename, never a directory.
	fs.writeFileSync(path.join(root, "outside.pdf"), realPdf);
	db.prepare("UPDATE onboarding_documents SET signed_pdf_url = '../../outside.pdf' WHERE doc_key = 'equipment_policy'").run();
	db.prepare("UPDATE onboarding_documents SET signed = 1 WHERE doc_key = 'equipment_policy'").run();
	const after = M.archiveUserSignedArtifacts(7);
	check("archive: a traversal in signed_pdf_url cannot escape the signed directory",
		after.some((a) => a.docKey === "equipment_policy"), false);

	db.close();
	fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// THE INVOICES BLOCKER — the leg the guard used to miss.
// ---------------------------------------------------------------------------
{
	let LOCKED = new Set();
	const G = new Function(
		"db", "isLocked", "periodLocksReadable", "expenseRowPeriodLocked", "blockedExpensePeriods", "truckFixedCostLockedMonths",
		`${extract("invoiceRowPeriodLocked")}
		 ${extract("namedLockedPeriods")}
		 ${extract("userDeleteLockBlockers")}
		 return { userDeleteLockBlockers };`
	);
	const build = (db) => G(
		db,
		(p) => LOCKED.has(p),
		() => true,
		() => false,              // the expenses leg has its own suite
		() => [],
		() => [],                 // the trucks leg likewise
	);

	const mkdb = () => {
		const db = new Database(":memory:");
		db.exec(`
			CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT, date TEXT, posted_period TEXT, created_at TEXT);
			CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY, owner_id INTEGER, period TEXT, status TEXT, paid_at TEXT, finalized_at TEXT);
			CREATE TABLE period_locks (period TEXT, status TEXT);
			CREATE TABLE trucks (id INTEGER PRIMARY KEY, unit_number TEXT, owner_id INTEGER, in_service_date TEXT DEFAULT '', retired_at TEXT DEFAULT '', created_at TEXT DEFAULT '');
			CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT, driver TEXT, week_start TEXT, week_end TEXT, paid_at TEXT DEFAULT '', deleted_at TEXT DEFAULT '');
		`);
		return db;
	};
	const inv = (db, o) => db.prepare(
		"INSERT INTO invoices (invoice_number, driver, week_start, week_end, paid_at, deleted_at) VALUES (?,?,?,?,?,?)"
	).run(o.n, o.driver, o.ws, o.we, o.paid || "", o.del || "");
	const blockersFor = (db) => build(db).userDeleteLockBlockers({ id: 7 }, "shorn king").blockers.filter((b) => b.table === "invoices");

	{
		LOCKED = new Set(["2026-05"]);
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W19-01", driver: "shorn king", ws: "2026-05-09", we: "2026-05-15" });
		const b = blockersFor(db);
		check("invoices: a locked-month invoice blocks the delete", b.length, 1);
		check("invoices: it names the finalized month", b[0].periods, ["2026-05"]);
		db.close();
	}
	{
		LOCKED = new Set();
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W31-01", driver: "shorn king", ws: "2026-08-01", we: "2026-08-07", paid: "2026-08-09" });
		const b = blockersFor(db);
		// ⚠️ A PAID invoice in an OPEN month has no locked period to name. Folding
		// it into the finalized list would send an admin to reopen a month that is
		// already open — the mislabel namedLockedPeriods() exists to prevent.
		check("invoices: a PAID invoice in an open month still blocks", b.length, 1);
		check("invoices: it names NO period", b[0].periods, []);
		check("invoices: it is reported as paid, so the remedy is 'none'", b[0].paidRows, 1);
		check("invoices: the message says PAID", /PAID/.test(b[0].detail), true);
		db.close();
	}
	{
		LOCKED = new Set(["2026-05"]);
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W19-01", driver: "Shorn King", ws: "2026-05-09", we: "2026-05-15" });
		check("invoices: the probe folds case, matching the cascade's LOWER(driver)", blockersFor(db).length, 1);
		db.close();
	}
	{
		LOCKED = new Set(["2026-05"]);
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W19-01", driver: "shorn king", ws: "2026-05-09", we: "2026-05-15", del: "2026-06-01" });
		check("invoices: a SOFT-DELETED invoice does not block — it is already out of every list",
			blockersFor(db).length, 0);
		db.close();
	}
	{
		LOCKED = new Set(["2026-05"]);
		const db = mkdb();
		inv(db, { n: "INV-HR-2026W19-01", driver: "howard reddie", ws: "2026-05-09", we: "2026-05-15" });
		check("invoices: another driver's locked invoice does not block this delete",
			blockersFor(db).length, 0);
		db.close();
	}
	{
		LOCKED = new Set();
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W31-01", driver: "shorn king", ws: "2026-08-01", we: "2026-08-07" });
		check("invoices: a live invoice in an OPEN month does not block", blockersFor(db).length, 0);
		db.close();
	}
	{
		LOCKED = new Set();
		const db = mkdb();
		inv(db, { n: "INV-SK-BAD", driver: "shorn king", ws: "not-a-date", we: "" });
		const b = blockersFor(db);
		check("invoices: an unresolvable billing week blocks (fails closed)", b.length, 1);
		check("invoices: and is labelled unresolvable, not finalized",
			/cannot resolve to a month/.test(b[0].detail), true);
		db.close();
	}
	{
		// The whole guard must still be absent when there is nothing to block on.
		LOCKED = new Set();
		const db = mkdb();
		check("invoices: no invoices, no blocker", blockersFor(db).length, 0);
		db.close();
	}

	// MUTANT — the pre-fix guard had no invoices leg at all.
	const noInvoiceLeg = extract("userDeleteLockBlockers").replace(/\/\/ \(4\) invoices[\s\S]*?\n\t\}\n\n\treturn \{ unreadable: false/, "\treturn { unreadable: false");
	check("mutant patched the invoices leg out", /\(4\) invoices/.test(noInvoiceLeg), false);
	{
		LOCKED = new Set(["2026-05"]);
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W19-01", driver: "shorn king", ws: "2026-05-09", we: "2026-05-15", paid: "2026-05-20" });
		const M = new Function(
			"db", "isLocked", "periodLocksReadable", "expenseRowPeriodLocked", "blockedExpensePeriods", "truckFixedCostLockedMonths",
			`${extract("invoiceRowPeriodLocked")}\n${extract("namedLockedPeriods")}\n${noInvoiceLeg}\nreturn { userDeleteLockBlockers };`
		)(db, (p) => LOCKED.has(p), () => true, () => false, () => [], () => []);
		check("mutant rejected — pre-fix guard lets a PAID locked-month invoice through",
			M.userDeleteLockBlockers({ id: 7 }, "shorn king").blockers.length, 0);
		db.close();
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
