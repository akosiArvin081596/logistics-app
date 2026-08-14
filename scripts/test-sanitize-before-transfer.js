#!/usr/bin/env node
// scripts/test-sanitize-before-transfer.js — prove the sanitize-then-transfer
// flow, offline, against a scratch database of obviously-fake PII.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
//   refresh-local.sh used to copy the production snapshot to a laptop and
//   sanitize it there. The sanitizer was correct; it simply ran after the
//   egress. The fix moves it onto the VPS — and the only honest way to show a
//   redaction happened before a transfer is to run the whole sequence and then
//   look at the bytes that would have crossed the network.
//
//   So this seeds a database with invented SSNs, EINs, routing and account
//   numbers and routable addresses, runs the real script in the real modes, and
//   asserts the emitted artifact holds none of them — by grepping the raw file,
//   which is a check that cannot be satisfied by a bug in the assertions.
//
// WHY IT GREW A FREE-TEXT HALF (2026-08-13)
//
//   Every redaction in refresh-env.js was COLUMN-AWARE: it named a table and a
//   column. So an address typed into a notes field, embedded in a JSON blob, or
//   recorded in an audit line walked straight through — and the assertion block
//   classified it as an *advisory* while the run printed "clean" four lines
//   below the warnings naming it. Measured on the 2026-08-13 production
//   snapshot: **21 routable third-party addresses shipped in a run that
//   reported success**, across three columns —
//     job_applications.reference_info (6) — the references and previous
//       employers an applicant listed, i.e. THIRD PARTIES who never applied for
//       anything, never consented to anything, and are not users of this system,
//     audit_trail.details (8),
//     load_invoice_drafts.recipient (7).
//   Stage 3h sweeps every text column of every table and rewrites those in
//   place; the sweep that grades it was promoted from advisory to a hard
//   refusal. Sections 5-8 and the mutants below are what stop that pair
//   regressing into a scrub that runs, does nothing, and still reports clean.
//
// ⚠️ WHAT MAKES THIS TEST NON-VACUOUS, and what would quietly make it vacuous.
//
//   • collectLeaks() guards EVERY entry with has_(table, column). A column the
//     fixture never populates is therefore not "passing" — it is UNTESTED, and
//     it reports identically. Adding a scrub target without adding a fixture
//     row here buys a green line and no coverage. Every column asserted below
//     is seeded above.
//   • "The address is gone" is satisfied by a scrub that BLANKS the value, and
//     blanking audit_trail.details destroys the settlement evidence the row
//     exists to be. So every free-text case is graded on a SKELETON — the
//     original with its addresses replaced by a constant against the artifact
//     with its tokens replaced by the same constant — which passes only on a
//     substring rewrite that left the rest of the value byte-identical.
//   • The highest-value case is one PRODUCTION DATA CANNOT DEMONSTRATE. The
//     refusal-audit marker (`[PERIOD_…] periods=…`) shipped 2026-08-13 and the
//     production snapshot contains ZERO rows carrying one, so a run against real
//     data proves nothing about marker integrity, however many addresses it
//     rewrites. Sections 5-6 seed both shapes server.js writes — the prose form
//     from periodRefusalDetail() and the JSON form from buildSheetUpdateAudit(),
//     whose marker sits deliberately OUTSIDE the JSON body — and grade them with
//     the real parser extracted from server.js.
//   • Section 12 mutates the shipped sanitizer five ways and requires each to be
//     caught. Every mutant asserts separately that it CHANGED the source, so a
//     later rename turns it into a loud failure rather than a permanently
//     passing no-op.
//
// SAFETY
//
//   It touches nothing outside its scratch directory. No network, no VPS, no
//   production snapshot, no app.db, no Google Sheet. The only script it executes
//   is refresh-env.js (and byte-mutated copies of it) in --sanitize-only,
//   --verify, --check-env-only and --from-sanitized modes, against files it
//   created itself in a mkdtemp directory it deletes on the way out.
//
// Usage:  node scripts/test-sanitize-before-transfer.js [--keep]
// ---------------------------------------------------------------------------
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const SCRIPT = path.join(__dirname, "refresh-env.js");
const SERVER = path.join(__dirname, "..", "server.js");
const KEEP = process.argv.includes("--keep");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-sanitize-test."));

// The node_modules directory this run will use — RESOLVED, never composed.
//
// This was `path.join(__dirname, "..", "node_modules")` at the symlink site,
// which asserts a layout instead of asking Node where its modules actually come
// from. That assertion is false in the ordinary case of a **git worktree**,
// which has no node_modules of its own because dependencies live in the parent
// checkout — so realpathSync threw ENOENT, a bare `catch {}` swallowed it, no
// symlink was made, and the operator met the failure five lines later as
// refresh-env.js's "better-sqlite3 not available — run this from the
// application directory so node_modules resolves". That message names the wrong
// cause: the working directory was already correct.
//
// require.resolve() performs the same upward node_modules walk that the shipped
// copy's own `require("better-sqlite3")` will perform, so what gets symlinked is
// the tree that would genuinely have satisfied it. It probes better-sqlite3
// specifically because that is the module refresh-env.js fails on first, and the
// whole DIRECTORY is symlinked rather than the single package because bcryptjs
// is required immediately afterwards and has to resolve from the same tree.
//
// ⚠️ In a nested git worktree this resolves the PARENT checkout's node_modules,
// including its compiled better-sqlite3 binary. That is what makes this suite
// runnable from a worktree at all, and it is correct while both checkouts want
// the same version — but it does mean the suite can exercise a native build that
// does not correspond to THIS worktree's package.json if the two ever diverge.
// Re-run from the main checkout before trusting a result that hinges on it.
const NODE_MODULES = (() => {
	try { return path.resolve(path.dirname(require.resolve("better-sqlite3/package.json")), ".."); }
	catch { return null; }
})();

// ---------------------------------------------------------------------------
// Invented values. Every one is a documentation/reserved-range placeholder or a
// deliberate impossibility — nothing here corresponds to a real person, account
// or tax id, and nothing was copied from production.
//   555-01xx  NANP reserved fictional
//   .test / .example  RFC 2606 reserved
//   999999999 is not a valid ABA routing number (checksum fails)
// ---------------------------------------------------------------------------
const FAKE = {
	ssnA: "123-45-6789",
	ssnB: "987-65-4321",
	einA: "12-3456789",
	einB: "98-7654321",
	routing: "999999999",
	accountA: "1234567890123",
	accountB: "9876543210987",
	licence: "TX-DL-00998877",
	mailA: "sam.driver@example-carrier.test",
	mailB: "pat.investor@example-fund.test",
	mailC: "chris.applicant@example-mail.test",
	mailD: "outreach.target@example-list.test",
	mailE: "broker.desk@example-broker.test",
	phone: "512-555-0143",
	// Home locality. Deliberately NOT email- or SSN-shaped: these exist to prove
	// the free-text sweep is not a safety net for the column lists.
	city: "Grangerville",
	state: "TX",
	zip: "77302",
	// Base64 "photographs". The payload is a recognisable needle inside a
	// data: URI so MUST_NOT_SURVIVE can grep the emitted gzip for it — a real
	// JPEG would compress differently and prove nothing about the bytes.
	cdlFront: "data:image/jpeg;base64,Q0RMRlJPTlRQSVhFTFNfTVVTVF9OT1RfU1VSVklWRQ==",
	cdlBack: "data:image/jpeg;base64,Q0RMQkFDS1BJWEVMU19NVVNUX05PVF9TVVJWSVZF",
	medCard: "data:image/jpeg;base64,TUVEQ0FSRFBJWEVMU19NVVNUX05PVF9TVVJWSVZF",
};

// ---------------------------------------------------------------------------
// FREE-TEXT fixtures — the addresses stage 3h is supposed to REWRITE.
//
// ⚠️ THESE CANNOT USE .test / .example / .invalid LIKE EVERYTHING ABOVE, and
// that is a property of the feature, not a shortcut. isRoutableAddress()
// deliberately SKIPS every RFC 2606 / RFC 6761 reserved name — that skip is what
// makes stage 3h idempotent and what stops it churning test fixtures and docs —
// so an address on a reserved domain is never touched, and a fixture built from
// one would exercise nothing at all while passing.
//
// `.notatld` is not a delegated top-level domain and never has been, so these
// are undeliverable in fact while being routable by the predicate: exactly the
// combination this half of the suite needs. Nothing here is a real mailbox, a
// real company, or a real person.
// ---------------------------------------------------------------------------
const FREE = {
	agent: "agent@realbroker.notatld",
	// Same mailbox, different spelling. pseudonym() keys on the lower-cased
	// address, so this must resolve to the SAME token — see section 7.
	agentUpper: "AGENT@RealBroker.notatld",
	ap: "ap@realbroker.notatld",
	billing: "billing@realbroker.notatld",
	// job_applications.reference_info: an applicant's named referee and previous
	// employer. The six real ones measured in production are the strongest
	// argument in this file — those people are not users of this system.
	reference: "ref.contact@refcheck.notatld",
	prevEmp: "hr@prevcarrier.notatld",
};

// ---------------------------------------------------------------------------
// The exact free-text values seeded, kept as constants so the assertions can
// compare the artifact against the ORIGINAL rather than against a paraphrase.
// ---------------------------------------------------------------------------
const ORIG = {
	// A message body: ordinary operational content around two addresses.
	body: `Call ${FREE.agent} about load 562620213 before 17:00, and cc ${FREE.billing} on the POD.`,

	// ⚠️ THE HIGHEST-VALUE FIXTURE IN THIS FILE. Shaped exactly like
	// periodRefusalDetail() (server.js): `<subject> WITHHELD [CODE] periods=… — …
	// — reason: <note>`, here in the "Blocked …" phrasing the dispatch refusal
	// helpers use. Three things in it are load-bearing and none is decoration:
	//   • `[PERIOD_FINALIZED]` — purgeOldAuditRefusals() exempts the row from its
	//     90-day DELETE by matching the literal `[PERIOD\_` in DETAILS. Lose the
	//     bracket and the settlement evidence is destroyed at 90 days, which is
	//     reliably BEFORE a dispute surfaces.
	//   • `] periods=` ADJACENCY — parsePeriodRefusalDetail() reads the month list
	//     only from `/^[ \t]*periods=/` immediately after the closing bracket,
	//     precisely so caller text elsewhere in the line cannot supply one. A
	//     replace that inserts anything between them silently drops the months.
	//   • ` — reason: ` — the note is read from the LAST occurrence of that exact
	//     separator, after the marker.
	// Production has ZERO rows of this shape today (the feature shipped
	// 2026-08-13), so this fixture is the only thing that can ever prove the
	// scrub does not break them.
	prose: `Blocked update of load 562620213 for ${FREE.agent} [PERIOD_FINALIZED] periods=2026-04,2026-05 — reason: broker asked to restate`,

	// The OTHER shape, from buildSheetUpdateAudit(): a JSON body with the marker
	// appended OUTSIDE it. That placement is deliberate (it survives the
	// builder's truncation budget), and it is exactly what a JSON round-trip
	// would throw away — see mutant M3.
	jsonRow: `{"outcome":"blocked","changed":[{"column":"Email","from":"${FREE.ap}","to":"${FREE.billing}"}]} [PERIOD_FINALIZED]`,

	// A free-text SSN, in a column no column-aware rule covers.
	ssnRow: `applicant identity check — ssn ${FAKE.ssnA} on file does not match the CDL`,

	// The case variant, alone in its own row so its token is unambiguous.
	caseRow: `outreach thread opened by ${FREE.agentUpper} on 2026-04-02`,

	// ⚠️ AN EMBEDDED NUL, AND IT IS NOT AN EXOTIC INPUT. SQLite's LIKE and GLOB
	// stop at a NUL; JavaScript does not. So before 2026-08-13 this row was
	// invisible to the scrub's SQL prefilter and fully visible to the grader —
	// the scrubber could never reach it, the grader refused every time, and no
	// flag or re-run fixed it. A permanently wedged refresh, fail-closed but
	// unfixable, which the file's own reasoning says ends in someone bypassing
	// the check. Reachable with no session: POST /api/public/apply binds free
	// text raw and JSON "\u0000" decodes to a real NUL.
	// If this fixture ever stops being scrubbed, the prefilter's third clause
	// (the blob-length-vs-text-length test) has been removed.
	nulRow: `applicant note${String.fromCharCode(0)}then ${FREE.prevEmp} and ssn ${FAKE.ssnB}`,

	// ⚠️ THE ADDRESS IS UNDER `relationship`, NOT `email`, because that is where
	// it sits in the real production rows. A scrub that scanned KEYS rather than
	// VALUES would pass a fixture that used `"email"` and miss all six real ones.
	// The spacing after the colons is also deliberate: it is what makes a JSON
	// round-trip (mutant M3) detectable at all.
	refInfo: `[{"name": "Dana Reference", "relationship": "former dispatcher, reachable at ${FREE.reference}", "phone": "${FAKE.phone}"}, {"name": "Lee Employer", "relationship": "prior employer — ${FREE.prevEmp}"}]`,
};

// Everything that must be absent from the bytes that would cross the network.
const MUST_NOT_SURVIVE = [
	FAKE.ssnA, FAKE.ssnB, FAKE.einA, FAKE.einB, FAKE.routing,
	FAKE.accountA, FAKE.accountB, FAKE.licence,
	FAKE.mailA, FAKE.mailB, FAKE.mailC, FAKE.mailD,
	// Free text — the 2026-08-13 gap. Present in the snapshot, absent from the
	// artifact, and NOT because the value was blanked (sections 5-7).
	FREE.agent, FREE.agentUpper, FREE.ap, FREE.billing, FREE.reference, FREE.prevEmp,
	// Signing evidence — personal data about the SIGNER, and invisible to the
	// free-text sweep because none of it is email- or SSN-shaped.
	"203.0.113.77", "AppleWebKit/605.1.15", "I, Sam Driver, agree to the terms",
	// ⚠️ The 2026-08-13 HIGH finding: licence and medical-card PHOTOGRAPHS, and
	// the home locality left behind beside an already-"REDACTED" address. All of
	// it invisible to stage 3h, so the column list is the only thing that reaches
	// it and MUST_NOT_SURVIVE is the only thing that proves the list still works.
	FAKE.cdlFront, FAKE.cdlBack, FAKE.medCard,
	FAKE.city, FAKE.zip,
];

// The two evidence columns refresh-env.js deliberately KEEPS. Asserted so that
// "deliberately kept" stays a decision somebody made rather than a column the
// scrub happens not to reach.
const MUST_SURVIVE = ["v2", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"];

// FAKE.mailE is deliberately NOT in that list. It is on a reserved domain, so it
// can never reach a human and stage 3h leaves it exactly as it found it — which
// is what keeps the sanitizer idempotent and keeps it from rewriting fixtures
// and documentation. Section 5 asserts it survives BYTE-IDENTICAL; that is the
// principled reason section 4's sweep exempts it, rather than a carve-out.

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok, detail });
	if (ok) pass++; else fail++;
	console.log(`  ${ok ? "[ok]  " : "[FAIL]"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(n) { console.log(`\n${n}`); }

// One exit path, so an early bail reports exactly like a full run. Every section
// from 4 on reads the emitted artifact, so without this a section-3 failure
// surfaces as a raw ENOENT stack trace that buries the [FAIL] lines explaining
// why.
function finish() {
	console.log("\n" + "-".repeat(74));
	console.log(`${pass + fail} assertions · ${fail} failed`);
	console.log(fail === 0 ? "=== ALL CHECKS PASSED ===" : "=== FAILURES ABOVE ===");
	if (KEEP) console.log(`\nscratch kept at ${ROOT}`);
	else fs.rmSync(ROOT, { recursive: true, force: true });
	process.exit(fail === 0 ? 0 : 1);
}

// Runs the real script. Returns {code, out} instead of throwing, because half
// these cases are asserting that it REFUSES.
function run(args, env = {}) {
	return runScript(SCRIPT, args, null, env);
}
function runScript(script, args, cwd, env = {}) {
	try {
		const out = execFileSync(process.execPath, [script, ...args], {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			cwd: cwd || undefined,
			env: { ...process.env, ...env },
		});
		return { code: 0, out };
	} catch (e) {
		return { code: e.status === undefined ? 1 : e.status, out: `${e.stdout || ""}${e.stderr || ""}` };
	}
}

// ---------------------------------------------------------------------------
function seedDatabase(dbPath) {
	const Database = require("better-sqlite3");
	const db = new Database(dbPath);
	db.pragma("journal_mode = DELETE");
	db.exec(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password_hash TEXT, must_change_password INTEGER DEFAULT 0, role TEXT, driver_name TEXT, full_name TEXT);
		CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expire INTEGER);
		CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY, driver_name TEXT, email TEXT, phone TEXT, cell TEXT, address TEXT, city TEXT, state TEXT, zip TEXT);
		CREATE TABLE investors (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, ein_ssn TEXT, address TEXT, application_id INTEGER DEFAULT 0);
		CREATE TABLE investor_applications (id INTEGER PRIMARY KEY, email TEXT, phone TEXT, ein_ssn TEXT, address TEXT, access_token TEXT, status TEXT);
		CREATE TABLE investor_outreach_log (id INTEGER PRIMARY KEY, email TEXT, sent_at TEXT);
		CREATE TABLE job_applications (id INTEGER PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT, cell TEXT, ssn TEXT, dob TEXT, drivers_license TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, signature TEXT, reference_info TEXT, cdl_front TEXT, cdl_back TEXT, medical_card TEXT, deleted_at TEXT);
		CREATE TABLE sheet_job_tracking (id INTEGER PRIMARY KEY, load_id TEXT, email TEXT, phone_number TEXT);
		CREATE TABLE investor_payment_info (id INTEGER PRIMARY KEY, investor_id INTEGER, routing_number TEXT, account_number TEXT, account_name TEXT, bank_name TEXT);
		CREATE TABLE driver_payment_info (id INTEGER PRIMARY KEY, driver TEXT, bank_routing TEXT, bank_account TEXT, bank_acct_name TEXT, bank_name TEXT, bank_address TEXT, bank_phone TEXT, check_name TEXT);
		CREATE TABLE onboarding_documents (id INTEGER PRIMARY KEY, signature_text TEXT, signed_ip TEXT, signed_ip_source TEXT, signed_user_agent TEXT, consent_text TEXT, evidence_version TEXT, artifact_sha256 TEXT);
		CREATE TABLE investor_onboarding_documents (id INTEGER PRIMARY KEY, signature_text TEXT, signature_image TEXT, signed_ip TEXT, signed_ip_source TEXT, signed_user_agent TEXT, consent_text TEXT, evidence_version TEXT, artifact_sha256 TEXT);
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY, driver_name TEXT, latitude REAL, longitude REAL, recorded_at TEXT);
		CREATE TABLE routemate_telemetry (id INTEGER PRIMARY KEY, routemate_vehicle_id TEXT, latitude REAL, longitude REAL, speed REAL, dropped_reason TEXT DEFAULT '', geocoded_location TEXT, fetched_at TEXT);
		CREATE TABLE messages (id INTEGER PRIMARY KEY, sender TEXT, body TEXT, created_at TEXT);
		CREATE TABLE audit_trail (id INTEGER PRIMARY KEY, action TEXT, details TEXT, created_at TEXT);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY, load_id TEXT, recipient TEXT, subject TEXT, created_at TEXT);
	`);

	db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,?)")
		.run(1, "super_admin", FAKE.mailA, "$2a$10$productionhashthatmustnotsurvive000000000000000000000", "Super Admin");
	db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,?)")
		.run(2, "demo_viewer", FAKE.mailB, "$2a$10$anotherproductionhash0000000000000000000000000000000", "Super Admin");
	db.prepare("INSERT INTO users (id,username,email,password_hash,role) VALUES (?,?,?,?,?)")
		.run(3, "sam.driver", FAKE.mailC, "$2a$10$thirdproductionhash00000000000000000000000000000000000", "Driver");

	db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("sid-live-1", '{"user":{"id":1,"role":"Super Admin"}}', 99999999);
	db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("sid-live-2", '{"user":{"id":3,"role":"Driver"}}', 99999999);

	db.prepare("INSERT INTO drivers_directory (id,driver_name,email,phone,cell,address,city,state,zip) VALUES (?,?,?,?,?,?,?,?,?)")
		.run(1, "Sam Driver", FAKE.mailA, FAKE.phone, FAKE.phone, "12 Real Street, Houston TX 77002", FAKE.city, FAKE.state, FAKE.zip);
	db.prepare("INSERT INTO investors (id,name,email,phone,ein_ssn,address) VALUES (?,?,?,?,?,?)")
		.run(1, "Example Fund LLC", FAKE.mailB, FAKE.phone, FAKE.einA, "900 Money Ave, Austin TX 78701");
	db.prepare("INSERT INTO investor_applications (id,email,phone,ein_ssn,address,access_token,status) VALUES (?,?,?,?,?,?,?)")
		.run(1, FAKE.mailB, FAKE.phone, FAKE.einB, "900 Money Ave", "live-bearer-token-must-be-regenerated", "approved");
	db.prepare("INSERT INTO investor_outreach_log (id,email,sent_at) VALUES (?,?,?)").run(1, FAKE.mailD, "2026-08-01");

	// ⚠️ reference_info is seeded on row 1 ONLY. collectLeaks() guards every check
	// with has_(table, column), so an unpopulated column reports the same green
	// line as a clean one — this row is the difference between covering
	// job_applications.reference_info and merely appearing to.
	// ⚠️ cdl_front / cdl_back / medical_card are the sharpest fixtures in this
	// file. They are base64 PHOTOGRAPHS of a driving licence and a DOT medical
	// card — carrying the licence number, DOB, home address, face and signature,
	// i.e. everything the columns beside them are emptied of. Production shipped
	// 8 rows of them (~30 MB) through a run that printed "clean" until
	// 2026-08-13, because base64 contains no "@" and no ###-##-####, so stage 3h
	// is STRUCTURALLY blind to them: only the explicit column list can reach
	// them, and only REDACTED_EMPTY can notice if it stops.
	// city/state/zip likewise — full name + city + ZIP re-identifies a person,
	// and `address` being "REDACTED" on the same row makes it LOOK scrubbed.
	db.prepare("INSERT INTO job_applications (id,full_name,email,phone,cell,ssn,dob,drivers_license,address,city,state,zip,signature,reference_info,cdl_front,cdl_back,medical_card) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
		.run(1, "Chris Applicant", FAKE.mailC, FAKE.phone, FAKE.phone, FAKE.ssnA, "1985-03-04", FAKE.licence,
			"5 Applicant Way", FAKE.city, FAKE.state, FAKE.zip, "data:image/png;base64,AAAA", ORIG.refInfo,
			FAKE.cdlFront, FAKE.cdlBack, FAKE.medCard);
	db.prepare("INSERT INTO job_applications (id,email,ssn,drivers_license,address) VALUES (?,?,?,?,?)")
		.run(2, FAKE.mailC, FAKE.ssnB, FAKE.licence, "6 Applicant Way");

	db.prepare("INSERT INTO sheet_job_tracking (id,load_id,email,phone_number) VALUES (?,?,?,?)")
		.run(1, "562620213", FAKE.mailE, FAKE.phone);
	db.prepare("INSERT INTO investor_payment_info (id,investor_id,routing_number,account_number,account_name,bank_name) VALUES (?,?,?,?,?,?)")
		.run(1, 1, FAKE.routing, FAKE.accountA, "Example Fund LLC", "First Example Bank");
	db.prepare("INSERT INTO driver_payment_info (id,driver,bank_routing,bank_account,bank_acct_name,bank_name,bank_address,bank_phone,check_name) VALUES (?,?,?,?,?,?,?,?,?)")
		.run(1, "Sam Driver", FAKE.routing, FAKE.accountB, "Sam Driver", "Second Example Bank", "1 Bank Plaza", FAKE.phone, "Sam Driver");
	// ⚠️ SIGNING EVIDENCE. Stage 3f empties signed_ip / signed_ip_source /
	// signed_user_agent / consent_text — a signer's IP address and browser
	// fingerprint are personal data about a third party — and collectLeaks()
	// asserts all four. But every one of those assertions is guarded by
	// has_(table, column), so before these columns existed in the fixture the
	// eight checks covering them reported exactly like passing ones while testing
	// nothing. They are also invisible to the free-text sweep: an IP address and a
	// user-agent string are neither email- nor SSN-shaped, so a 3f that quietly
	// stopped matching would ship them with every check still green.
	// (203.0.113.x is RFC 5737 TEST-NET-3 — a documentation range, never routable.)
	const EVIDENCE = ["203.0.113.77", "x-forwarded-for",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15",
		"I, Sam Driver, agree to the terms as presented on 2026-03-02.",
		// KEPT on purpose: the version marks a row as captured under the evidence
		// regime, and a digest of a file this script never copies discloses
		// nothing. Asserted below, so "deliberately kept" stays a decision.
		"v2", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"];
	db.prepare("INSERT INTO onboarding_documents (id,signature_text,signed_ip,signed_ip_source,signed_user_agent,consent_text,evidence_version,artifact_sha256) VALUES (?,?,?,?,?,?,?,?)")
		.run(1, "Sam Driver", ...EVIDENCE);
	db.prepare("INSERT INTO investor_onboarding_documents (id,signature_text,signature_image,signed_ip,signed_ip_source,signed_user_agent,consent_text,evidence_version,artifact_sha256) VALUES (?,?,?,?,?,?,?,?,?)")
		.run(1, "Pat Investor", "data:image/png;base64,BBBB", ...EVIDENCE);
	db.prepare("INSERT INTO driver_locations (id,driver_name,latitude,longitude,recorded_at) VALUES (?,?,?,?,?)")
		.run(1, "Sam Driver", 29.76, -95.36, "2026-05-01 10:00:00");

	// Telemetry, so the trim has something to do and the artifact is realistic.
	const tel = db.prepare("INSERT INTO routemate_telemetry (routemate_vehicle_id,latitude,longitude,speed,dropped_reason,geocoded_location,fetched_at) VALUES (?,?,?,?,'',?,?)");
	const many = db.transaction(() => {
		for (let i = 0; i < 4000; i++) {
			const d = new Date(Date.UTC(2026, 7, 8) - i * 3600e3).toISOString().replace("T", " ").slice(0, 19);
			tel.run("veh-33", 29.7 + i / 1e5, -95.3 - i / 1e5, 20, "Houston, TX", d);
		}
	});
	many();

	// ---- FREE TEXT: the columns no column-aware rule names ------------------
	const msg = db.prepare("INSERT INTO messages (id,sender,body,created_at) VALUES (?,?,?,?)");
	// id 1 — a RESERVED-domain address. It can never reach a human, so stage 3h
	// leaves it alone; asserted byte-identical in section 5.
	msg.run(1, "dispatch", `Rate con is coming from ${FAKE.mailE} — watch for it.`, "2026-08-01");
	// id 2 — two routable addresses inside ordinary operational prose.
	msg.run(2, "dispatch", ORIG.body, "2026-08-02");

	const aud = db.prepare("INSERT INTO audit_trail (id,action,details,created_at) VALUES (?,?,?,?)");
	aud.run(1, "note", `broker contact ${FAKE.mailE}`, "2026-08-01");
	aud.run(2, "update_sheet_row_blocked", ORIG.prose, "2026-08-02");
	aud.run(3, "update_sheet_row_blocked", ORIG.jsonRow, "2026-08-02");
	aud.run(4, "note", ORIG.ssnRow, "2026-08-03");
	aud.run(5, "note", ORIG.caseRow, "2026-08-04");
	// ⚠️ The NUL row. Its payload sits AFTER an embedded NUL, so SQLite's LIKE
	// and GLOB cannot see it while JavaScript can. Until the prefilter grew its
	// blob-length clause this row was unreachable by the scrub and fully visible
	// to the grader: a refusal on every run that no re-run could clear.
	aud.run(6, "note", ORIG.nulRow, "2026-08-05");

	// The third column measured in production. A table nothing else in this
	// script knows about, which is the point: stage 3h is a sweep, not a list.
	const dr = db.prepare("INSERT INTO load_invoice_drafts (id,load_id,recipient,subject,created_at) VALUES (?,?,?,?,?)");
	dr.run(1, "562620213", FREE.agent, "Invoice INV-SK-2026W19-01", "2026-08-02");
	dr.run(2, "562620214", FREE.billing, "Invoice INV-SK-2026W19-02", "2026-08-02");

	db.close();
}

function gzipTo(src, dst) {
	fs.writeFileSync(dst, zlib.gzipSync(fs.readFileSync(src), { level: 6 }));
}
function gunzipToBuffer(p) {
	return /\.gz$/i.test(p) ? zlib.gunzipSync(fs.readFileSync(p)) : fs.readFileSync(p);
}
// ⚠️ The raw-file greps below decode the database as LATIN1 on purpose — it is a
// byte-for-byte view, so a value can never hide inside a page this suite failed
// to decode as text. That makes every needle a BYTE sequence too: the fixtures
// carry em dashes (U+2014), which are three UTF-8 bytes and therefore do not
// appear literally in a latin1 string. Search for the encoded form, not the
// source literal, or an assertion silently tests nothing.
const bytes = (s) => Buffer.from(String(s), "utf8").toString("latin1");
function gunzipToFile(gz, out) {
	fs.writeFileSync(out, gunzipToBuffer(gz), { mode: 0o600 });
	return out;
}
function openDb(p) {
	const Database = require("better-sqlite3");
	return new Database(p, { readonly: true });
}
function writeEnv(dir, lines) {
	fs.writeFileSync(path.join(dir, ".env"), lines.join("\n") + "\n");
}

// ===========================================================================
// THE FREE-TEXT ORACLE
//
// ⚠️ DELIBERATELY AN INDEPENDENT COPY of the reserved-domain rule, not an import
// of refresh-env.js's isRoutableAddress(). Grading a predicate with itself
// proves nothing — the same mistake would be made twice and agree. This is the
// smallest honest restatement of "could this address reach a human?", written
// from the RFCs rather than from that file.
// ===========================================================================
const ADDR_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*[A-Za-z0-9]\.[A-Za-z]{2,}/g;
const TOKEN_RE = /[0-9a-f]{10}@invalid/g;
const TOKEN_EXACT = /^[0-9a-f]{10}@invalid$/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_SENTINEL = "000-00-0000";
const ADDR_MARK = "«ADDRESS»";
const SSN_MARK = "«SSN»";

function isRoutableHere(addr) {
	const at = String(addr).lastIndexOf("@");
	if (at < 0) return false;
	const d = String(addr).slice(at + 1).toLowerCase();
	// RFC 2606: .test .example .invalid and example.com|net|org. RFC 6761 adds
	// .localhost. Anything else could, in principle, be delivered.
	return !/\.(invalid|test|example|localhost)$/.test(d) && !/(^|\.)example\.(com|net|org)$/.test(d);
}

// ⚠️ THE SKELETON IS WHAT PROVES "REWRITTEN" RATHER THAN "BLANKED". Replace the
// routable addresses on the original and the substituted tokens on the artifact
// with the SAME constant; whatever is left must be byte-identical. A scrub that
// emptied the cell, re-serialised its JSON, reordered it, or swallowed the text
// around the address all fail this and only this.
const skelOriginal = (s) => String(s)
	.replace(ADDR_RE, (m) => (isRoutableHere(m) ? ADDR_MARK : m))
	.replace(SSN_RE, SSN_MARK);
const skelScrubbed = (s) => String(s)
	.replace(TOKEN_RE, ADDR_MARK)
	.replace(SSN_RE, SSN_MARK);

// The one place that reads a sanitized artifact and says what is wrong with it.
// Sections 5-8 assert these individually with their own [ok] lines; section 12
// re-uses the SAME function to grade every mutant, so a mutant can never be
// "caught" by a rule the real assertions do not also enforce.
function coreInvariants(db) {
	const bad = [];
	const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
	const g = (row, col) => (row && typeof row[col] === "string" ? row[col] : null);

	const body = g(one("SELECT body FROM messages WHERE id = 2"), "body");
	const prose = g(one("SELECT details FROM audit_trail WHERE id = 2"), "details");
	const jsonRow = g(one("SELECT details FROM audit_trail WHERE id = 3"), "details");
	const ssnRow = g(one("SELECT details FROM audit_trail WHERE id = 4"), "details");
	const caseRow = g(one("SELECT details FROM audit_trail WHERE id = 5"), "details");
	const refInfo = g(one("SELECT reference_info FROM job_applications WHERE id = 1"), "reference_info");
	const tokAgent = g(one("SELECT recipient FROM load_invoice_drafts WHERE id = 1"), "recipient");
	const tokBilling = g(one("SELECT recipient FROM load_invoice_drafts WHERE id = 2"), "recipient");

	for (const [label, got, orig] of [
		["messages.body", body, ORIG.body],
		["audit prose", prose, ORIG.prose],
		["audit json", jsonRow, ORIG.jsonRow],
		["audit ssn", ssnRow, ORIG.ssnRow],
		["audit case", caseRow, ORIG.caseRow],
		["reference_info", refInfo, ORIG.refInfo],
	]) {
		if (got === null) { bad.push(`missing:${label}`); continue; }
		if (skelScrubbed(got) !== skelOriginal(orig)) bad.push(`skeleton:${label}`);
		// Belt and braces: nothing routable may remain, whatever the skeleton says.
		if ((got.match(ADDR_RE) || []).some(isRoutableHere)) bad.push(`survivor:${label}`);
	}

	// -- the structured marker --------------------------------------------
	if (prose !== null) {
		if (!/\[PERIOD_FINALIZED\]/.test(prose)) bad.push("marker:code");
		if (!/\[PERIOD_[A-Z0-9_]+\][ \t]*periods=/.test(prose)) bad.push("marker:periods-adjacency");
		if (!/\[PERIOD_[A-Z0-9_]+\][ \t]*periods=2026-04,2026-05(?![\d-])/.test(prose)) bad.push("marker:periods-list");
		if (!/ — reason: broker asked to restate$/.test(prose)) bad.push("marker:reason-tail");
	}
	if (jsonRow !== null && !/\[PERIOD_FINALIZED\]$/.test(jsonRow)) bad.push("marker:json-suffix");
	// The purge exemption, run as the SQL purgeOldAuditRefusals() actually uses.
	try {
		const n = db.prepare("SELECT COUNT(*) c FROM audit_trail WHERE details LIKE '%[PERIOD\\_%' ESCAPE '\\'").get().c;
		if (n !== 2) bad.push(`marker:purge-exemption(${n})`);
	} catch { bad.push("marker:purge-exemption(unreadable)"); }
	// ...and no NEW one was forged by a token containing a bracket.
	try {
		const all = db.prepare("SELECT details FROM audit_trail").all()
			.map((r) => String(r.details || "")).join("\n");
		const n = (all.match(/\[PERIOD_/g) || []).length;
		if (n !== 2) bad.push(`marker:forged-or-lost(${n})`);
	} catch { bad.push("marker:forged-or-lost(unreadable)"); }

	// -- the JSON bodies ---------------------------------------------------
	if (refInfo !== null) {
		try {
			const parsed = JSON.parse(refInfo);
			if (!Array.isArray(parsed) || parsed.length !== 2) bad.push("json:reference_info-shape");
			else if (parsed[0].name !== "Dana Reference" || parsed[1].name !== "Lee Employer") bad.push("json:reference_info-keys");
			else if (parsed[0].phone !== FAKE.phone) bad.push("json:reference_info-phone");
			else if (!TOKEN_RE.test(String(parsed[0].relationship))) bad.push("json:reference_info-token");
		} catch { bad.push("json:reference_info-parse"); }
		TOKEN_RE.lastIndex = 0;
	}
	if (jsonRow !== null) {
		try {
			const cut = jsonRow.lastIndexOf("}");
			const parsed = JSON.parse(jsonRow.slice(0, cut + 1));
			if (parsed.outcome !== "blocked" || parsed.changed[0].column !== "Email") bad.push("json:audit-keys");
		} catch { bad.push("json:audit-parse"); }
	}

	// -- the token ---------------------------------------------------------
	if (tokAgent === null || tokBilling === null) bad.push("missing:load_invoice_drafts");
	else {
		if (!TOKEN_EXACT.test(tokAgent)) bad.push("token:shape");
		if (/[[\]"\\\s]/.test(tokAgent)) bad.push("token:unsafe-characters");
		if (tokAgent === tokBilling) bad.push("token:collision");
		// Same address in three different tables -> one token.
		if (prose !== null && !prose.includes(tokAgent)) bad.push("token:cross-table(audit)");
		if (body !== null && !body.includes(tokAgent)) bad.push("token:cross-table(messages)");
		// Two spellings differing only in case -> one token.
		if (caseRow !== null && !caseRow.includes(tokAgent)) bad.push("token:case-fold");
	}

	// -- the SSN sentinel --------------------------------------------------
	if (ssnRow !== null) {
		if (!ssnRow.includes(SSN_SENTINEL)) bad.push("ssn:not-neutralized");
		if (ssnRow.includes(FAKE.ssnA)) bad.push("ssn:survivor");
	}
	return bad;
}

// ---------------------------------------------------------------------------
// server.js's real refusal-detail parser, extracted rather than paraphrased —
// same idiom as scripts/test-purge-detail-marker.js. A regex in this file can
// only assert that the marker LOOKS intact; running the shipped reader is the
// only way to assert it is still READABLE.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ⚠️ THE META-ASSERTION: every column refresh-env.js claims to grade must be
// POPULATED in this fixture.
//
// collectLeaks() guards every single entry with has_(table, column) and simply
// `continue`s when the column is absent. A column this fixture never creates is
// therefore not passing — it is UNTESTED, and it prints nothing at all to say
// so. That is how the eight signing-evidence entries (signed_ip,
// signed_ip_source, signed_user_agent, consent_text on both onboarding tables)
// sat in the assertion list, covered by nothing, while this suite reported all
// checks passed. The same hole re-opens the next time a column is added there
// and not here — so the list is read out of refresh-env.js at runtime and
// compared against the snapshot, and a new entry fails THIS suite until it is
// seeded. Extraction failing is itself a failure, not a skip.
// ---------------------------------------------------------------------------
function extractPairs(src, name) {
	const anchor = `\nconst ${name} = [`;
	const hits = src.split(anchor).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 \`const ${name} = [\`, found ${hits}`);
	const start = src.indexOf(anchor) + 1;
	const end = src.indexOf("\n];", start);
	if (end < 0) throw new Error(`unterminated ${name}`);
	// Comment lines are dropped first: prose in this file quotes column names,
	// and a commented-out entry is not an entry.
	const body = src.slice(start, end).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const out = [];
	const re = /\[\s*"([^"]+)"\s*,\s*"([^"]+)"/g;
	let m;
	while ((m = re.exec(body))) out.push([m[1], m[2]]);
	return out;
}

function extractFn(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	let depth = 0;
	for (let j = src.indexOf("{", start); j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
	}
	throw new Error(`unbalanced braces extracting ${name}()`);
}

// ===========================================================================
(function run_all() {
	console.log(`sanitize-before-transfer — scratch root ${ROOT}\n`);

	// PREFLIGHT — say so plainly, before anything looks like a test result.
	// seedDatabase() require()s better-sqlite3 directly on its first line, so
	// without it this suite died on a raw MODULE_NOT_FOUND stack trace three
	// frames deep, which reads like a broken test rather than a missing install.
	// Exits non-zero on purpose: a suite that cannot run has not passed, and a
	// green exit here would let a CI box with no dependencies report success on
	// the assertions that prove PII never leaves the VPS.
	if (!NODE_MODULES) {
		console.log("CANNOT RUN — better-sqlite3 does not resolve from this checkout.");
		console.log("  Run `npm install` here, or in the parent checkout if this is a git worktree.");
		console.log("  Nothing was tested. This is a missing dependency, not a failing assertion.");
		fs.rmSync(ROOT, { recursive: true, force: true });
		process.exit(1);
	}

	// --- fixture -----------------------------------------------------------
	const vps = path.join(ROOT, "vps-backups");
	const laptop = path.join(ROOT, "laptop-checkout");
	const readDir = path.join(ROOT, "read");
	fs.mkdirSync(vps); fs.mkdirSync(laptop); fs.mkdirSync(readDir);

	const rawDb = path.join(vps, "app.db.20260809_020001");
	seedDatabase(rawDb);
	const snapshot = `${rawDb}.gz`;
	gzipTo(rawDb, snapshot);
	fs.unlinkSync(rawDb);
	console.log(`fixture: ${path.basename(snapshot)} (${(fs.statSync(snapshot).size / 1024).toFixed(0)} KiB gz), ${MUST_NOT_SURVIVE.length} planted secrets\n`);

	const GOOD_ENV = [
		"PORT=3011",
		"SPREADSHEET_ID=156Y5-OUUEZspiY7dRsJZ57iyKWLJAjdVP8a4yw0PMN0",
		"NODE_ENV=development",
	];
	writeEnv(laptop, GOOD_ENV);
	const target = path.join(laptop, "app.db");

	// =======================================================================
	section("1. The planted secrets are really in the snapshot");
	{
		const raw = gunzipToBuffer(snapshot).toString("latin1");
		const missing = MUST_NOT_SURVIVE.filter((s) => !raw.includes(s));
		check("every planted secret is present before sanitizing", missing.length === 0,
			missing.length ? `absent: ${missing.join(", ")}` : `${MUST_NOT_SURVIVE.length}/${MUST_NOT_SURVIVE.length} found`);
		check("…including the free-text ones, in the three columns production leaked from",
			raw.includes(bytes(ORIG.prose)) && raw.includes(bytes(ORIG.refInfo)) && raw.includes(bytes(FREE.agent)),
			"audit_trail.details, job_applications.reference_info, load_invoice_drafts.recipient");
		const v = run(["--verify", snapshot]);
		check("--verify calls the RAW snapshot unsanitized (the assertions can fail)", v.code === 1,
			v.code === 1 ? `exit 1, ${(v.out.match(/^ {11}\d+ /gm) || []).length} findings` : `exit ${v.code}`);

		// ⚠️ THE META-ASSERTION — see extractPairs(). Without it a column added to
		// refresh-env.js's grading lists is silently uncovered here, and reports
		// identically to a covered one.
		let claimed = null, why = "";
		try {
			const src = fs.readFileSync(SCRIPT, "utf8");
			claimed = [
				...extractPairs(src, "REDACTED_EMPTY"),
				...extractPairs(src, "REDACTED_LITERAL"),
				...extractPairs(src, "REDIRECTED_EMAIL"),
			];
		} catch (e) { why = e.message; }
		check("refresh-env.js's three grading lists were read out of its source", !!claimed && claimed.length >= 30,
			why || `${claimed ? claimed.length : 0} (table, column) pairs`);
		if (claimed) {
			const probe = openDb(gunzipToFile(snapshot, path.join(readDir, "snapshot.db")));
			const unpopulated = [];
			try {
				for (const [t, c] of claimed) {
					let n = 0;
					try { n = probe.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE COALESCE("${c}",'') <> ''`).get().c; }
					catch { n = -1; }   // table or column missing entirely
					if (n <= 0) unpopulated.push(`${t}.${c}${n < 0 ? " (absent)" : " (empty)"}`);
				}
			} finally { try { probe.close(); } catch {} }
			check("…and EVERY column they grade is actually populated in this fixture",
				unpopulated.length === 0,
				unpopulated.length ? `UNTESTED: ${unpopulated.join(", ")}` : `${claimed.length}/${claimed.length} covered`);
		}
	}

	// =======================================================================
	section("2. Gates still refuse — and refuse BEFORE anything is copied");
	{
		const ok = run(["--check-env-only", "--to", target]);
		check("passes on a correct non-production .env", ok.code === 0, `exit ${ok.code}`);

		writeEnv(laptop, ["PORT=3011", "SPREADSHEET_ID=1ey1n0AAG0k8k-qwkWh2T_C8VqqY129OQQr7D5wNl7Mo"]);
		const prodSheet = run(["--check-env-only", "--to", target]);
		check("refuses a PRODUCTION SPREADSHEET_ID", prodSheet.code === 1 && /PRODUCTION sheet/.test(prodSheet.out));

		writeEnv(laptop, ["PORT=3011"]);
		const noSheet = run(["--check-env-only", "--to", target]);
		check("refuses a MISSING SPREADSHEET_ID", noSheet.code === 1 && /no SPREADSHEET_ID/.test(noSheet.out));

		writeEnv(laptop, [...GOOD_ENV, "GMAIL_USER=info@logisx.com", "GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx"]);
		const mail = run(["--check-env-only", "--to", target]);
		check("refuses a mail-capable .env", mail.code === 1 && /GMAIL_USER and GMAIL_APP_PASSWORD/.test(mail.out));

		writeEnv(laptop, [...GOOD_ENV, "INVOICE_AUTOGEN_ENABLED=true"]);
		const money = run(["--check-env-only", "--to", target]);
		check("refuses INVOICE_AUTOGEN_ENABLED=true", money.code === 1 && /INVOICE_AUTOGEN_ENABLED=true/.test(money.out));

		// The property that makes ordering meaningful: check-env-only cannot read
		// or write a database at all, so a refusal is structurally incapable of
		// having moved data first.
		const before = fs.readdirSync(laptop).sort().join(",");
		writeEnv(laptop, GOOD_ENV);
		run(["--check-env-only", "--to", target]);
		check("check-env-only creates nothing", fs.readdirSync(laptop).sort().join(",") === before);
	}

	// =======================================================================
	section("3. Sanitize on the 'VPS' — module resolution via a symlink, as the flow does");
	let artifact;
	{
		const remoteTmp = path.join(ROOT, "vps-tmp");
		fs.mkdirSync(remoteTmp, { mode: 0o700 });
		// Exactly what refresh-local.sh does: ship the script, symlink the app's
		// node_modules beside it, run from there. This proves the resolution
		// mechanism, not just the sanitizing.
		fs.copyFileSync(SCRIPT, path.join(remoteTmp, "refresh-env.js"));

		// NODE_MODULES is resolved, not composed — see the comment on its
		// definition for why, and for the git-worktree caveat. The preflight has
		// already established that it is non-null, so a failure here is a real
		// symlink failure (EEXIST, EPERM, a read-only scratch dir) and is reported
		// as itself rather than swallowed into the misleading "run this from the
		// application directory" message the next check would otherwise print.
		try {
			fs.symlinkSync(NODE_MODULES, path.join(remoteTmp, "node_modules"), "dir");
		} catch (e) {
			console.log(`  [skip] no node_modules symlink — symlinking ${NODE_MODULES} failed: ${e.code || e.message}.`);
			console.log("         The next check will report \"better-sqlite3 not available\"; the cause is THIS, not a wrong working directory.");
		}
		artifact = path.join(remoteTmp, "sanitized.db.gz");

		// Invoked as the SHIPPED copy, from its own directory, with no NODE_PATH:
		// if the symlink mechanism did not work this exits non-zero on
		// "better-sqlite3 not available".
		const shipped = runScript(path.join(remoteTmp, "refresh-env.js"),
			["--sanitize-only", "--from", snapshot, "--emit", artifact, "--telemetry-days", "45"], remoteTmp);
		check("sanitize-only runs from a temp dir with only a node_modules symlink", shipped.code === 0,
			shipped.code === 0 ? "" : shipped.out.split("\n").slice(-4).join(" | "));
		check("an artifact was emitted", fs.existsSync(artifact),
			fs.existsSync(artifact) ? `${(fs.statSync(artifact).size / 1024).toFixed(0)} KiB gz` : "");
		if (fs.existsSync(artifact)) {
			check("artifact is mode 600", (fs.statSync(artifact).mode & 0o777) === 0o600,
				"0" + (fs.statSync(artifact).mode & 0o777).toString(8));
		}
		// ⚠️ A rewrite that no-ops is the failure mode stage 3h exists to remove,
		// and the summary line is the only place the run says how much it did.
		const m = /free text: (\d+) value\(s\) rewritten across (\d+) distinct address\(es\)/.exec(shipped.out);
		check("…and it reports rewriting the free text it was given", !!m && +m[1] >= 7 && +m[2] === 5,
			m ? `${m[1]} value(s) across ${m[2]} address(es)` : "no free-text summary line");
		const leftovers = fs.readdirSync(remoteTmp).filter((f) => /\.tmp$|\.partial$|-wal$|-shm$/.test(f));
		check("no working copy left behind on the 'VPS'", leftovers.length === 0, leftovers.join(", "));
	}

	// Every section below reads the artifact section 3 emitted. If it is not
	// there, stop and let the [FAIL] lines above be the last word — the previous
	// shape threw a raw ENOENT here, which scrolled the real explanation off the
	// screen and made a missing dependency look like a broken test.
	if (!fs.existsSync(artifact)) {
		console.log("\nNo artifact was emitted, so the remaining sections cannot run. See the failures above.");
		finish();
	}
	const artifactDb = gunzipToFile(artifact, path.join(readDir, "artifact.db"));

	// =======================================================================
	section("4. The bytes that would cross the network");
	{
		const raw = gunzipToBuffer(artifact).toString("latin1");
		const survivors = MUST_NOT_SURVIVE.filter((s) => raw.includes(s));
		check("ZERO planted SSN / EIN / routing / account / licence / address values survive",
			survivors.length === 0, survivors.length ? `SURVIVED: ${survivors.join(", ")}` : `0 of ${MUST_NOT_SURVIVE.length}`);

		// ⚠️ Independent of the planted list: any string of the shape at all — but
		// the redaction sentinel is SSN-SHAPED BY DESIGN (000 is an area number the
		// SSA has never issued), so "zero matches" would now be a check that fails
		// the moment the scrub succeeds. Assert the stronger property instead:
		// something SSN-shaped is there, and every one of them is the sentinel.
		const ssnShaped = raw.match(SSN_RE) || [];
		const notSentinel = [...new Set(ssnShaped.filter((s) => s !== SSN_SENTINEL))];
		check("every SSN-shaped string in the artifact is the redaction sentinel",
			ssnShaped.length > 0 && notSentinel.length === 0,
			notSentinel.length ? `UNEXPECTED: ${notSentinel.join(", ")}` : `${ssnShaped.length} match(es), all ${SSN_SENTINEL}`);

		// ⚠️ Principled, not a whitelist. The exemption is exactly the rule stage 3h
		// itself applies — a reserved name can never reach a human, so rewriting it
		// would buy nothing and cost idempotence — rather than a hardcoded pass for
		// one fixture domain.
		const mails = (raw.match(ADDR_RE) || []).filter(isRoutableHere);
		check("no routable address anywhere in the artifact, in any column",
			mails.length === 0, mails.length ? `${[...new Set(mails)].slice(0, 3).join(", ")}` : "0");
		const tokens = raw.match(TOKEN_RE) || [];
		check("…and the pseudonymised tokens are there in its place", tokens.length >= 7,
			`${tokens.length} token occurrence(s), ${new Set(tokens).size} distinct`);

		check("the old bearer token is gone", !raw.includes("live-bearer-token-must-be-regenerated"));
		check("production password hashes are gone", !raw.includes("productionhashthatmustnotsurvive"));

		// ⚠️ THE OTHER DIRECTION, and it is not padding. A sanitizer graded only on
		// what it removes passes perfectly by emptying the database, so what it must
		// KEEP has to be asserted too — otherwise "evidence_version and
		// artifact_sha256 are deliberately kept" is a sentence in a comment with
		// nothing behind it.
		const lost = MUST_SURVIVE.filter((s) => !raw.includes(s));
		check("the evidence columns refresh-env.js deliberately KEEPS are still there",
			lost.length === 0, lost.length ? `LOST: ${lost.join(", ")}` : "evidence_version, artifact_sha256");
	}

	// =======================================================================
	section("5. Stage 3h — free text is REWRITTEN in place, never blanked");
	{
		const db = openDb(artifactDb);
		try {
			const get = (sql) => { const r = db.prepare(sql).get(); return r && Object.values(r)[0]; };
			const body = get("SELECT body FROM messages WHERE id = 2");
			const refInfo = get("SELECT reference_info FROM job_applications WHERE id = 1");
			const draft = get("SELECT recipient FROM load_invoice_drafts WHERE id = 1");
			const reserved = get("SELECT body FROM messages WHERE id = 1");

			// ⚠️ THE ASSERTION THAT SEPARATES "REWRITTEN" FROM "GONE". Blanking the
			// cell passes every "the address is absent" check in section 4 and
			// destroys the row. Only the skeleton comparison rejects it.
			check("messages.body: the address changed and NOTHING else did",
				skelScrubbed(body) === skelOriginal(ORIG.body),
				skelScrubbed(body) === skelOriginal(ORIG.body) ? "byte-identical apart from the address" : JSON.stringify(String(body).slice(0, 90)));
			check("job_applications.reference_info: same — 6 real applicant referees leaked here",
				skelScrubbed(refInfo) === skelOriginal(ORIG.refInfo),
				skelScrubbed(refInfo) === skelOriginal(ORIG.refInfo) ? "" : JSON.stringify(String(refInfo).slice(0, 90)));
			check("load_invoice_drafts.recipient: a whole-value address became a whole-value token",
				TOKEN_EXACT.test(String(draft)), String(draft));

			// The scope limit, asserted so it stays deliberate: phone numbers in free
			// text are explicitly out of stage 3h's reach (a pattern loose enough to
			// catch them also matches 9-digit load ids), and this is the row that
			// would notice if that ever silently changed.
			check("a phone number inside the same JSON is deliberately untouched",
				String(refInfo).includes(FAKE.phone), FAKE.phone);

			// ⚠️ The reserved-domain case. This is what makes stage 3h idempotent and
			// keeps it from churning fixtures and documentation, so it is asserted
			// rather than assumed.
			check("an address on a RESERVED domain is left byte-identical",
				reserved === `Rate con is coming from ${FAKE.mailE} — watch for it.`, FAKE.mailE);

			// The SSN half, in a column no column-aware rule names.
			const ssnRow = get("SELECT details FROM audit_trail WHERE id = 4");
			check("a free-text SSN is neutralized to the sentinel, in place",
				String(ssnRow).includes(SSN_SENTINEL) && !String(ssnRow).includes(FAKE.ssnA) &&
				skelScrubbed(ssnRow) === skelOriginal(ORIG.ssnRow), String(ssnRow).slice(0, 70));
			// ⚠️ REGRESSION PIN. The sentinel is SSN-shaped, so before the sweep
			// learned to skip it the sanitizer wrote a value its own grader called a
			// leak: any database holding ONE free-text SSN refused forever, with no
			// way to fix it. Section 3 already proved the run succeeded; this names
			// the reason it is allowed to.
			check("…and the run did NOT refuse its own redaction sentinel",
				run(["--verify", artifact]).code === 0, "the sweep skips 000-00-0000, as it skips reserved domains");
		} finally { try { db.close(); } catch {} }
	}

	// =======================================================================
	section("6. The structured refusal markers survive the rewrite");
	{
		const db = openDb(artifactDb);
		try {
			const prose = db.prepare("SELECT details FROM audit_trail WHERE id = 2").get().details;
			const jsonRow = db.prepare("SELECT details FROM audit_trail WHERE id = 3").get().details;

			check("the audit prose row is byte-identical apart from the address",
				skelScrubbed(prose) === skelOriginal(ORIG.prose), skelScrubbed(prose) === skelOriginal(ORIG.prose) ? "" : prose);
			check("[PERIOD_FINALIZED] survives", /\[PERIOD_FINALIZED\]/.test(prose));
			// ⚠️ parsePeriodRefusalDetail() reads the month list ONLY from
			// /^[ \t]*periods=/ immediately after the closing bracket, so anything
			// inserted between them drops the months silently.
			check("…the `] periods=` adjacency the parser requires survives",
				/\[PERIOD_[A-Z0-9_]+\][ \t]*periods=2026-04,2026-05(?![\d-])/.test(prose));
			check("…and the ` — reason: ` tail survives", / — reason: broker asked to restate$/.test(prose));

			check("the JSON-bodied row keeps its marker OUTSIDE the JSON, where the builder puts it",
				/\}\s\[PERIOD_FINALIZED\]$/.test(jsonRow), jsonRow.slice(-30));
			check("…and its JSON body still parses", (() => {
				try { return JSON.parse(jsonRow.slice(0, jsonRow.lastIndexOf("}") + 1)).changed[0].column === "Email"; }
				catch { return false; }
			})());

			// The purge exemption, run as the SQL purgeOldAuditRefusals() uses.
			const exempt = db.prepare("SELECT COUNT(*) c FROM audit_trail WHERE details LIKE '%[PERIOD\\_%' ESCAPE '\\'").get().c;
			check("the 90-day purge exemption still matches both rows", exempt === 2, `${exempt} row(s)`);
			// ...and no token forged a new one (see mutant M2 — the token must carry
			// no "[" at all).
			const forged = (db.prepare("SELECT details FROM audit_trail").all()
				.map((r) => String(r.details || "")).join("\n").match(/\[PERIOD_/g) || []).length;
			check("…and no `[PERIOD_` was forged by a substituted token", forged === 2, `${forged} occurrence(s)`);

			// ⚠️ A regex here can only say the marker LOOKS intact. The shipped reader
			// is the only thing that can say it is still READABLE — extracted from
			// server.js so a change to that parser fails this run rather than going
			// quiet twenty thousand lines away.
			let parser = null, parseErr = "";
			try {
				const src = fs.readFileSync(SERVER, "utf8");
				parser = new Function(`${extractFn(src, "parsePeriodRefusalDetail")}\nreturn parsePeriodRefusalDetail;`)();
			} catch (e) { parseErr = e.message; }
			check("server.js's own parsePeriodRefusalDetail() was extracted", !!parser, parseErr);
			if (parser) {
				const p = parser(prose);
				check("…it still reads the code", p.code === "PERIOD_FINALIZED", p.code || "(none)");
				check("…it still reads BOTH months", JSON.stringify(p.periods) === '["2026-04","2026-05"]', JSON.stringify(p.periods));
				check("…it still reads the stated reason", p.note === "broker asked to restate", JSON.stringify(p.note));
				check("…and what was attempted no longer names a routable address",
					/^update of load 562620213 for [0-9a-f]{10}@invalid$/.test(p.attempted), p.attempted);
			}
		} finally { try { db.close(); } catch {} }
	}

	// =======================================================================
	section("7. One address, one token — stable across tables, folded across case");
	{
		const db = openDb(artifactDb);
		try {
			const g = (sql) => { const r = db.prepare(sql).get(); return r && String(Object.values(r)[0]); };
			// Read from a whole-value column, so which address a token stands for is
			// not a guess.
			const tokAgent = g("SELECT recipient FROM load_invoice_drafts WHERE id = 1");
			const tokBilling = g("SELECT recipient FROM load_invoice_drafts WHERE id = 2");
			const prose = g("SELECT details FROM audit_trail WHERE id = 2");
			const body = g("SELECT body FROM messages WHERE id = 2");
			const caseRow = g("SELECT details FROM audit_trail WHERE id = 5");
			const jsonRow = g("SELECT details FROM audit_trail WHERE id = 3");

			// ⚠️ The token is substituted into audit_trail.details, so its alphabet is
			// a correctness constraint: no "[" (which would forge or break the
			// [PERIOD_ purge exemption), no '"' or "\" (which would break the JSON
			// detail bodies), no whitespace (which would break the `] periods=`
			// adjacency). Hex satisfies all three by construction — asserted, not
			// assumed, because that is the whole argument for choosing hex.
			check("the token is exactly <10 hex>@invalid", TOKEN_EXACT.test(tokAgent), tokAgent);
			check("…and carries none of [ ] \" \\ or whitespace", !/[[\]"\\\s]/.test(tokAgent));

			// ⚠️ Per-RUN salt, not per-row: server.js writes one address into BOTH
			// load_invoice_drafts.recipient and the audit_trail row describing the
			// same draft, so anything that groups by recipient breaks if the two
			// disagree.
			check("the same address in load_invoice_drafts and audit_trail gets the SAME token",
				prose.includes(tokAgent), tokAgent);
			check("…and the same token again in messages.body, a third table",
				body.includes(tokAgent));
			check("two spellings differing only in case fold to one token",
				caseRow.includes(tokAgent), `${FREE.agentUpper} -> ${tokAgent}`);

			// The converse. Without it, a scrub that mapped every address to one
			// token would pass every check above and silently merge two people.
			const jsonToks = [...new Set(jsonRow.match(TOKEN_RE) || [])];
			check("distinct addresses get DISTINCT tokens (no collapse)",
				tokAgent !== tokBilling && jsonToks.length === 2 && !jsonToks.includes(tokAgent),
				`${new Set([tokAgent, tokBilling, ...jsonToks]).size} distinct across 4 addresses`);
		} finally { try { db.close(); } catch {} }
	}

	// =======================================================================
	section("8. Idempotence — sanitizing an already-sanitized artifact changes nothing");
	{
		// This is what isRoutableAddress() returning false for .invalid buys, and
		// it is not cosmetic: refresh-staging.sh and refresh-local.sh can both be
		// re-run, and a scrub that re-pseudonymised its own tokens would mint a new
		// identity for the same broker on every pass — quietly breaking any join or
		// grouping done on the previous run's output.
		const second = path.join(ROOT, "read", "second.db.gz");
		const r = run(["--sanitize-only", "--from", artifact, "--emit", second, "--telemetry-days", "45"]);
		check("a second sanitize pass over the artifact succeeds", r.code === 0,
			r.code === 0 ? "" : r.out.split("\n").slice(-3).join(" | "));
		check("…and reports rewriting NOTHING", /free text: 0 value\(s\) rewritten across 0 distinct address\(es\)/.test(r.out),
			(/free text: .*/.exec(r.out) || ["(no line)"])[0]);

		if (fs.existsSync(second)) {
			const a = openDb(artifactDb);
			const b = openDb(gunzipToFile(second, path.join(readDir, "second.db")));
			try {
				const cols = [
					["messages", "body", "id IN (1,2)"],
					["audit_trail", "details", "id IN (1,2,3,4,5)"],
					["job_applications", "reference_info", "id = 1"],
					["load_invoice_drafts", "recipient", "id IN (1,2)"],
				];
				const diffs = [];
				for (const [t, c, where] of cols) {
					const A = a.prepare(`SELECT "${c}" v FROM "${t}" WHERE ${where} ORDER BY id`).all().map((r2) => r2.v);
					const B = b.prepare(`SELECT "${c}" v FROM "${t}" WHERE ${where} ORDER BY id`).all().map((r2) => r2.v);
					if (JSON.stringify(A) !== JSON.stringify(B)) diffs.push(`${t}.${c}`);
				}
				check("every free-text value is byte-identical after the second pass", diffs.length === 0, diffs.join(", "));
				// Belt and braces: the invariants hold on the twice-sanitized file too.
				check("…and the twice-sanitized file still passes every core invariant",
					coreInvariants(b).length === 0, coreInvariants(b).join("; "));
			} finally { try { a.close(); } catch {} try { b.close(); } catch {} }
		}
	}

	// =======================================================================
	section("9. --verify agrees, and --strict-scan has nothing left to promote");
	{
		// ⚠️ THIS SECTION USED TO ASSERT THE OPPOSITE, and it was right to at the
		// time: the free-text sweep read columns nobody scrubbed, so a broker's
		// address in a message body was ordinary content rather than a leak, and it
		// was reported as an advisory with --strict-scan available to promote it.
		// Stage 3h scrubs that text now. A survivor therefore no longer means "we
		// found content we never promised to clean" — it means the scrubber ran and
		// did not work — so the tier is a hard refusal and there is nothing left for
		// --strict-scan to raise. The measured cost of the old arrangement was 21
		// third-party addresses shipping under a "clean" line.
		const v = run(["--verify", artifact]);
		check("--verify passes the artifact", v.code === 0, v.code === 0 ? "" : v.out.split("\n").slice(-3).join(" | "));
		check("…and says CLEAN rather than hedging with an advisory",
			/clean: no routable address/.test(v.out) && !/advisory finding/.test(v.out));
		check("…naming no free-text finding at all", !/free-text scan/.test(v.out) && !/value\(s\) matching/.test(v.out),
			(v.out.match(/value\(s\) matching/g) || []).length + " finding(s)");

		const s = run(["--verify", artifact, "--strict-scan"]);
		check("--strict-scan reports 0 findings and exits 0", s.code === 0 && !/value\(s\) matching/.test(s.out), `exit ${s.code}`);

		// The positive control. Without it every check above passes on a --verify
		// that has stopped looking at free text entirely.
		const rawScan = run(["--verify", snapshot]);
		const found = (rawScan.out.match(/value\(s\) matching/g) || []).length;
		check("CONTROL: the same sweep still finds free text in the UNSANITIZED snapshot",
			rawScan.code === 1 && found >= 3, `${found} free-text finding(s) on the raw file`);
	}

	// =======================================================================
	section("10. Install refuses a dirty artifact, accepts a clean one");
	{
		writeEnv(laptop, GOOD_ENV);
		// Feed the RAW snapshot to the install path pretending it is sanitized:
		// this is the "the remote pass silently did not run" scenario.
		const dirty = run(["--from", snapshot, "--to", target, "--from-sanitized", "--yes-non-prod"]);
		check("--from-sanitized REFUSES an unsanitized artifact", dirty.code === 1 && /NOT sanitized/.test(dirty.out));
		check("…and installs nothing", !fs.existsSync(target));

		const good = run(["--from", artifact, "--to", target, "--from-sanitized", "--yes-non-prod"]);
		check("--from-sanitized installs the clean artifact", good.code === 0,
			good.code === 0 ? "" : good.out.split("\n").slice(-3).join(" | "));
		check("app.db exists at the target", fs.existsSync(target),
			fs.existsSync(target) ? `${(fs.statSync(target).size / 1048576).toFixed(1)} MB` : "");
		const sidecars = fs.readdirSync(laptop).filter((f) => /-wal$|-shm$|\.tmp$/.test(f));
		check("no orphaned -wal / -shm / .tmp beside the installed database", sidecars.length === 0, sidecars.join(", "));

		const installed = run(["--verify", target]);
		check("the INSTALLED database verifies clean", installed.code === 0);
	}

	// =======================================================================
	section("11. The source/target gates");
	{
		const live = run(["--sanitize-only", "--from", "/var/www/logistics-app/app.db", "--emit", path.join(ROOT, "x.gz")]);
		check("refuses --from the LIVE production app.db", live.code === 1 && /LIVE production database/.test(live.out));

		const intoProd = run(["--sanitize-only", "--from", snapshot, "--emit", "/var/www/logistics-app/backups/x.gz"]);
		check("refuses --emit into the production application directory",
			intoProd.code === 1 && /production application directory/.test(intoProd.out));

		const same = run(["--sanitize-only", "--from", snapshot, "--emit", snapshot]);
		check("refuses --from and --emit being the same file", same.code === 1 && /same file/.test(same.out));
	}

	// =======================================================================
	section("12. Regression: the ORIGINAL one-pass path still works (refresh-staging.sh uses it)");
	{
		// Staging's source and target share a filesystem, so nothing crosses a
		// network and it keeps `--from <snapshot> --to <app.db>`. The gate
		// restructuring must not have touched it.
		const staging = path.join(ROOT, "staging");
		fs.mkdirSync(staging);
		writeEnv(staging, ["PORT=3003", "SPREADSHEET_ID=1Ny1q0nY-sYxgjH_4KqzEdWXUNp8etfW7M-G7h_MNA9Y", "NODE_ENV=development"]);
		const sTarget = path.join(staging, "app.db");

		const noOptIn = run(["--from", snapshot, "--to", sTarget]);
		check("still refuses without --yes-non-prod", noOptIn.code === 1 && /--yes-non-prod/.test(noOptIn.out));

		const prodDir = run(["--from", snapshot, "--to", "/var/www/logistics-app/app.db", "--yes-non-prod"]);
		check("still refuses --to the production application directory",
			prodDir.code === 1 && /production application directory/.test(prodDir.out));

		const r = run(["--from", snapshot, "--to", sTarget, "--yes-non-prod", "--telemetry-days", "45"]);
		check("one-pass sanitize+install succeeds", r.code === 0,
			r.code === 0 ? "" : r.out.split("\n").slice(-3).join(" | "));
		check("it sanitized (not just copied)", fs.existsSync(sTarget) && run(["--verify", sTarget]).code === 0);
		check("it reported the target sheet as non-production", /target sheet: 1Ny1q0nY/.test(r.out));
		// The one-pass path is the half NOBODY re-verifies by hand, so grade its
		// free text with the same invariants as the artifact.
		if (fs.existsSync(sTarget)) {
			const sdb = openDb(sTarget);
			try {
				const bad = coreInvariants(sdb);
				check("…and its free text passes every core invariant too", bad.length === 0, bad.join("; "));
			} finally { try { sdb.close(); } catch {} }
		}

		const dry = run(["--from", snapshot, "--to", sTarget, "--yes-non-prod", "--dry-run"]);
		check("--dry-run still leaves the target alone",
			dry.code === 0 && /work file discarded/.test(dry.out) &&
			fs.readdirSync(staging).filter((f) => /\.tmp$/.test(f)).length === 0);
	}

	// =======================================================================
	section("13. Mutants — every assertion above is required by at least one");
	{
		// Each mutant is a byte-edit of the SHIPPED refresh-env.js, executed as a
		// copy in its own directory, and graded by coreInvariants() — the same
		// function sections 5-8 use, so nothing can be "caught" by a rule the real
		// assertions do not also enforce.
		//
		// ⚠️ WHETHER THE MUTATION APPLIED IS ASSERTED SEPARATELY FROM WHETHER IT WAS
		// CAUGHT. A needle that no longer matches is a VACUOUS mutant, not a caught
		// one, and the usual try/catch shape cannot tell them apart — so one later
		// rename in refresh-env.js would silently turn every mutant below into a
		// permanently-passing no-op. (Same reasoning, same idiom, as
		// scripts/test-purge-detail-marker.js.)
		function mutant(id, label, mutate, expected) {
			const dir = path.join(ROOT, "mutants", id);
			fs.mkdirSync(dir, { recursive: true });
			const src = fs.readFileSync(SCRIPT, "utf8");
			let body = src, applyErr = "";
			try { body = mutate(src); } catch (e) { applyErr = e.message; }
			const applied = body !== src && !applyErr;
			check(`${id}: ${label} — actually mutated the shipped source`, applied,
				applied ? "" : applyErr || "the anchor no longer matches refresh-env.js");
			if (!applied) {
				check(`${id}: ${label} — is caught`, false, "not evaluated: the mutation did not apply");
				return;
			}
			const script = path.join(dir, "refresh-env.js");
			fs.writeFileSync(script, body);
			try { fs.symlinkSync(NODE_MODULES, path.join(dir, "node_modules"), "dir"); } catch {}
			const out = path.join(dir, "mutant.db.gz");
			const r = runScript(script, ["--sanitize-only", "--from", snapshot, "--emit", out, "--telemetry-days", "45"], dir);

			if (r.code !== 0 || !fs.existsSync(out)) {
				// A refusal IS a catch, and a stronger one: refresh-env.js's own
				// post-scrub assertions found the damage and emitted nothing at all.
				const why = (r.out.match(/^ {11}\S.*$/m) || [""])[0].trim();
				check(`${id}: ${label} — is caught`, true,
					`refresh-env.js refused its own output — ${why || "no artifact emitted"}`);
				return;
			}
			let bad = [];
			let db = null;
			try { db = openDb(gunzipToFile(out, path.join(dir, "mutant.db"))); bad = coreInvariants(db); }
			catch (e) { bad = [`unreadable:${e.message}`]; }
			finally { try { db && db.close(); } catch {} }
			// `expected` names the invariant family that MUST fire, so a mutant
			// cannot be graded as caught by an unrelated symptom.
			const hit = expected ? bad.some((b) => b.startsWith(expected)) : bad.length > 0;
			check(`${id}: ${label} — is caught`, bad.length > 0 && hit,
				bad.length === 0 ? "SURVIVED — the assertion protecting it is too weak"
					: `${bad.length} invariant(s): ${bad.slice(0, 4).join(", ")}`);
		}

		// -- M1a: the loose pattern the ⚠️ on ROUTABLE_EMAIL warns against -------
		// ⚠️ MEASURED, AND NOT WHAT THAT COMMENT PREDICTS. It says \S+ "would
		// swallow `agent@x.com [PERIOD_FINALIZED]` whole". It would not: \S never
		// matches a space and every writer of a refusal detail puts one before the
		// "[", so the marker is out of reach. What \S+ really eats is any structure
		// with no whitespace in it — the JSON audit body and reference_info are both
		// swallowed entire, quotes and braces included, and replaced by one token.
		// The bounded pattern is right; the reason written beside it is not the
		// demonstrable one, so the demonstrable one is pinned here instead.
		mutant("M1a", "a loose \\S+@\\S+\\.\\S+ pattern (shared constant)", (s) => {
			const out = s.replace(/const ROUTABLE_EMAIL = new RegExp\(String\.raw`[^`]*`\);/,
				"const ROUTABLE_EMAIL = new RegExp(String.raw`\\S+@\\S+\\.\\S+`);");
			if (out === s) throw new Error("ROUTABLE_EMAIL anchor not found");
			return out;
		}, "json:");

		// -- M1b: the character class that DOES span the marker ------------------
		// ⚠️ THE ONE THE BOUNDED PATTERN REALLY DEFENDS AGAINST — the same class of
		// bug as cityStateZip()'s [^,] swallowing a whole street: a class that
		// happens to match spaces and brackets. On the prose refusal it matches from
		// "for agent@…" straight through "[PERIOD_FINALIZED] periods=2026-04", so
		// ONE substitution destroys the code, the month list and the 90-day purge
		// exemption together.
		//
		// ⚠️ MUTATED AT THE USE SITE IN scrubValue(), NOT ON THE SHARED CONSTANT,
		// and the reason is itself a finding worth keeping: loosening the shared
		// ROUTABLE_EMAIL to [^,] is SELF-DETECTED — the grader uses the same
		// predicate, `[^,]+@[^,]+` then matches the sanitizer's own `<hex>@invalid`
		// output (isRoutableAddress only exempts a DOTTED reserved name), and
		// refresh-env.js refuses with 17 findings before emitting anything. That is
		// a real strength of defining the predicate once. It also means the shared
		// constant cannot express this mutant, so the use site does — which models
		// the actual regression risk: somebody writing the replace with an inline
		// pattern of their own.
		mutant("M1b", "a [^,] class at scrubValue's replace, spanning the marker", (s) => {
			const out = s.replace("v.replace(ROUTABLE_EMAIL_G,", "v.replace(/[^,]+@[^,]+/g,");
			if (out === s) throw new Error("scrubValue replace anchor not found");
			return out;
		}, "marker:");

		// -- M2: an unsafe token alphabet --------------------------------------
		// The token is substituted INTO audit_trail.details. A "[" in it is the
		// difference between a pseudonym and a forged purge exemption.
		mutant("M2", "a token that starts with '['", (s) => {
			const out = s.replace('tok = crypto.createHmac("sha256", salt)', 'tok = "[" + crypto.createHmac("sha256", salt)');
			if (out === s) throw new Error("pseudonym() token anchor not found");
			return out;
		}, "token:");

		// -- M3: a JSON round-trip instead of a substring replace ---------------
		// ⚠️ THE SUBTLEST OF THE FIVE. It looks tidier and it silently discards
		// everything outside the JSON body — which is exactly where
		// buildSheetUpdateAudit() puts the marker, deliberately, so that the
		// builder's truncation budget can never push it off the end. It also
		// re-serialises reference_info, losing the original spacing.
		mutant("M3", "a JSON parse/stringify round-trip in scrubValue", (s) => {
			const out = s.replace("const scrubValue = (v) => {",
				"const scrubValue = (v0) => { const v = (() => { const i = v0.lastIndexOf(\"}\"); "
				+ "if (i > 0) { try { return JSON.stringify(JSON.parse(v0.slice(0, i + 1))); } catch {} } return v0; })();");
			if (out === s) throw new Error("scrubValue anchor not found");
			return out;
		}, "marker:");

		// -- M4: the rewrite removed entirely ----------------------------------
		// The shipped-bug restoration: a sweep that runs, touches nothing, and lets
		// the run report success. refresh-env.js's own post-scrub assertions catch
		// this one first (which is the correct outcome, and worth proving) — section
		// 5's skeleton checks are the second line of defence if that tier is ever
		// relaxed again.
		mutant("M4", "scrubValue returns its input unchanged", (s) => {
			const out = s.replace("const scrubValue = (v) => {", "const scrubValue = (v) => { return v;");
			if (out === s) throw new Error("scrubValue anchor not found");
			return out;
		});

		// -- M5: a per-value salt instead of a per-run one ----------------------
		// Every token is still hex@invalid and every address is still gone, so
		// sections 4, 5 and 6 all pass. Only "one address, one token" notices — and
		// what it protects is real: server.js writes one address into both
		// load_invoice_drafts.recipient and the audit row describing that draft.
		mutant("M5", "a fresh salt per value (memoisation defeated)", (s) => {
			let out = s.replace("let tok = seen.get(key);", "let tok = null;");
			if (out === s) throw new Error("pseudonym() memo anchor not found");
			const out2 = out.replace('crypto.createHmac("sha256", salt)', 'crypto.createHmac("sha256", crypto.randomBytes(16))');
			if (out2 === out) throw new Error("pseudonym() salt anchor not found");
			return out2;
		}, "token:");

		// -- M6 / M7: the assertion lists must be a SUPERSET of the scrub ---------
		// ⚠️ These two do NOT test stage 3h. They test the thing that let stage 3h's
		// gap exist for as long as it did: a scrub step with no assertion behind it.
		// Until 2026-08-13 REDACTED_EMPTY was a strict SUBSET of what the scrub
		// writes — `dob`, `signature`, `signature_image`, `consent_text`,
		// `signed_ip_source` and every placeholder-replaced column (including four
		// personal HOME ADDRESS columns) were scrubbed and never verified.
		//
		// ⚠️ The free-text sweep is NOT a safety net for them, which is the whole
		// point: a home address and a date of birth are neither email- nor
		// SSN-shaped, so section 5 sails past them. Each mutant below disables one
		// real scrub assignment and must be caught by refresh-env.js REFUSING —
		// which only happens if the matching assertion list entry exists.
		// ⚠️ These two do NOT go through mutant(). That helper treats ANY non-zero
		// exit as a catch, which is right for a semantic mutation but would grade a
		// mutant that merely broke the SYNTAX as caught — a vacuous pass, and the
		// first draft of M6 was exactly that (its needle spanned two statements, so
		// deleting it left `{ ein_ssn: "", , { ein_ssn: …` and node refused to parse
		// the file at all). So: the replacement must still parse, and the refusal
		// must NAME the column, or the assertion protecting it is not the thing
		// doing the catching.
		function scrubMutant(id, label, from, to, expectRefusal) {
			const dir = path.join(ROOT, "mutants", id);
			fs.mkdirSync(dir, { recursive: true });
			const src = fs.readFileSync(SCRIPT, "utf8");
			const applied = src.includes(from);
			check(`${id}: ${label} — actually mutated the shipped source`, applied,
				applied ? "" : `scrub anchor not found: ${from}`);
			if (!applied) { check(`${id}: ${label} — is caught`, false, "not evaluated"); return; }
			const script = path.join(dir, "refresh-env.js");
			fs.writeFileSync(script, src.replace(from, to));
			try { fs.symlinkSync(NODE_MODULES, path.join(dir, "node_modules"), "dir"); } catch {}
			// The mutant must be a VALID program, or the run proves nothing.
			const parsed = require("child_process").spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
			check(`${id}: ${label} — the mutant still parses`, parsed.status === 0,
				parsed.status === 0 ? "" : "mutation broke the syntax — a crash is not a catch");
			if (parsed.status !== 0) { check(`${id}: ${label} — is caught`, false, "not evaluated"); return; }
			const out = path.join(dir, "mutant.db.gz");
			const r = runScript(script, ["--sanitize-only", "--from", snapshot, "--emit", out, "--telemetry-days", "45"], dir);
			const named = expectRefusal.test(r.out);
			check(`${id}: ${label} — is caught, by name`, r.code !== 0 && !fs.existsSync(out) && named,
				named ? `refused: ${(r.out.match(/^ {11}\S.*$/m) || [""])[0].trim()}`
					: `exit ${r.code}, artifact ${fs.existsSync(out) ? "EMITTED" : "absent"}, refusal did not name the column`);
		}
		// A personal home address, replaced with the "REDACTED" placeholder — the
		// only thing that can catch this is REDACTED_LITERAL, added 2026-08-13.
		scrubMutant("M6", "the investors.address scrub is dropped (REDACTED_LITERAL)",
			`setCols("investors", { ein_ssn: "", address: "REDACTED" })`,
			`setCols("investors", { ein_ssn: "" })`,
			/investor personal address\(s\) survived un-replaced in investors\.address/);
		// An emptied column — caught only by the REDACTED_EMPTY entry added the
		// same day. dob is the sharpest case: the API layer deliberately does NOT
		// mask it (routine for DOT eligibility review), so this refresh is the only
		// thing between a real date of birth and a developer's laptop.
		scrubMutant("M7", "the job_applications.dob scrub is dropped (REDACTED_EMPTY)",
			`ssn: "", dob: "", drivers_license: ""`,
			`ssn: "", drivers_license: ""`,
			/applicant date of birth\(s\) survived in job_applications\.dob/);
		// ⚠️ M8 is the 2026-08-13 HIGH finding, and the only mutant here whose
		// target the free-text sweep CANNOT see. A base64 photograph contains no
		// "@" and no ###-##-####, so if this column list stops covering
		// cdl_front, stage 3h does not compensate and no other check in this file
		// fires — REDACTED_EMPTY is the whole defence. ~30 MB of licence imagery
		// shipped under a "clean" line before this existed.
		scrubMutant("M8", "the job_applications.cdl_front scrub is dropped (the licence photo)",
			`cdl_front: "", cdl_back: ""`,
			`cdl_back: ""`,
			/driving licence photograph \(front\)\(s\) survived in job_applications\.cdl_front/);
		// The locality half of the same finding.
		scrubMutant("M9", "the drivers_directory locality scrub is dropped",
			`{ address: "REDACTED", city: "", state: "", zip: "" }`,
			`{ address: "REDACTED" }`,
			/driver home (city|state|ZIP)\(s\) survived in drivers_directory\./);
		// ⚠️ M10 proves the NUL fixture is load-bearing rather than merely
		// present. Removing the prefilter's blob-length clause makes SQLite's
		// LIKE/GLOB stop at the embedded NUL, so the scrub can no longer SEE that
		// row — while the JS grader still can. The result is the deadlock this
		// clause exists to prevent: a refusal naming a value the scrubber is
		// structurally unable to reach, identical on every re-run.
		scrubMutant("M10", "the prefilter's embedded-NUL clause is dropped",
			` OR length(CAST("${"$"}{c}" AS BLOB)) <> length("${"$"}{c}")`,
			``,
			/audit_trail\.details: \d+ value\(s\) matching/);
	}

	// =======================================================================
	finish();
})();
