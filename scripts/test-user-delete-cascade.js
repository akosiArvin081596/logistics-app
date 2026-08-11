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
	// ⚠️ `{ archived, skipped }`, and `archived` must still mean exactly what it
	// meant before the skip report existed — nothing moved between the two lists.
	// Every assertion below this line is unchanged for that reason.
	const archiveResult = M.archiveUserSignedArtifacts(7);
	// ⚠️ SHAPE FIRST, and the `= []` defaults below are what make it useful. A
	// build that still returns a bare array destructures to two `undefined`s, and
	// the next `archived.length` would be a TypeError — a stack trace that aborts
	// the run and names nothing. With the defaults, source without the skip report
	// fails as a row of NAMED assertions instead.
	check("skip report: the archiver returns { archived, skipped }, not a bare array",
		Array.isArray(archiveResult && archiveResult.archived) && Array.isArray(archiveResult && archiveResult.skipped), true);
	const { archived = [], skipped = [] } = archiveResult;

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

	// -----------------------------------------------------------------------
	// THE SKIP IS REPORTED — a silent skip and a lost document look identical.
	// -----------------------------------------------------------------------
	// ⚠️ These assert REPORTING, never refusal. A skip must not become a 503:
	// a row pointing at a file that was never written is exactly what made
	// onboarded drivers undeletable, and that is the bug this cascade fixes.
	// So `archived` is asserted unchanged above, and `skipped` is additive.
	const skippedKeys = skipped.map((s) => s.docKey).sort().join(",");
	check("skip report: both non-archivable rows are named — the stub and the missing file",
		skippedKeys, "mobile_policy,substance_policy");
	check("skip report: a row that DID archive never appears in it",
		skipped.some((s) => s.docKey === "w9" || s.docKey === "contractor_agreement"), false);
	check("skip report: an unsigned row is not a skip — it was never a claim",
		skipped.some((s) => s.docKey === "equipment_policy"), false);
	check("skip report: every entry carries the url the row asserted",
		skipped.every((s) => typeof s.url === "string" && s.url.length > 0), true);
	check("skip report: every entry carries the reason",
		skipped.every((s) => s.reason === "no-valid-artifact"), true);
	// The invariant that makes this safe to ship: reporting moved nothing.
	check("skip report: archived + skipped accounts for every signed row with a url",
		archived.length + skipped.length,
		db.prepare("SELECT COUNT(*) AS c FROM onboarding_documents WHERE user_id = 7 AND signed = 1 AND COALESCE(signed_pdf_url,'') <> ''").get().c);

	// Path safety: the row supplies a filename, never a directory.
	fs.writeFileSync(path.join(root, "outside.pdf"), realPdf);
	db.prepare("UPDATE onboarding_documents SET signed_pdf_url = '../../outside.pdf' WHERE doc_key = 'equipment_policy'").run();
	db.prepare("UPDATE onboarding_documents SET signed = 1 WHERE doc_key = 'equipment_policy'").run();
	const { archived: after = [], skipped: afterSkipped = [] } = M.archiveUserSignedArtifacts(7);
	check("archive: a traversal in signed_pdf_url cannot escape the signed directory",
		after.some((a) => a.docKey === "equipment_policy"), false);
	// ...and the refusal is VISIBLE. A traversal attempt that vanished silently is
	// the one skip an operator most needs to see.
	check("skip report: the traversal row is reported as skipped, not swallowed",
		afterSkipped.some((s) => s.docKey === "equipment_policy"), true);

	// A row whose stored url has no usable basename at all ("..") — the branch
	// that `continue`d with no record before this change.
	db.prepare("UPDATE onboarding_documents SET signed_pdf_url = '..' WHERE doc_key = 'equipment_policy'").run();
	const { skipped: dotdot = [] } = M.archiveUserSignedArtifacts(7);
	check("skip report: an unusable basename is reported, not silently skipped",
		dotdot.some((s) => s.docKey === "equipment_policy" && s.reason === "no-valid-artifact"), true);

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

// ---------------------------------------------------------------------------
// THE 409 BODY — what the admin is actually told.
//
// The blocker set being right is only half of it: the refusal that reaches the
// screen is assembled in the route, and TWO defects lived there while every
// blocker assertion above passed.
//
//   (1) namedLockedPeriods() emits "(unrecognized date)" where its sibling
//       blockedExpensePeriods() emits "(unknown)", and the message builder
//       filters only "(unknown)". So the unresolvable bucket's sentinel
//       survived, was run through periodLabel() and PRINTED AS A CLOSED MONTH,
//       while `unresolved` stayed false so the sentence explaining it never
//       fired. The remedy then named a period that does not exist.
//
//   (2) `code` was hardcoded PERIOD_FINALIZED. A block coming only from a PAID
//       invoice — which invoiceRowPeriodLocked() freezes INDEPENDENTLY of any
//       lock, so it can sit in a wide-open month — was therefore reported as a
//       period problem, with an EMPTY periods array and a remedy about
//       investor payouts.
//
// These assert the RESPONSE, extracted verbatim from the handler, not a
// reimplementation of it.
// ---------------------------------------------------------------------------
function extractDeleteRefusal() {
	const marker = "Cannot delete ${who}:";
	const hits = SRC.split(marker).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 '${marker}' in server.js, found ${hits}`);
	const at = SRC.indexOf(marker);
	// `^\tif (lock.blockers.length) {` is NOT unique in the file (the investor
	// -application delete carries one too), so anchor on the unique error string
	// and walk back — never the other way round.
	const open = SRC.lastIndexOf("\n\tif (lock.blockers.length) {\n", at);
	if (open < 0) throw new Error("the delete refusal is not inside `if (lock.blockers.length)`");
	const end = SRC.indexOf("\n\t}\n", at);
	if (end < 0) throw new Error("could not find the end of the delete refusal block");
	const body = SRC.slice(open + 1, end + 3);
	if (!body.includes(marker)) throw new Error("extracted the wrong refusal block");
	return body;
}
const REFUSAL = extractDeleteRefusal();
check("refusal extraction picked up the 409 and its code selection", [
	/res\.status\(409\)/.test(REFUSAL),
	/lock\.blockers\[0\]\.code/.test(REFUSAL),
], [true, true]);

{
	let LOCKED = new Set();
	const isLocked = (p) => LOCKED.has(p);

	// The guard, with the REAL expenses/trucks legs stubbed out (they have their
	// own suites) — same wiring as the invoices section above.
	const G = new Function(
		"db", "isLocked", "periodLocksReadable", "expenseRowPeriodLocked", "blockedExpensePeriods", "truckFixedCostLockedMonths",
		`${extract("invoiceRowPeriodLocked")}
		 ${extract("namedLockedPeriods")}
		 ${extract("userDeleteLockBlockers")}
		 return { userDeleteLockBlockers };`
	);
	const guardFor = (db, src) => new Function(
		"db", "isLocked", "periodLocksReadable", "expenseRowPeriodLocked", "blockedExpensePeriods", "truckFixedCostLockedMonths",
		`${extract("invoiceRowPeriodLocked")}
		 ${extract("namedLockedPeriods")}
		 ${src || extract("userDeleteLockBlockers")}
		 return { userDeleteLockBlockers };`
	)(db, isLocked, () => true, () => false, () => [], () => []);

	// The refusal, verbatim. `periodLabel` is the REAL one — it is what turned the
	// leaked sentinel into a printed month, so stubbing it would hide the defect.
	const refuse = (lock, src) => {
		let captured = null;
		const res = { status: () => ({ json: (b) => { captured = b; return b; } }) };
		new Function("lock", "user", "id", "res", "periodLabel",
			`${extract("periodLabel")}\n${src || REFUSAL}`
		)(lock, { driver_name: "shorn king", username: "sking" }, 7, res, null);
		return captured;
	};

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
	const lockFor = (db, src) => guardFor(db, src).userDeleteLockBlockers({ id: 7 }, "shorn king");

	// A month is `YYYY-MM`. Anything else in `periods` is fabricated, whatever it
	// says — this is the invariant both defects broke.
	const MONTHISH = /^\d{4}-\d{2}$/;

	// -- (2) a paid invoice in an OPEN month ---------------------------------
	{
		LOCKED = new Set();
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W31-01", driver: "shorn king", ws: "2026-08-01", we: "2026-08-07", paid: "2026-08-09" });
		const body = refuse(lockFor(db));
		check("409/paid-only: the code names the real reason, not a period",
			body.code, "INVOICE_ALREADY_PAID");
		check("409/paid-only: no month is named", body.periods, []);
		check("409/paid-only: it does not claim an unreadable date either", body.unresolved, false);
		check("409/paid-only: the remedy talks about the INVOICE",
			/already been PAID/.test(body.error), true);
		check("409/paid-only: and NOT about detaching an investor payout",
			/detached from their investor/.test(body.error), false);
		check("409/paid-only: it never tells the admin to reopen a period",
			/reopen/i.test(body.error), false);
		db.close();
	}

	// -- (1) an invoice whose billing week resolves to no month --------------
	{
		LOCKED = new Set();
		const db = mkdb();
		inv(db, { n: "INV-SK-BAD", driver: "shorn king", ws: "not-a-date", we: "" });
		const body = refuse(lockFor(db));
		check("409/unresolvable: the sentinel never reaches `periods`",
			body.periods.filter((p) => !MONTHISH.test(p)), []);
		check("409/unresolvable: so no month is named at all", body.periods, []);
		check("409/unresolvable: and the flag that explains WHY is set", body.unresolved, true);
		check("409/unresolvable: the explaining sentence fires",
			/cannot resolve to a month/.test(body.error), true);
		check("409/unresolvable: the raw sentinel is never printed",
			/unrecognized date|\(unknown\)/.test(body.error), false);
		check("409/unresolvable: it is still a period-class refusal", body.code, "PERIOD_FINALIZED");
		db.close();
	}

	// -- the wire contract for the cases that already worked -----------------
	{
		LOCKED = new Set(["2026-05"]);
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W19-01", driver: "shorn king", ws: "2026-05-09", we: "2026-05-15" });
		const body = refuse(lockFor(db));
		check("409/locked: unchanged — still PERIOD_FINALIZED", body.code, "PERIOD_FINALIZED");
		check("409/locked: names the finalized month", body.periods, ["2026-05"]);
		check("409/locked: unresolved stays false", body.unresolved, false);
		check("409/locked: the reopen remedy is offered", /reopen/i.test(body.error), true);
		db.close();
	}

	// PERIOD_FINALIZED outranks INVOICE_ALREADY_PAID when both fire: it is the
	// stronger statement and the one with a defined remedy. Both sentences must
	// still appear, or the admin fixes one and retries into the other.
	{
		LOCKED = new Set(["2026-05"]);
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W19-01", driver: "shorn king", ws: "2026-05-09", we: "2026-05-15" });
		inv(db, { n: "INV-SK-2026W31-01", driver: "shorn king", ws: "2026-08-01", we: "2026-08-07", paid: "2026-08-09" });
		const lock = lockFor(db);
		const body = refuse(lock);
		check("409/both: PERIOD_FINALIZED wins the code", body.code, "PERIOD_FINALIZED");
		check("409/both: only the locked month is named", body.periods, ["2026-05"]);
		check("409/both: the paid-invoice sentence still appears",
			/already been PAID/.test(body.error), true);
		check("409/both: every blocker carries a code",
			lock.blockers.every((b) => typeof b.code === "string" && b.code.length > 0), true);
		db.close();
	}

	// A settled PAYOUT must keep its own sentence — the per-table split must not
	// have swapped one mislabel for another.
	{
		LOCKED = new Set();
		const db = mkdb();
		db.prepare("INSERT INTO investor_payouts (owner_id, period, status, paid_at, finalized_at) VALUES (?,?,?,?,?)")
			.run(7, "2026-06", "paid", "2026-07-02", "");
		const body = refuse(lockFor(db));
		check("409/payout: the investor-payout sentence still fires",
			/detached from their investor/.test(body.error), true);
		check("409/payout: and the invoice sentence does not",
			/already been PAID — money moved/.test(body.error), false);
		db.close();
	}

	// -- MUTANTS: each reconstructs one of the two shipped defects ------------
	// M1 — drop the sentinel normalisation from blocker (4).
	{
		// Paren count must be preserved — `asUnknown(namedLockedPeriods(` opens two,
		// so the replacement opens two. (An extra one here throws a SyntaxError
		// inside new Function, which would read as "the mutant was rejected" while
		// actually testing nothing.)
		const m1 = extract("userDeleteLockBlockers").split("asUnknown(namedLockedPeriods(").join("(namedLockedPeriods(");
		check("mutant M1 removed the sentinel normalisation",
			m1.includes("asUnknown(namedLockedPeriods("), false);
		LOCKED = new Set();
		const db = mkdb();
		inv(db, { n: "INV-SK-BAD", driver: "shorn king", ws: "not-a-date", we: "" });
		const body = refuse(lockFor(db, m1));
		check("M1 rejected — the un-normalised sentinel is printed as a month",
			body.periods, ["(unrecognized date)"]);
		check("M1 rejected — and `unresolved` stays false, so nothing explains it",
			body.unresolved, false);
		db.close();
	}
	// M2 — put the hardcoded response code back.
	{
		const m2 = REFUSAL.replace(/\n\t\t\tcode,\n/, "\n\t\t\tcode: \"PERIOD_FINALIZED\",\n");
		check("mutant M2 restored the hardcoded response code", m2 !== REFUSAL, true);
		LOCKED = new Set();
		const db = mkdb();
		inv(db, { n: "INV-SK-2026W31-01", driver: "shorn king", ws: "2026-08-01", we: "2026-08-07", paid: "2026-08-09" });
		const body = refuse(lockFor(db), m2);
		check("M2 rejected — a paid invoice is reported as a period problem",
			body.code, "PERIOD_FINALIZED");
		check("M2 rejected — with an empty periods array beside that claim",
			body.periods, []);
		db.close();
	}
}

// ---------------------------------------------------------------------------
// THE RECONCILER — GET /api/admin/orphaned-signed-artifacts
// ---------------------------------------------------------------------------
// The other end of the same feature: this cascade ARCHIVES a signed artifact
// before destroying the row that authorizes it, and that route is how anyone
// notices the copy left behind. It scans `uploads/` synchronously on the request
// path and reports which unreferenced files carry an SSN or a bank account, and
// it shipped with `requireRole("Super Admin")` and nothing else.
//
// Source-text assertions, in the style test-csrf-guard.js uses for the database
// export ("requireRole first, so a 403 never spends dbAdminLimiter") — the
// failure mode is a mount ORDER, which no behavioural test of the handler sees.
{
	const LS = SRC.split("\n");
	const ROUTE = "/api/admin/orphaned-signed-artifacts";
	const mount = LS.find((l) => l.startsWith("app.get(") && l.includes(`"${ROUTE}"`));
	check("orphan scan: route registered on one line", Boolean(mount), true);
	check("orphan scan: orphanScanLimiter is mounted",
		Boolean(mount) && mount.includes("orphanScanLimiter"), true);
	// ⚠️ THE ORDER IS THE POINT. Mounted limiter-first, an unauthenticated caller
	// spends the whole 10-request budget on 403s and locks the Super Admin out of
	// an admin-only route. Same ordering as fuelEventsLimiter, fuelGallonsLimiter,
	// onboardingEvidenceLimiter and dbAdminLimiter.
	check("orphan scan: requireRole precedes the limiter, so a 403 cannot spend the budget",
		Boolean(mount) && mount.indexOf("requireRole") > -1
			&& mount.indexOf("requireRole") < mount.indexOf("orphanScanLimiter"), true);

	// A `const` middleware mounted above its own definition is a TDZ crash at
	// require time — the whole app fails to boot, not just this route.
	const defIdx = LS.findIndex((l) => l.startsWith("const orphanScanLimiter = rateLimit("));
	const mountIdx = LS.indexOf(mount);
	check("orphan scan: the limiter is defined ABOVE its mount (else the app cannot boot)",
		defIdx > -1 && mountIdx > defIdx, true);

	// Budget: the same shape as dbAdminLimiter, which it is modelled on.
	const def = LS.slice(defIdx, defIdx + 6).join("\n");
	check("orphan scan: 15-minute window", /windowMs:\s*15\s*\*\s*60\s*\*\s*1000/.test(def), true);
	check("orphan scan: max 10, matching dbAdminLimiter", /max:\s*10\b/.test(def), true);

	// -----------------------------------------------------------------------
	// THE CROSS-SITE GUARD IS DELIBERATELY ABSENT — encoded as its TRIGGER.
	// -----------------------------------------------------------------------
	// Every route carrying refuseCrossSite has a side EFFECT that a top-level
	// cross-site GET navigation can force while SameSite=Lax still sends the
	// cookie: fuel-gallons-recovery bills Gemini, onboarding-evidence forges an
	// audit_trail row, /api/db/download dumps 313 MB of plaintext PII. The
	// adjacent fuel-events GET is explicitly DENIED the guard because ~140 ms of
	// local CPU is not an effect — "it is the cost, not the verb, that decides".
	// This route writes nothing at all, and CORS already withholds the body from
	// the page that forced the navigation, so the limiter is the whole control.
	//
	// ⚠️ Asserted as the RULE, not the current state: the day this route starts
	// writing an audit row (a defensible follow-up — it is why /api/db/* got
	// theirs) it becomes the audit-row-injection shape onboarding-evidence is
	// guarded for, and the guard must land in the same commit.
	const end = LS.findIndex((l, i) => i > mountIdx && l === "});");
	const handler = LS.slice(mountIdx, end + 1).join("\n");
	// Guard against a vacuous pass: a slice that captured nothing would satisfy
	// the rule below forever.
	check("orphan scan: the handler body was actually located",
		handler.includes("orphans.push(") && handler.includes("missingCount"), true);
	check("orphan scan: writes no audit row, so refuseCrossSite is not yet earned — and if that changes, the guard must land with it",
		!/\blogAudit\(/.test(handler) || mount.includes("refuseCrossSite"), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
