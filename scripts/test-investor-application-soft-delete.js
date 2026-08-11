#!/usr/bin/env node
// Locks the investor-application soft delete and the signed-artifact orphan
// reconciler.
//
// WHY THE DELETE IS SOFT. `investor_onboarding`, `investor_onboarding_documents`
// and `investor_payment_info` all declare
// FOREIGN KEY (application_id) REFERENCES investor_applications(id), and
// `foreign_keys = ON`. A hard DELETE therefore raises a constraint error for
// exactly the applications that got furthest — the ones carrying signed
// documents — while a cascade would destroy signed evidence. Until now there was
// no delete route at all, so a spam or duplicate row from the UNAUTHENTICATED
// public form was permanent.
//
// THE THREE THINGS THAT SILENTLY GO WRONG, each with its own section:
//
//   1. A HALF-FILTERED READER. Hiding the row from the list and leaving it
//      readable by id is the classic broken soft delete — tax id, banking and
//      signed documents all still served. All four readers are checked, and the
//      status route is checked for ORDER as well: `status = 'Accepted'` creates
//      a user account and emails a password, so its guard has to sit above the
//      write.
//
//   2. THE BEARER TOKEN. `access_token` is non-expiring, accepted with NO
//      session, and authorizes e-signing and `POST …/banking`, which rewrites
//      where money is sent. "Deleted but the token still works" is not a
//      disclosure bug, it is a write credential outliving the record it belongs
//      to. Refused as 404 through the same branch as a missing id, so an
//      unauthenticated caller gets no oracle for "this id existed once".
//
//   3. THE MIGRATION'S POSITION. investor_applications has a rename-recreate
//      migration that copies rows with an EXPLICIT column list. A `deleted_at`
//      ALTER placed above it is silently DROPPED on any database that still
//      needs the CHECK rebuild — the column vanishes and every `IS NULL` filter
//      starts throwing. Asserted textually, with a mutant.
//
// Everything is EXTRACTED from server.js and run against scratch in-memory
// databases and a fresh mkdtemp. No network, no app.db, no server.
//
//   node scripts/test-investor-application-soft-delete.js    # exits 1 on failure

"use strict";

const fs = require("fs");
const os = require("os");
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
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}(), found ${hits}`);
	const start = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", start);
	if (end < 0) throw new Error(`could not find the end of ${name}()`);
	return SRC.slice(start, end + 3);
}
// ⚠️ STRUCTURAL ASSERTIONS RUN OVER CODE, NEVER PROSE. server.js is heavily
// commented and those comments quote the very identifiers being asserted on —
// the note beside the /sensitive route literally reads "NO include_deleted
// ESCAPE HATCH HERE", which a naive text test reads as an escape hatch. Cuts at
// the first `//` that is not inside a string literal.
function stripComments(src) {
	return src.split("\n").map((line) => {
		let quote = null;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (quote) {
				if (c === "\\") { i++; continue; }
				if (c === quote) quote = null;
				continue;
			}
			if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
			if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
		}
		return line;
	}).join("\n");
}

// The body of a route's final `(req, res) => { … }`, terminated by `});` in
// column 0. Route handlers are closures, so they cannot be pulled out by name.
function extractHandler(mountPrefix) {
	const hits = SRC.split(mountPrefix).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 mount matching ${mountPrefix}, found ${hits}`);
	const at = SRC.indexOf(mountPrefix);
	const arrow = SRC.indexOf("(req, res) => {", at);
	if (arrow < 0) throw new Error(`no handler found for ${mountPrefix}`);
	const start = arrow + "(req, res) => {".length;
	const end = SRC.indexOf("\n});", start);
	if (end < 0) throw new Error(`could not find the end of the handler for ${mountPrefix}`);
	return SRC.slice(start, end);
}

// ---------------------------------------------------------------------------
// 3. THE MIGRATION'S POSITION — below the rename-recreate, or it is dropped.
// ---------------------------------------------------------------------------
{
	const alterAt = SRC.indexOf(`ALTER TABLE investor_applications ADD COLUMN deleted_at`);
	const rebuildAt = SRC.indexOf(`DROP TABLE investor_applications_old;`);
	const copyAt = SRC.indexOf(`INSERT INTO investor_applications SELECT id, legal_name`);
	check("the deleted_at ALTER exists", alterAt > 0, true);
	check("the rename-recreate migration still exists", rebuildAt > 0, true);
	// ⚠️ The copy uses an explicit column list, which is exactly why order matters.
	check("the rebuild copies an EXPLICIT column list (so a new column is not carried)",
		/INSERT INTO investor_applications SELECT id, legal_name[\s\S]{0,600}?FROM investor_applications_old/.test(SRC), true);
	check("the deleted_at ALTER runs AFTER the rebuild", alterAt > rebuildAt && alterAt > copyAt, true);
	check("an index backs the filter", SRC.includes("idx_ia_deleted_at"), true);

	// Behavioural proof of the hazard, so the ordering rule is not folklore:
	// run the real rebuild's copy statement on a table that has the column and
	// show the column is gone on the other side.
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE investor_applications_old (id INTEGER PRIMARY KEY, legal_name TEXT, status TEXT, created_at TEXT, deleted_at DATETIME DEFAULT NULL);
		CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, legal_name TEXT, status TEXT, created_at TEXT);
		INSERT INTO investor_applications_old (id, legal_name, status, created_at, deleted_at) VALUES (1,'Acme','New','2026-01-01','2026-02-02');
		INSERT INTO investor_applications SELECT id, legal_name, status, created_at FROM investor_applications_old;
	`);
	const cols = db.prepare("PRAGMA table_info(investor_applications)").all().map((c) => c.name);
	check("an explicit-column-list rebuild really does drop deleted_at", cols.includes("deleted_at"), false);
	db.close();
}

// ---------------------------------------------------------------------------
// 2. THE BEARER TOKEN — suspended with the record.
// ---------------------------------------------------------------------------
{
	const V = new Function("db", `${extractFn("verifyInvestorToken")}\nreturn { verifyInvestorToken };`);
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, legal_name TEXT, access_token TEXT, deleted_at DATETIME DEFAULT NULL);`);
	db.prepare("INSERT INTO investor_applications (id, legal_name, access_token) VALUES (1,'Acme Freight','tok-live')").run();
	db.prepare("INSERT INTO investor_applications (id, legal_name, access_token, deleted_at) VALUES (2,'Spam LLC','tok-dead','2026-08-10 12:00:00')").run();
	const { verifyInvestorToken } = V(db);

	const call = (id, token) => {
		const out = { status: null, body: null };
		const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
		out.ret = verifyInvestorToken({ params: { id: String(id) }, query: { token }, body: {}, headers: {} }, res);
		return out;
	};

	const live = call(1, "tok-live");
	check("token: a live application with the right token authorizes", live.ret, 1);
	check("token: and no error is sent", live.status, null);

	const dead = call(2, "tok-dead");
	check("token: a SOFT-DELETED application's token no longer authorizes", dead.ret, null);
	check("token: refused as 404, not 403 — a 403 would confirm it exists", dead.status, 404);

	const ghost = call(999, "tok-dead");
	check("token: a non-existent id is also 404", ghost.status, 404);
	// ⚠️ Byte-identical refusal, or the route becomes an oracle for "this id
	// existed and was removed" against an unauthenticated caller.
	check("token: deleted and non-existent are INDISTINGUISHABLE", dead.body, ghost.body);

	const wrong = call(1, "tok-wrong");
	check("token: a wrong token on a live application is still 403", wrong.status, 403);
	const blank = call(1, "");
	check("token: an empty token is refused", blank.ret, null);

	// Restore re-authorizes: the credential was suspended, not revoked.
	db.prepare("UPDATE investor_applications SET deleted_at = NULL WHERE id = 2").run();
	check("token: restoring the row makes the SAME token work again", call(2, "tok-dead").ret, 2);
	db.close();
}

// ---------------------------------------------------------------------------
// 1. THE READERS — all four, plus the ordering on the one that creates a user.
// ---------------------------------------------------------------------------
{
	const listH = stripComments(extractHandler(`app.get("/api/investor-applications", requireRole`));
	const detailH = stripComments(extractHandler(`app.get("/api/investor-applications/:id", requireRole`));
	const sensitiveH = stripComments(extractHandler(`app.get("/api/investor-applications/:id/sensitive", requireRole`));
	const statusSrc = stripComments((() => {
		const at = SRC.indexOf(`app.put("/api/investor-applications/:id/status"`);
		const end = SRC.indexOf("\n});", at);
		return SRC.slice(at, end);
	})());

	check("reader 1 (list): filters deleted rows", /ia\.deleted_at IS NULL/.test(listH), true);
	check("reader 1 (list): offers include_deleted so a row can be found and restored",
		/include_deleted/.test(listH), true);
	check("reader 2 (detail): filters deleted rows", /application\.deleted_at/.test(detailH), true);
	check("reader 2 (detail): returns 404, not an empty body", /404/.test(detailH), true);
	check("reader 3 (sensitive): filters deleted rows", /application\.deleted_at/.test(sensitiveH), true);
	// ⚠️ No escape hatch on the audited PII reveal — restore first.
	check("reader 3 (sensitive): has NO include_deleted escape hatch", /include_deleted/.test(sensitiveH), false);
	check("reader 4 (status): filters deleted rows", /target\.deleted_at/.test(statusSrc), true);
	check("reader 4 (status): refuses with a named code", /APPLICATION_DELETED/.test(statusSrc), true);
	// ⚠️ GUARD BEFORE THE WRITE. `Accepted` creates a user account and mails a
	// password, and the status flip is what triggers it.
	check("reader 4 (status): the guard runs BEFORE the UPDATE",
		statusSrc.indexOf("target.deleted_at") < statusSrc.indexOf("UPDATE investor_applications SET status"), true);
	check("reader 4 (status): and before the account-creation branch",
		statusSrc.indexOf("target.deleted_at") < statusSrc.indexOf('status === "Accepted"'), true);

	// Behavioural: the list SQL is a template literal with the conditional in it,
	// so evaluate the real string and run it.
	const sqlSrc = listH.match(/db\.prepare\(`(SELECT ia\.\*[\s\S]*?)`\)\.all\(\)/);
	check("list SQL was extracted", !!sqlSrc, true);
	const buildSql = new Function("includeDeleted", `return \`${sqlSrc[1]}\`;`);
	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, legal_name TEXT, status TEXT, created_at TEXT, deleted_at DATETIME DEFAULT NULL);
		CREATE TABLE investor_onboarding (application_id INTEGER, status TEXT);
		CREATE TABLE investor_onboarding_documents (application_id INTEGER, signed INTEGER);
		INSERT INTO investor_applications (id, legal_name, status, created_at) VALUES (1,'Acme Freight','New','2026-01-01');
		INSERT INTO investor_applications (id, legal_name, status, created_at, deleted_at) VALUES (2,'Spam LLC','New','2026-01-02','2026-08-10');
		INSERT INTO investor_applications (id, legal_name, status, created_at) VALUES (3,'Half Filled','Draft','2026-01-03');
	`);
	const live = db.prepare(buildSql(false)).all().map((r) => r.id);
	const all = db.prepare(buildSql(true)).all().map((r) => r.id);
	check("list: a deleted application is excluded", live, [1]);
	check("list: include_deleted brings it back for restore", all.sort(), [1, 2]);
	check("list: Draft is still excluded either way", all.includes(3), false);
	check("list: deleted_at ships so the UI can badge a restorable row",
		db.prepare(buildSql(true)).all().find((r) => r.id === 2).deleted_at, "2026-08-10");
	db.close();
}

// ---------------------------------------------------------------------------
// THE DELETE / RESTORE PAIR.
// ---------------------------------------------------------------------------
{
	const delH = stripComments(extractHandler(`app.delete("/api/investor-applications/:id", requireRole`));
	const resH = stripComments(extractHandler(`app.post("/api/investor-applications/:id/restore", requireRole`));
	check("delete is SOFT — it UPDATEs deleted_at, never DELETEs the row",
		/UPDATE investor_applications SET deleted_at = CURRENT_TIMESTAMP/.test(delH), true);
	check("delete never issues a hard DELETE", /DELETE FROM investor_applications/.test(delH), false);
	check("delete is idempotent by construction (AND deleted_at IS NULL)",
		/AND deleted_at IS NULL/.test(delH), true);
	check("delete is audited", /logAudit/.test(delH), true);
	check("delete's audit line records that the access token stopped working",
		/token/i.test(delH), true);
	check("restore clears deleted_at", /SET deleted_at = NULL/.test(resH), true);
	check("restore does NOT regenerate the access token — it was suspended, not revoked",
		/access_token\s*=/.test(resH), false);
	check("restore is audited", /logAudit/.test(resH), true);

	const db = new Database(":memory:");
	db.exec(`CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, legal_name TEXT, deleted_at DATETIME DEFAULT NULL);`);
	db.prepare("INSERT INTO investor_applications (id, legal_name) VALUES (1,'Spam LLC')").run();
	const del = () => db.prepare("UPDATE investor_applications SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL").run(1).changes;
	check("delete: first call soft-deletes", del(), 1);
	check("delete: second call is a no-op → the route's 404", del(), 0);
	check("delete: the row is still there (recoverable)", db.prepare("SELECT COUNT(*) AS c FROM investor_applications").get().c, 1);
	check("restore: brings it back", db.prepare("UPDATE investor_applications SET deleted_at = NULL WHERE id = ?").run(1).changes, 1);
	check("delete: works again after a restore", del(), 1);
	db.close();
}

// ---------------------------------------------------------------------------
// THE ORPHAN RECONCILER.
// ---------------------------------------------------------------------------
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-scan-"));
	const dDir = path.join(root, "uploads", "onboarding-signed");
	const iDir = path.join(root, "uploads", "investor-onboarding-signed");
	fs.mkdirSync(dDir, { recursive: true });
	fs.mkdirSync(iDir, { recursive: true });
	const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2048, 0x20)]);
	// Two referenced, three orphans, one row whose file is missing.
	fs.writeFileSync(path.join(dDir, "w9-7-signed.pdf"), pdf);                        // referenced
	fs.writeFileSync(path.join(dDir, "w9-41-signed.pdf"), pdf);                       // ORPHAN, confidential
	fs.writeFileSync(path.join(dDir, "mobile_policy-41-signed.pdf"), pdf);            // ORPHAN, not confidential
	fs.writeFileSync(path.join(dDir, "notes.txt"), "ignore me");                      // not a PDF
	fs.writeFileSync(path.join(iDir, "w9-3-signed.pdf"), pdf);                        // referenced
	fs.writeFileSync(path.join(iDir, "master_agreement-9-signed.pdf"), pdf);          // ORPHAN

	const db = new Database(":memory:");
	db.exec(`
		CREATE TABLE onboarding_documents (id INTEGER PRIMARY KEY, user_id INTEGER, doc_key TEXT, signed INTEGER, signed_pdf_url TEXT);
		CREATE TABLE investor_onboarding_documents (id INTEGER PRIMARY KEY, application_id INTEGER, doc_key TEXT, signed INTEGER, signed_pdf_url TEXT);
		INSERT INTO onboarding_documents (user_id, doc_key, signed, signed_pdf_url) VALUES (7,'w9',1,'/uploads/onboarding-signed/w9-7-signed.pdf');
		INSERT INTO onboarding_documents (user_id, doc_key, signed, signed_pdf_url) VALUES (7,'contractor_agreement',1,'/uploads/onboarding-signed/contractor_agreement-7-signed.pdf');
		INSERT INTO investor_onboarding_documents (application_id, doc_key, signed, signed_pdf_url) VALUES (3,'w9',1,'/uploads/investor-onboarding-signed/w9-3-signed.pdf');
	`);

	const H = new Function(
		"req", "res", "db", "fs", "path", "__dirname", "isConfidentialOnboardingDoc",
		extractHandler(`app.get("/api/admin/orphaned-signed-artifacts", requireRole`)
	);
	const out = { status: 200, body: null };
	const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
	// The REAL confidentiality rule, so the flag is not a re-implementation.
	const G = new Function("ONBOARDING_DOCS", "INVESTOR_ONBOARDING_DOCS",
		`${extractFn("isConfidentialOnboardingDoc")}\nreturn isConfidentialOnboardingDoc;`
	)(
		[{ key: "w9", confidential: 1 }, { key: "contractor_agreement", confidential: 1 }, { key: "mobile_policy", confidential: 0 }],
		[{ key: "w9", confidential: 1 }, { key: "master_agreement", confidential: 1 }],
	);
	H({ query: {} }, res, db, fs, path, root, G);

	const r = out.body;
	check("orphans: status is 200", out.status, 200);
	check("orphans: three files have no row", r.count, 3);
	check("orphans: they are the right three", r.orphans.map((o) => o.file).sort(),
		["master_agreement-9-signed.pdf", "mobile_policy-41-signed.pdf", "w9-41-signed.pdf"]);
	check("orphans: a referenced file is NOT reported",
		r.orphans.some((o) => o.file === "w9-7-signed.pdf"), false);
	check("orphans: a non-PDF is skipped", r.orphans.some((o) => o.file === "notes.txt"), false);
	check("orphans: both scopes are scanned", [...new Set(r.orphans.map((o) => o.scope))].sort(), ["driver", "investor"]);
	check("orphans: confidential ones are counted for triage", r.confidentialCount, 2);
	check("orphans: metadata only — no file contents",
		Object.keys(r.orphans[0]).sort(), ["bytes", "confidential", "dir", "file", "modifiedAt", "scope", "url"]);
	check("orphans: the row whose file is missing is reported separately", r.missingCount, 1);
	check("orphans: and it is named by doc, not by filename",
		r.missing[0].docKey, "contractor_agreement");
	check("orphans: the remedy says move, not delete",
		/rather than deleting/.test(r.remedy || ""), true);
	check("orphans: scan counts are reported", [r.filesScanned, r.rowsScanned], [5, 3]);

	// ⚠️ AUTHORITY IS THE ROW, NOT THE ID. `w9-41-signed.pdf` is an orphan even
	// though some user 41 may well exist; a live id proves nothing about whether
	// any row points at this file. This is the assertion that fails an
	// implementation which parses the filename and checks the id.
	db.prepare("INSERT INTO onboarding_documents (user_id, doc_key, signed, signed_pdf_url) VALUES (41,'w9',1,'/uploads/onboarding-signed/SOMETHING-ELSE.pdf')").run();
	const out2 = { body: null };
	H({ query: {} }, { status() { return this; }, json(b) { out2.body = b; return this; } }, db, fs, path, root, G);
	check("orphans: a row for the same id pointing at a DIFFERENT file does not clear the orphan",
		out2.body.orphans.some((o) => o.file === "w9-41-signed.pdf"), true);

	// And the converse: pointing a row at the file clears it.
	db.prepare("UPDATE onboarding_documents SET signed_pdf_url = '/uploads/onboarding-signed/w9-41-signed.pdf' WHERE user_id = 41").run();
	const out3 = { body: null };
	H({ query: {} }, { status() { return this; }, json(b) { out3.body = b; return this; } }, db, fs, path, root, G);
	check("orphans: a row pointing AT the file clears it",
		out3.body.orphans.some((o) => o.file === "w9-41-signed.pdf"), false);

	// Read-only: nothing was deleted from disk or the database.
	check("orphans: the reconciler deleted no files", fs.readdirSync(dDir).length, 4);
	check("orphans: and no rows", db.prepare("SELECT COUNT(*) AS c FROM onboarding_documents").get().c, 3);

	// A missing directory must not throw — a fresh install has neither.
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-empty-"));
	const out4 = { status: 200, body: null };
	H({ query: {} }, { status(s) { out4.status = s; return this; }, json(b) { out4.body = b; return this; } }, db, fs, path, bare, G);
	check("orphans: a missing uploads directory is not an error", out4.status, 200);
	check("orphans: and reports zero files scanned", out4.body.filesScanned, 0);
	fs.rmSync(bare, { recursive: true, force: true });

	db.close();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
