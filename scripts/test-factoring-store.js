#!/usr/bin/env node
// lib/factoring-store.js: the per-load factoring marker and the checks around it.
//
//   §1 the schema: three tables, idempotent; a database without them reads as
//      "not factored"; a marker that can't be read throws (senders refuse)
//   §2 marking: every refusal (locked, a button draft in flight or maybe
//      drafted, the auto job working, an invoice already sent, a draft unless
//      confirmed not sent with a reason); the row and one audit row
//   §3 clearing: locked, a Triumph claim working, a button draft; a number a
//      claim held with no byte sent is voided
//   §4 "Handled in Triumph's process": allowed for any factored load whose claim
//      isn't working (or has none); a working claim counts only while its lease
//      is live; it locks the marker ('outside') and every later mark or clear is
//      refused
//   §5 the Draft Invoice button's checks and its in-flight row: the confirmation
//      refused whoever asks until assignment lines exist (NOA_UNCONFIGURED) and the
//      submit mode reads live (TRIUMPH_NOT_LIVE), and its own rules for when they do;
//      an invoice printed for a marker that has since changed (FACTORING_CHANGED);
//      the live preview's checks
//   §6 "Check Gmail" on a maybe-drafted row; the dashboard annotation
//   §7 the only writer of locked_at in this PR
//   §10 a marked load keeps its Load ID, and the refusal says the way through; the
//       marks cleared, and when
//   §9 the routes (lib/factoring-routes.js): the marking switch (never in a
//      replica); only listed accounts, never the shared login; "Handled in
//      Triumph's process" with every switch off; refusals audited with codes
//   §8 mutants: each rule above removed in turn, and a case catches it
//
// Made-up loads only (LD-TEST-*), in memory.
//   node scripts/test-factoring-store.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const STORE_FILE = path.join(ROOT, "lib", "factoring-store.js");
if (!fs.existsSync(STORE_FILE)) {
	console.log("FAIL  lib/factoring-store.js is missing: the marker and its checks don't exist");
	process.exit(1);
}
const STORE_SRC = fs.readFileSync(STORE_FILE, "utf8");
const ledger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const rules = require(path.join(ROOT, "lib", "auto-invoice-rules.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let pass = 0;
const failures = [];
function section(t) { console.log(`\n${t}`); }

// The store built from source text, so a mutant is the same text changed.
function loadStore(src) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", src)(mod, mod.exports, Module.createRequire(STORE_FILE));
	return mod.exports;
}

const T0 = "2026-11-03T15:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();
const ACTOR = { id: 7, username: "made-up-admin" };

function freshDb(S, { autoClaims = true } = {}) {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT,
		recipient_source TEXT, total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_at TEXT, created_by TEXT)`);
	if (autoClaims) ledger.ensureSchema(db);
	S.ensureSchema(db);
	return db;
}
const auditLog = () => {
	const rows = [];
	const fn = (action, details) => rows.push({ action, details });
	fn.rows = rows;
	return fn;
};
const marker = (db, k) => db.prepare("SELECT * FROM load_factoring WHERE load_key = ?").get(k);
const claimRow = (db, k) => db.prepare("SELECT * FROM triumph_submissions WHERE load_key = ?").get(k);
function putMarker(db, k, { factored = 1, locked = "", via = "" } = {}) {
	db.prepare(`INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, locked_at, locked_via, updated_at)
		VALUES (?, ?, ?, 'script', ?, ?, ?, ?)`).run(k, k.toUpperCase(), factored, T0, locked, via, T0);
}
function putClaim(db, k, { state, stage = "", invoiceId = "", leaseUntil = "", voidedAt = "" }) {
	db.prepare(`INSERT INTO triumph_submissions (load_key, load_id, state, first_seen_at, stage, invoice_id, lease_owner, lease_until, number_voided_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(k, k.toUpperCase(), state, T0, stage, invoiceId, leaseUntil ? "made-up-worker" : "", leaseUntil, voidedAt, T0);
}
function putInflight(db, k, { invoiceId = "11032026-7", state = "in_flight", startedAt = T0, path: p = "imap" } = {}) {
	db.prepare(`INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
		.run(k, k.toUpperCase(), invoiceId, p, state, startedAt, startedAt);
}
const putDraft = (db, loadId, via, invoiceId = "11022026-7") =>
	db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, created_at) VALUES (?, ?, ?, ?)").run(loadId, invoiceId, via, T0);
// A claim as the automatic job's send leaves it, at the stage it reached.
function putSentClaim(db, k, { state = "needs_attention", stage = "appending" } = {}) {
	ledger.insertClaim(db, { key: k, loadId: k.toUpperCase(), state, nowIso: T0 });
	db.prepare("UPDATE auto_invoice_claims SET delivery = 'send', stage = ?, sent_at = ? WHERE load_key = ?").run(stage, T0, k);
}

// Each group of checks takes a store and returns its failure lines; the real
// store must give none, and each mutant must make its group give one.
function checker() {
	const out = [];
	let n = 0;
	const eq = (a, e, label) => { n++; const A = JSON.stringify(a); const E = JSON.stringify(e); if (A !== E) out.push(`${label}\n      expected ${E}\n      actual   ${A}`); };
	const ok = (c, label) => eq(Boolean(c), true, label);
	return { eq, ok, out, count: () => n };
}

// ------------------------------------------------------------------ §1
function checkSchema(S) {
	const c = checker();
	const db = new Database(":memory:");
	c.eq(S.isFactored(db, "LD-TEST-0001"), false, "§1 no table: not factored");
	c.eq([...S.factoredKeys(db)], [], "§1 no table: no factored keys");
	S.ensureSchema(db);
	S.ensureSchema(db);
	const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
	c.eq(tables, ["invoice_draft_inflight", "load_factoring", "triumph_submissions"], "§1 three tables, and a second call changes nothing");
	const refuses = (sql, label) => { let threw = false; try { db.prepare(sql).run(); } catch { threw = true; } c.ok(threw, label); };
	refuses(`INSERT INTO load_factoring (load_key, factored, source, set_at, updated_at) VALUES ('x', 2, 'person', '${T0}', '${T0}')`, "§1 factored is 0 or 1");
	refuses(`INSERT INTO load_factoring (load_key, factored, source, set_at, updated_at) VALUES ('x', 1, 'sheet', '${T0}', '${T0}')`, "§1 the sheet is never a source");
	refuses(`INSERT INTO load_factoring (load_key, factored, source, set_at, locked_via, updated_at) VALUES ('x', 1, 'person', '${T0}', 'hand', '${T0}')`, "§1 locked_via is '', upload or outside");
	refuses(`INSERT INTO triumph_submissions (load_key, state, first_seen_at, updated_at) VALUES ('x', 'sent', '${T0}', '${T0}')`, "§1 a claim's state is one of the job's");
	refuses(`INSERT INTO triumph_submissions (load_key, state, first_seen_at, via, updated_at) VALUES ('x', 'queued', '${T0}', 'triumph-hand', '${T0}')`, "§1 no by-hand via");
	refuses(`INSERT INTO invoice_draft_inflight (load_key, invoice_id, path, state, started_at, updated_at) VALUES ('x', '1', 'smtp', 'in_flight', '${T0}', '${T0}')`, "§1 an in-flight row is imap or n8n");
	c.eq(S.isFactored(db, "LD-TEST-0001"), false, "§1 an empty table: not factored");
	putMarker(db, "ld-test-0001");
	putMarker(db, "ld-test-0002", { factored: 0 });
	c.eq([S.isFactored(db, "LD-TEST-0001"), S.isFactored(db, "#ld-test-0001 "), S.isFactored(db, "LD-TEST-0002"), S.isFactored(db, "")], [true, true, false, false],
		"§1 a row at 1 is factored (any spelling of the id); a row at 0 and no id are not");
	c.eq([...S.factoredKeys(db)], ["ld-test-0001"], "§1 factoredKeys() lists the rows at 1");
	const malformed = new Database(":memory:");
	malformed.exec("CREATE TABLE load_factoring (load_key TEXT PRIMARY KEY)");
	malformed.prepare("INSERT INTO load_factoring (load_key) VALUES ('ld-test-0001')").run();
	c.eq(S.isFactored(malformed, "LD-TEST-0001"), true, "§1 a row with no readable value counts as factored (fail closed)");
	let threw = false;
	try { S.factoredKeys(malformed); } catch { threw = true; }
	c.ok(threw, "§1 factoredKeys() on a marker without its column throws");
	const closed = new Database(":memory:");
	S.ensureSchema(closed);
	closed.close();
	threw = false;
	try { S.isFactored(closed, "LD-TEST-0001"); } catch { threw = true; }
	c.ok(threw, "§1 a marker that can't be read throws, never answers false");
	const view = new Database(":memory:");
	view.exec("CREATE TABLE made_up_gone (load_key TEXT); CREATE VIEW load_factoring AS SELECT load_key, 1 AS factored FROM made_up_gone; DROP TABLE made_up_gone");
	threw = false;
	try { S.isFactored(view, "LD-TEST-0001"); } catch { threw = true; }
	c.ok(threw, "§1 a view of that name that can't be read throws too, never reads as no marker");
	return c;
}

// ------------------------------------------------------------------ §2
function checkMark(S) {
	const c = checker();
	const db = freshDb(S);
	const mark = (k, extra = {}) => { const a = auditLog(); const r = S.mark(db, { key: k, loadId: k.toUpperCase(), reason: "made-up reason", actor: ACTOR, nowIso: at(1), audit: a, ...extra }); return { r, a: a.rows }; };
	let x = mark("ld-test-0001");
	c.eq([x.r.ok, x.r.changed, marker(db, "ld-test-0001").factored, marker(db, "ld-test-0001").source, marker(db, "ld-test-0001").set_by_id], [true, true, 1, "person", 7], "§2 a mark writes the row (factored 1, by the person)");
	c.eq(x.a.map((r) => r.action), ["factoring_marked"], "§2 ...with one factoring_marked audit row");
	c.ok(x.a[0].details.includes("made-up reason"), "§2 ...that carries the reason");
	x = mark("ld-test-0001");
	c.eq([x.r.ok, x.r.changed, x.a.length], [true, false, 0], "§2 marking a factored load again changes nothing and audits nothing");

	putMarker(db, "ld-test-0002", { factored: 1, locked: T0, via: "outside" });
	c.eq(mark("ld-test-0002").r.code, "FACTORING_LOCKED", "§2 a locked row: FACTORING_LOCKED");
	putMarker(db, "ld-test-0003", { factored: 0, locked: T0, via: "outside" });
	c.eq(mark("ld-test-0003").r.code, "FACTORING_LOCKED", "§2 a row locked at 0 is still refused");

	putInflight(db, "ld-test-0004", { startedAt: at(0) });
	c.eq(mark("ld-test-0004").r.code, "INVOICE_DRAFT_IN_FLIGHT", "§2 a button draft in flight: INVOICE_DRAFT_IN_FLIGHT");
	putInflight(db, "ld-test-0005", { state: "maybe_drafted" });
	x = mark("ld-test-0005");
	c.eq([x.r.code, x.r.invoiceId], ["INVOICE_MAYBE_DRAFTED", "11032026-7"], "§2 a maybe-drafted button draft: INVOICE_MAYBE_DRAFTED, naming its number");
	putInflight(db, "ld-test-0006", { startedAt: at(-20) });
	c.eq(mark("ld-test-0006").r.code, "INVOICE_MAYBE_DRAFTED", "§2 an in-flight row 15 minutes old reads maybe drafted");

	ledger.insertClaim(db, { key: "ld-test-0007", loadId: "LD-TEST-0007", state: "working", nowIso: T0 });
	c.eq(mark("ld-test-0007").r.code, "AUTO_INVOICE_IN_FLIGHT", "§2 the auto job holds the load: AUTO_INVOICE_IN_FLIGHT");

	putDraft(db, "LD-TEST-0008", "auto-smtp");
	c.eq(mark("ld-test-0008", { confirmNotSent: true }).r.code, "INVOICE_ALREADY_SENT", "§2 the job sent the invoice: INVOICE_ALREADY_SENT, with no override");

	// Marked after a send: the job's record alone says so, whatever the person says,
	// at every stage of the send and on a dry run too. The mark can't undo the email.
	const saysNotSent = { confirmNotSent: true, reason: "made-up: says it never went" };
	putSentClaim(db, "ld-test-0030", { state: "drafted", stage: "recorded" });
	putDraft(db, "LD-TEST-0030", "auto-smtp");
	x = mark("ld-test-0030", saysNotSent);
	c.eq([x.r.ok, x.r.http, x.r.code, x.r.error, x.a, marker(db, "ld-test-0030")], [false, 409, "INVOICE_ALREADY_SENT", S.WORDS.INVOICE_ALREADY_SENT, [], undefined],
		"§2 marked after a send: 409 INVOICE_ALREADY_SENT, no row and no audit row, though the person says it never went");
	for (const [n, stage, state] of [[31, "appending", "needs_attention"], [32, "appended", "needs_attention"], [33, "recorded", "drafted"]]) {
		const k = `ld-test-00${n}`;
		putSentClaim(db, k, { state, stage });
		c.eq([mark(k).r.code, mark(k, saysNotSent).r.code, marker(db, k)], ["INVOICE_ALREADY_SENT", "INVOICE_ALREADY_SENT", undefined], `§2 a send at stage ${stage}, no draft row yet: INVOICE_ALREADY_SENT, no row`);
	}
	c.eq([mark("ld-test-0030", { dryRun: true }).r.code, mark("ld-test-0031", { dryRun: true }).r.code, marker(db, "ld-test-0031")], ["INVOICE_ALREADY_SENT", "INVOICE_ALREADY_SENT", undefined],
		"§2 ...the dry run gives the same answer, on the draft row and on the job's record alone");

	// The job's message may be in Gmail with no draft row yet, and a person may have sent it from
	// there: the mark asks first, as it does on a draft row.
	for (const [n, code, stage] of [[40, "MAYBE_IN_GMAIL", "appending"], [41, "IN_GMAIL_UNRECORDED", "appended"]]) {
		const k = `ld-test-00${n}`;
		ledger.insertClaim(db, { key: k, loadId: k.toUpperCase(), state: "needs_attention", code, nowIso: T0 });
		db.prepare("UPDATE auto_invoice_claims SET stage = ? WHERE load_key = ?").run(stage, k);
		x = mark(k);
		c.eq([x.r.ok, x.r.http, x.r.code, x.a, marker(db, k)], [false, 409, "INVOICE_MAYBE_IN_GMAIL", [], undefined], `§2 ${code}: the mark asks first, 409 INVOICE_MAYBE_IN_GMAIL, no row`);
		c.ok(x.r.error && /may be in Gmail/.test(x.r.error) && x.r.error === S.WORDS.INVOICE_MAYBE_IN_GMAIL, `§2 ...${code}: in its own words`);
		c.eq([mark(k, { confirmNotSent: true, reason: "  " }).r.code, mark(k, { dryRun: true }).r.code, marker(db, k)], ["INVOICE_MAYBE_IN_GMAIL", "INVOICE_MAYBE_IN_GMAIL", undefined], `§2 ...${code}: "not sent" needs a reason, and the dry run gives the same answer`);
		x = mark(k, { confirmNotSent: true });
		c.eq([x.r.ok, marker(db, k) && marker(db, k).factored], [true, 1], `§2 ...${code}: "not sent" with a reason marks it`);
		c.ok(x.a[0] && x.a[0].details.includes("may be in Gmail, confirmed not sent"), `§2 ...${code}: and the audit row says so`);
	}
	// A claim that never reached Gmail asks nothing, and a draft row keeps its own question.
	ledger.insertClaim(db, { key: "ld-test-0042", loadId: "LD-TEST-0042", state: "needs_attention", code: "TOTAL_MISMATCH", nowIso: T0 });
	c.eq(mark("ld-test-0042").r.ok, true, "§2 a claim that never reached Gmail: marked with no question");

	putDraft(db, "#LD-TEST-0009", "imap");
	x = mark("ld-test-0009");
	c.eq([x.r.code, x.r.drafts], ["INVOICE_ALREADY_DRAFTED", ["11022026-7"]], "§2 any draft row (either spelling): INVOICE_ALREADY_DRAFTED");
	c.eq(mark("ld-test-0009", { confirmNotSent: true, reason: "  " }).r.code, "INVOICE_ALREADY_DRAFTED", "§2 'not sent' without a reason is refused");
	x = mark("ld-test-0009", { confirmNotSent: true });
	c.eq([x.r.ok, marker(db, "ld-test-0009").factored], [true, 1], "§2 'the draft was not sent' with a reason marks it");
	c.ok(x.a[0].details.includes("11022026-7 confirmed not sent (delete in Gmail)"), "§2 ...and the audit row says so");
	c.eq([2, 3, 4, 5, 6, 7, 8].map((n) => marker(db, `ld-test-000${n}`) ? marker(db, `ld-test-000${n}`).factored : null), [1, 0, null, null, null, null, null],
		"§2 no refused mark wrote a row");
	return c;
}

// ------------------------------------------------------------------ §3
function checkClear(S) {
	const c = checker();
	const db = freshDb(S);
	const clear = (k) => { const a = auditLog(); const r = S.clear(db, { key: k, reason: "made-up reason", actor: ACTOR, nowIso: at(1), audit: a }); return { r, a: a.rows }; };
	putMarker(db, "ld-test-0001");
	let x = clear("ld-test-0001");
	c.eq([x.r.ok, marker(db, "ld-test-0001").factored, x.a.map((r) => r.action)], [true, 0, ["factoring_cleared"]], "§3 a clear writes 0 and one audit row");
	putMarker(db, "ld-test-0002", { locked: T0, via: "upload" });
	c.eq(clear("ld-test-0002").r.code, "FACTORING_LOCKED", "§3 a locked row: FACTORING_LOCKED");
	putMarker(db, "ld-test-0003");
	putClaim(db, "ld-test-0003", { state: "working", stage: "built", invoiceId: "11032026-3", leaseUntil: at(10) });
	c.eq(clear("ld-test-0003").r.code, "TRIUMPH_IN_FLIGHT", "§3 a Triumph claim working: TRIUMPH_IN_FLIGHT");
	putMarker(db, "ld-test-0004");
	putInflight(db, "ld-test-0004", { startedAt: at(0) });
	c.eq(clear("ld-test-0004").r.code, "INVOICE_DRAFT_IN_FLIGHT", "§3 a button draft in flight: refused");
	putMarker(db, "ld-test-0005");
	putClaim(db, "ld-test-0005", { state: "staged", stage: "built", invoiceId: "11032026-5" });
	x = clear("ld-test-0005");
	c.eq([x.r.voided, claimRow(db, "ld-test-0005").number_voided_at, x.a.map((r) => r.action)], ["11032026-5", at(1), ["triumph_number_void", "factoring_cleared"]],
		"§3 a staged number is voided, with one triumph_number_void row");
	putMarker(db, "ld-test-0006");
	putClaim(db, "ld-test-0006", { state: "needs_attention", stage: "pdf_uploading", invoiceId: "11032026-6" });
	x = clear("ld-test-0006");
	c.eq([claimRow(db, "ld-test-0006").number_voided_at, x.a.map((r) => r.action)], ["", ["factoring_cleared"]], "§3 a number past pdf_uploading is never voided");
	return c;
}

// ------------------------------------------------------------------ §4
function checkOutside(S) {
	const c = checker();
	const db = freshDb(S);
	const record = (k, extra = {}) => { const a = auditLog(); const r = S.handledOutside(db, { key: k, reason: "made-up: handled in Triumph's portal", actor: ACTOR, nowIso: at(30), audit: a, ...extra }); return { r, a: a.rows }; };
	const lockedOutside = (k) => { const m = marker(db, k); return Boolean(m && m.locked_at === at(30) && m.locked_via === "outside"); };
	let i = 0;
	for (const [state, stage, num] of [["queued", "", ""], ["waiting", "reserved", "11032026-11"], ["staged", "built", "11032026-12"], ["needs_attention", "built", "11032026-13"]]) {
		const k = `ld-test-001${i++}`;
		putMarker(db, k);
		putClaim(db, k, { state, stage, invoiceId: num });
		const x = record(k);
		c.ok(x.r.ok && lockedOutside(k), `§4 allowed for a ${state} claim, and the marker is locked 'outside'`);
		c.eq(claimRow(db, k).state, "closed_outside", `§4 ...the ${state} claim is closed outside`);
		c.eq(x.a.map((r) => r.action), num ? ["triumph_number_void", "triumph_handled_outside"] : ["triumph_handled_outside"], `§4 ...its held number (if any) voided with one row (${state})`);
	}
	putMarker(db, "ld-test-0020");
	let x = record("ld-test-0020");
	c.ok(x.r.ok && lockedOutside("ld-test-0020"), "§4 allowed for a factored load with no claim");
	c.eq(claimRow(db, "ld-test-0020"), undefined, "§4 ...and no claim row is written");
	c.ok(x.a[0].details.includes("claim none"), "§4 ...its audit row says there was no claim");

	putMarker(db, "ld-test-0021");
	putClaim(db, "ld-test-0021", { state: "working", stage: "built", invoiceId: "11032026-21", leaseUntil: at(31) });
	c.eq(record("ld-test-0021").r.code, "TRIUMPH_IN_FLIGHT", "§4 a working claim with a live lease: TRIUMPH_IN_FLIGHT");
	c.eq(marker(db, "ld-test-0021").locked_at, "", "§4 ...and nothing is locked");
	putMarker(db, "ld-test-0022");
	putClaim(db, "ld-test-0022", { state: "working", stage: "built", invoiceId: "11032026-22", leaseUntil: at(29) });
	x = record("ld-test-0022");
	c.ok(x.r.ok && lockedOutside("ld-test-0022"), "§4 a working claim left by a restart (lease expired, submit off): recorded and locked");
	c.eq([claimRow(db, "ld-test-0022").state, claimRow(db, "ld-test-0022").number_voided_at, x.r.voided], ["closed_outside", at(30), "11032026-22"],
		"§4 ...its claim closed and its number (no byte sent) voided");

	c.eq(record("ld-test-0099").r.code, "NOT_FACTORED", "§4 no row: NOT_FACTORED");
	putMarker(db, "ld-test-0023", { factored: 0 });
	c.eq(record("ld-test-0023").r.code, "NOT_FACTORED", "§4 a row at 0: NOT_FACTORED");
	putMarker(db, "ld-test-0024", { locked: T0, via: "upload" });
	c.eq(record("ld-test-0024").r.code, "FACTORING_LOCKED", "§4 a row already locked: FACTORING_LOCKED");
	putMarker(db, "ld-test-0025");
	putInflight(db, "ld-test-0025", { startedAt: at(29) });
	c.eq(record("ld-test-0025").r.code, "INVOICE_DRAFT_IN_FLIGHT", "§4 a button draft in flight: refused");
	putMarker(db, "ld-test-0026");
	putInflight(db, "ld-test-0026", { state: "maybe_drafted" });
	c.eq(record("ld-test-0026").r.code, "INVOICE_MAYBE_DRAFTED", "§4 a maybe-drafted button draft: refused");
	putMarker(db, "ld-test-0027");
	c.eq(record("ld-test-0027", { reason: " \u0007 " }).r.code, "FACTORING_REASON_REQUIRED", "§4 a reason is required");

	const after = (fn) => fn(db, { key: "ld-test-0020", reason: "made-up", actor: ACTOR, nowIso: at(40), audit: () => {} }).code;
	c.eq([after(S.clear), after(S.mark), after(S.handledOutside)], ["FACTORING_LOCKED", "FACTORING_LOCKED", "FACTORING_LOCKED"], "§4 after it, a clear, a mark and a second record answer FACTORING_LOCKED");
	putMarker(db, "ld-test-0028");
	S.clear(db, { key: "ld-test-0028", actor: ACTOR, nowIso: at(1), audit: () => {} });
	c.eq(record("ld-test-0028").r.code, "NOT_FACTORED", "§4 a clear, then the record: refused at the record (NOT_FACTORED)");
	c.eq(S.isFactored(db, "ld-test-0020"), true, "§4 a load handled outside stays factored for good (the senders keep skipping it)");
	return c;
}

// ------------------------------------------------------------------ §5
function checkButton(S) {
	const c = checker();
	const db = freshDb(S);
	const early = (k, extra = {}) => S.draftEarlyCheck(db, { key: k, nowIso: at(1), ...extra });
	const yes = { confirmFactored: true, reason: "made-up: Triumph asked for a copy" };
	// As if assignment lines existed and the mode read live: the confirmation's own rules, for when they do.
	const lines = { hasAssignmentLines: true, live: true };
	c.eq(early("ld-test-0001"), { ok: true, factored: false, confirmed: false, reason: "" }, "§5 a load with no marker passes, unconfirmed");
	c.eq(early("ld-test-0001", { confirm: yes, mayConfirm: true }), { ok: true, factored: false, confirmed: false, reason: "" }, "§5 ...and a confirmation sent for it carries no weight");
	putMarker(db, "ld-test-0002");
	c.eq(early("ld-test-0002").code, "LOAD_FACTORED", "§5 a factored load: LOAD_FACTORED");
	c.eq(early("ld-test-0002").error, S.WORDS.LOAD_FACTORED, "§5 ...in its usual words, with no draft out");
	// Where an invoice may already be out, the refusal doesn't say it goes through Triumph.
	putMarker(db, "ld-test-0030");
	putDraft(db, "LD-TEST-0030", "auto-imap");
	putMarker(db, "ld-test-0031");
	ledger.insertClaim(db, { key: "ld-test-0031", loadId: "LD-TEST-0031", state: "needs_attention", code: "MAYBE_IN_GMAIL", nowIso: T0 });
	db.prepare("UPDATE auto_invoice_claims SET stage = 'appending' WHERE load_key = 'ld-test-0031'").run();
	for (const [label, k] of [["a draft row", "ld-test-0030"], ["a draft that may be in Gmail", "ld-test-0031"]]) {
		const r = early(k);
		c.eq([r.ok, r.http, r.code], [false, 409, "LOAD_FACTORED"], `§5 a factored load with ${label}: still LOAD_FACTORED`);
		c.ok(r.error && r.error !== S.WORDS.LOAD_FACTORED && !/through Triumph/.test(r.error) && /Gmail Drafts and Sent Mail/.test(r.error), `§5 ...${label}: its words send a person to Gmail, and don't say it goes through Triumph`);
	}
	c.eq(early("ld-test-0002", { confirm: { confirmFactored: "true", reason: "x" }, mayConfirm: true }).code, "LOAD_FACTORED", "§5 only a real true confirms");
	for (const [label, extra] of [
		["a listed account", { confirm: yes, mayConfirm: true }],
		["an account not listed", { confirm: yes }],
		["a listed account with no reason", { confirm: { confirmFactored: true, reason: "" }, mayConfirm: true }],
	]) {
		const r = early("ld-test-0002", extra);
		c.eq([r.ok, r.http, r.code], [false, 409, "NOA_UNCONFIGURED"], `§5 no assignment lines, ${label}: 409 NOA_UNCONFIGURED, whoever asks`);
		c.ok(/can't put Triumph's assignment on an invoice/.test(r.error), `§5 ...in its own words (${label})`);
	}
	for (const v of [undefined, false, "true", 1, ["made-up line"], {}, null]) {
		c.eq(early("ld-test-0002", { confirm: yes, mayConfirm: true, hasAssignmentLines: v, live: true }).code, "NOA_UNCONFIGURED", `§5 only a real true says the lines exist (${JSON.stringify(v)})`);
	}
	// Setting the lines opens nothing: before Triumph is live, a draft would tell the broker to pay a party holding nothing.
	for (const [label, extra] of [
		["a listed account", { confirm: yes, mayConfirm: true }],
		["an account not listed", { confirm: yes }],
		["a listed account with no reason", { confirm: { confirmFactored: true, reason: "" }, mayConfirm: true }],
	]) {
		const r = early("ld-test-0002", { ...extra, hasAssignmentLines: true });
		c.eq([r.ok, r.http, r.code], [false, 409, "TRIUMPH_NOT_LIVE"], `§5 FAILS ON THE OLD CODE: the lines set, not live, ${label}: 409 TRIUMPH_NOT_LIVE, whoever asks`);
		c.eq(r.error, S.WORDS.TRIUMPH_NOT_LIVE, `§5 ...in its own words (${label})`);
	}
	c.ok(/clear the mark/.test(S.WORDS.TRIUMPH_NOT_LIVE), "§5 ...which name the way out: the clear, then the plain button");
	for (const v of [undefined, false, "true", "live", 1, {}, null]) {
		c.eq(early("ld-test-0002", { confirm: yes, mayConfirm: true, hasAssignmentLines: true, live: v }).code, "TRIUMPH_NOT_LIVE", `§5 only a real true says it's live (${JSON.stringify(v)})`);
	}
	c.eq(early("ld-test-0002", { confirm: yes, mayConfirm: true, live: true }).code, "NOA_UNCONFIGURED", "§5 live with no lines: NOA_UNCONFIGURED");
	c.eq(early("ld-test-0001", { confirm: yes, mayConfirm: true, hasAssignmentLines: true }), { ok: true, factored: false, confirmed: false, reason: "" }, "§5 not live, a load that isn't factored passes as it always has");
	c.eq(early("ld-test-0002", lines).code, "LOAD_FACTORED", "§5 with the lines, a plain press is still LOAD_FACTORED");
	c.eq(early("ld-test-0002", { confirm: yes, ...lines }).code, "FACTORING_NOT_LISTED", "§5 with the lines, the confirmation from an account not listed: FACTORING_NOT_LISTED");
	c.eq(early("ld-test-0002", { confirm: { confirmFactored: true, reason: "" }, mayConfirm: true, ...lines }).code, "FACTORING_REASON_REQUIRED", "§5 with the lines, the confirmation without a reason is refused");
	c.eq(early("ld-test-0002", { confirm: yes, mayConfirm: true, ...lines }), { ok: true, factored: true, confirmed: true, reason: yes.reason }, "§5 with the lines, a listed account's confirmation with a reason passes");
	putMarker(db, "ld-test-0003", { factored: 0, locked: T0, via: "outside" });
	c.eq(early("ld-test-0003").code, "FACTORING_LOCKED", "§5 a row locked at 0 is refused first");
	putMarker(db, "ld-test-0004", { locked: T0, via: "outside" });
	c.eq([early("ld-test-0004", { confirm: yes, mayConfirm: true }).code, early("ld-test-0004", { confirm: yes, mayConfirm: true, ...lines }).code], ["FACTORING_LOCKED", "FACTORING_LOCKED"], "§5 the confirmation on a locked row: FACTORING_LOCKED, with or without the lines");
	let i = 5;
	for (const [label, claim] of [
		["working", { state: "working", leaseUntil: at(10) }],
		["waiting with a reserved number", { state: "waiting", stage: "reserved", invoiceId: "11032026-50" }],
		["staged", { state: "staged", stage: "built", invoiceId: "11032026-51" }],
		["in Needs attention with a number", { state: "needs_attention", stage: "built", invoiceId: "11032026-52" }],
	]) {
		const k = `ld-test-000${i++}`;
		putMarker(db, k);
		putClaim(db, k, claim);
		c.eq(early(k, { confirm: yes, mayConfirm: true, ...lines }).code, "TRIUMPH_IN_FLIGHT", `§5 with the lines, the confirmation while a Triumph claim is ${label}: TRIUMPH_IN_FLIGHT`);
	}
	putMarker(db, "ld-test-0010");
	putClaim(db, "ld-test-0010", { state: "needs_attention", stage: "built", invoiceId: "11032026-53", voidedAt: T0 });
	c.eq(early("ld-test-0010", { confirm: yes, mayConfirm: true, ...lines }).ok, true, "§5 with the lines, a claim whose number was voided holds nothing");
	putInflight(db, "ld-test-0011", { startedAt: at(0) });
	c.eq(early("ld-test-0011").code, "INVOICE_DRAFT_IN_FLIGHT", "§5 a second press while a draft is in flight: INVOICE_DRAFT_IN_FLIGHT");
	putInflight(db, "ld-test-0012", { state: "maybe_drafted" });
	c.eq(early("ld-test-0012").code, "INVOICE_MAYBE_DRAFTED", "§5 a press while one may be in Gmail: INVOICE_MAYBE_DRAFTED");
	c.ok(early("ld-test-0012").error.includes("invoice #11032026-7") && early("ld-test-0012").error.includes("'Check Gmail'"), "§5 ...worded with its number and 'Check Gmail'");
	const broken = new Database(":memory:");
	S.ensureSchema(broken);
	broken.close();
	c.eq(S.draftEarlyCheck(broken, { key: "ld-test-0001", nowIso: at(1) }).code, "FACTORING_UNREADABLE", "§5 a marker that can't be read refuses (503)");

	// The live preview sends nothing: the marker's checks alone, so a draft in flight doesn't refuse it.
	const previewOn = (d, k, extra = {}) => (S.previewCheck ? S.previewCheck(d, { key: k, ...extra }) : { code: "NO_PREVIEW_CHECK" });
	const preview = (k, extra) => previewOn(db, k, extra);
	c.eq(preview("ld-test-0011"), { ok: true, factored: false, confirmed: false, reason: "" }, "§5 the preview: a draft in flight on a load that isn't factored doesn't refuse it");
	c.eq(preview("ld-test-0012").ok, true, "§5 the preview: nor one that may be in Gmail");
	c.eq(preview("ld-test-0002").code, "LOAD_FACTORED", "§5 the preview: a factored load is refused as a press is");
	c.eq(preview("ld-test-0002", { confirm: yes, mayConfirm: true }).code, "NOA_UNCONFIGURED", "§5 the preview: the confirmation with no lines");
	c.eq(preview("ld-test-0002", { confirm: yes, mayConfirm: true, hasAssignmentLines: true }).code, "TRIUMPH_NOT_LIVE", "§5 the preview: the confirmation before live");
	c.eq(preview("ld-test-0002", { confirm: yes, ...lines }).code, "FACTORING_NOT_LISTED", "§5 the preview: an account not listed");
	c.eq(preview("ld-test-0002", { confirm: yes, mayConfirm: true, ...lines }), { ok: true, factored: true, confirmed: true, reason: yes.reason }, "§5 the preview: the confirmation passes where a press's does");
	c.eq(preview("ld-test-0004", { confirm: yes, mayConfirm: true, ...lines }).code, "FACTORING_LOCKED", "§5 the preview: a locked row");
	c.eq(previewOn(broken, "ld-test-0001").code, "FACTORING_UNREADABLE", "§5 the preview: a marker that can't be read refuses");

	const begin =(k, extra = {}) => S.draftBegin(db, { key: k, loadId: k.toUpperCase(), invoiceId: "11032026-9", messageId: "<made-up@example.test>", path: "imap", actorId: 7, recipient: "ap@example-broker.test", total: "$2,150.00", nowIso: at(2), ...extra });
	c.eq(begin("ld-test-0020"), { ok: true }, "§5 the late check passes and writes the in-flight row");
	const row = S.inflightRow(db, "ld-test-0020", "11032026-9", at(2));
	c.eq([row.state, row.path, row.message_id, row.recipient, row.effective], ["in_flight", "imap", "<made-up@example.test>", "ap@example-broker.test", "in_flight"], "§5 ...state in_flight, its path, Message-ID and recipient");
	c.eq(begin("ld-test-0020", { invoiceId: "11032026-10" }).code, "INVOICE_DRAFT_IN_FLIGHT", "§5 a second press that got past the early check is refused at the late check");
	putMarker(db, "ld-test-0021");
	c.eq(begin("ld-test-0021").code, "LOAD_FACTORED", "§5 marked during the render: refused at the late check");
	c.eq(begin("ld-test-0021").error, S.WORDS.LOAD_FACTORED, "§5 ...in its usual words, with no draft out");
	putDraft(db, "ld-test-0021", "imap");
	const lateOut = begin("ld-test-0021");
	c.ok(lateOut.code === "LOAD_FACTORED" && lateOut.error !== S.WORDS.LOAD_FACTORED && /Gmail Drafts and Sent Mail/.test(lateOut.error), "§5 ...with a draft row: its words send a person to Gmail there too");
	putMarker(db, "ld-test-0022");
	putClaim(db, "ld-test-0022", { state: "waiting", stage: "reserved", invoiceId: "11032026-60" });
	c.eq(begin("ld-test-0022", { confirmed: true }).code, "TRIUMPH_IN_FLIGHT", "§5 the late check repeats the confirmation's TRIUMPH_IN_FLIGHT");
	putMarker(db, "ld-test-0023", { factored: 0, locked: T0, via: "outside" });
	c.eq(begin("ld-test-0023").code, "FACTORING_LOCKED", "§5 locked during the render: refused at the late check, plain press too");
	c.eq([S.inflightRows(db, "ld-test-0021", at(2)).length, S.inflightRows(db, "ld-test-0022", at(2)).length], [0, 0], "§5 a refused late check writes no row");

	// What the invoice printed has to match the marker now, or the broker is told to pay the wrong party.
	putMarker(db, "ld-test-0040");
	c.eq(begin("ld-test-0040", { confirmed: true }).code, "FACTORING_CHANGED", "§5 FAILS ON THE OLD CODE: a confirmed draft on a factored load that printed the bank block: refused");
	c.eq(begin("ld-test-0040", { confirmed: true, printedAssignment: "true" }).code, "FACTORING_CHANGED", "§5 ...only a real true says the lines printed");
	c.eq(begin("ld-test-0040", { confirmed: true, printedAssignment: true }), { ok: true }, "§5 a confirmed draft that printed the lines passes");
	c.eq(begin("ld-test-0041", { printedAssignment: true }).code, "FACTORING_CHANGED", "§5 FAILS ON THE OLD CODE: the lines printed and the load no longer factored: refused");
	c.eq(begin("ld-test-0042", { confirmed: true, printedAssignment: true }).code, "FACTORING_CHANGED", "§5 FAILS ON THE OLD CODE: ...with the confirmation too, its mark cleared during the render");
	c.eq(begin("ld-test-0041", { invoiceId: "11032026-11" }), { ok: true }, "§5 the plain page on a load that isn't factored passes as ever");
	c.eq([S.inflightRows(db, "ld-test-0042", at(2)).length], [0], "§5 a load refused for that has no row");
	putInflight(db, "ld-test-0043", { invoiceId: "11032026-43" });
	c.eq(S.draftBeforeN8n(db, { key: "ld-test-0043", invoiceId: "11032026-43", printedAssignment: true, nowIso: at(3) }).code, "FACTORING_CHANGED", "§5 FAILS ON THE OLD CODE: before n8n, the same: the lines printed and the load no longer factored");
	putMarker(db, "ld-test-0044");
	putInflight(db, "ld-test-0044", { invoiceId: "11032026-44" });
	c.eq(S.draftBeforeN8n(db, { key: "ld-test-0044", invoiceId: "11032026-44", confirmed: true, nowIso: at(3) }).code, "FACTORING_CHANGED", "§5 FAILS ON THE OLD CODE: before n8n: the bank block printed on a factored load");
	c.eq(S.draftBeforeN8n(db, { key: "ld-test-0044", invoiceId: "11032026-44", confirmed: true, printedAssignment: true, nowIso: at(3) }), { ok: true }, "§5 before n8n, a confirmed draft that printed the lines passes");
	c.ok(S.WORDS.FACTORING_CHANGED && /Draft it again/.test(S.WORDS.FACTORING_CHANGED), "§5 its words say what to do");

	c.eq(S.draftBeforeN8n(db, { key: "ld-test-0020", invoiceId: "11032026-9", nowIso: at(3) }), { ok: true }, "§5 before n8n, the press's own row is not 'another'");
	c.eq(S.inflightRow(db, "ld-test-0020", "11032026-9", at(3)).path, "n8n", "§5 ...and its path becomes n8n");
	putInflight(db, "ld-test-0024", { invoiceId: "11032026-24", state: "maybe_drafted" });
	db.prepare("INSERT INTO auto_invoice_claims (load_key, load_id, state, first_seen_at, updated_at) VALUES ('x', 'x', 'queued', ?, ?)").run(T0, T0);
	putMarker(db, "ld-test-0024");
	const n8n = S.draftBeforeN8n(db, { key: "ld-test-0024", invoiceId: "11032026-24", nowIso: at(3) });
	c.eq([n8n.code, n8n.keep], ["LOAD_FACTORED", true], "§5 a refusal before n8n after an unanswered IMAP keeps the row (keep: true)");
	c.eq(S.draftMaybe(db, { key: "ld-test-0020", invoiceId: "11032026-9", nowIso: at(4) }), 1, "§5 draftMaybe() marks the row");
	c.eq(S.inflightRow(db, "ld-test-0020", "11032026-9", at(4)).state, "maybe_drafted", "§5 ...maybe_drafted");
	c.eq(S.draftDrop(db, { key: "ld-test-0020", invoiceId: "11032026-9" }), 1, "§5 draftDrop() deletes it");
	return c;
}

// ------------------------------------------------------------------ §6
function checkResolveAndAnnotate(S) {
	const c = checker();
	const db = freshDb(S);
	putInflight(db, "ld-test-0001", { invoiceId: "11032026-1", startedAt: at(0) });
	c.eq(S.resolveInflight(db, { key: "ld-test-0001", invoiceId: "11032026-1", found: true, actor: ACTOR, nowIso: at(1) }).code, "INVOICE_DRAFT_IN_FLIGHT", "§6 a row still in flight can't be resolved yet");
	c.eq(S.resolveInflight(db, { key: "ld-test-0001", invoiceId: "11032026-1", found: true, actor: ACTOR, nowIso: at(16) }).ok, true, "§6 ...once it is 15 minutes old it can");
	c.eq(db.prepare("SELECT load_id, invoice_id, via, created_by FROM load_invoice_drafts").all(), [{ load_id: "LD-TEST-0001", invoice_id: "11032026-1", via: "imap", created_by: "made-up-admin" }],
		"§6 found: the draft row is written via the row's path");
	c.eq(S.inflightRows(db, "ld-test-0001", at(16)).length, 0, "§6 ...and the in-flight row is gone");
	putInflight(db, "ld-test-0002", { invoiceId: "11032026-2", state: "maybe_drafted", path: "n8n" });
	c.eq(S.resolveInflight(db, { key: "ld-test-0002", invoiceId: "11032026-2", found: false, actor: ACTOR, nowIso: at(1) }).ok, true, "§6 absent: resolved");
	c.eq([S.inflightRows(db, "ld-test-0002", at(1)).length, db.prepare("SELECT COUNT(*) AS n FROM load_invoice_drafts WHERE load_id = 'LD-TEST-0002'").get().n], [0, 0], "§6 ...the row deleted and no draft row written");
	c.eq(S.resolveInflight(db, { key: "ld-test-0003", invoiceId: "1", found: true, nowIso: at(1) }).code, "INFLIGHT_NOT_FOUND", "§6 nothing to resolve: 404");

	const rows = () => [{ "Load ID": "LD-TEST-0010" }, { "Load ID": "LD-TEST-0011" }, { "Load ID": "LD-TEST-0012" }];
	let r = S.annotateRows(db, { rows: rows(), idCol: "Load ID", nowIso: at(1) });
	c.eq(r.map((x) => Object.keys(x).length), [1, 1, 1], "§6 empty tables: no row gets a key (the dashboard answers as before)");
	putMarker(db, "ld-test-0010");
	putInflight(db, "ld-test-0012", { invoiceId: "11032026-12", state: "maybe_drafted" });
	r = S.annotateRows(db, { rows: rows(), idCol: "Load ID", canRecordOutside: true, inflight: true, nowIso: at(1) });
	c.eq([r[0]._factoring, r[1]._factoring, r[2]._draftInflight], [
		{ factored: true, locked: false, lockedVia: "", triumphState: "", canMark: false, canRecordOutside: true }, undefined, { state: "maybe_drafted", invoiceId: "11032026-12", path: "imap" },
	], "§6 a marked row gets _factoring; a button draft gets _draftInflight; others nothing");
	r = S.annotateRows(db, { rows: rows(), idCol: "Load ID", all: true, canMark: true, nowIso: at(1) });
	c.eq([r[1]._factoring.factored, r[1]._factoring.canMark, r[2]._draftInflight], [false, true, undefined], "§6 with marking on for a listed account, every row gets _factoring; _draftInflight only when asked");
	return c;
}

// ------------------------------------------------------------------ §10
function checkLoadIdChange(S) {
	const c = checker();
	if (typeof S.loadIdChangeCheck !== "function" || typeof S.clearedMarks !== "function") {
		c.ok(false, "§10 FAILS ON THE OLD CODE: loadIdChangeCheck() and clearedMarks() exist");
		return c;
	}
	c.eq([S.loadIdMoveBegin, S.loadIdMoveFinish, S.WORDS.LOAD_ID_FACTORED_BLANK], [undefined, undefined, undefined], "§10 nothing is left of the move: no hold, no last look, no words of its own");
	const db = freshDb(S);
	const check = (from, on = db) => S.loadIdChangeCheck(on, { from });

	// No mark on this load: nothing to refuse. A save asks only when the cell's text changes.
	c.eq(check("LD-TEST-0001"), null, "§10 no marker row: no refusal");
	c.eq([check(""), check(null)], [null, null], "§10 a row with no ID carries no mark");
	putMarker(db, "ld-test-0003", { factored: 0 });
	c.eq(check("LD-TEST-0003"), null, "§10 a mark cleared: no refusal, so the way through works");

	// A live mark: the ID stays, whatever it would become, and the sentence gives the way through.
	putMarker(db, "ld-test-0010");
	const before = marker(db, "ld-test-0010");
	const r = check("LD-TEST-0010");
	c.eq([r?.ok, r?.http, r?.code, r?.error], [false, 409, "LOAD_ID_FACTORED", S.WORDS.LOAD_ID_FACTORED], "§10 a live mark: 409 LOAD_ID_FACTORED");
	c.eq(check("#ld-test-0010 ")?.code, "LOAD_ID_FACTORED", "§10 ...however the cell spells the marked ID");
	c.eq(marker(db, "ld-test-0010"), before, "§10 ...and asking writes nothing");
	c.ok(/clear the mark, change the ID, then mark the load again\.$/.test(S.WORDS.LOAD_ID_FACTORED), "§10 FAILS ON THE OLD CODE: the refusal gives the way through");
	c.eq((S.WORDS.LOAD_ID_FACTORED.match(/[.!?](\s|$)/g) || []).length, 1, "§10 ...in one sentence");
	// What the code's own key reads as one load. The route refuses these too: it goes by the cell's text.
	c.eq(["#LD-TEST-0010", " ld-test-0010 ", "LD-TEST-0010"].map(rules.loadKey), ["ld-test-0010", "ld-test-0010", "ld-test-0010"], "§10 the code's own key: case, spaces and one leading # make no difference");

	// A final row: its own refusal, whichever way it's set.
	putMarker(db, "ld-test-0026", { locked: T0, via: "outside" });
	c.eq([check("LD-TEST-0026")?.http, check("LD-TEST-0026")?.code, check("LD-TEST-0026")?.error], [409, "FACTORING_LOCKED", S.WORDS.FACTORING_LOCKED], "§10 a final row: 409 FACTORING_LOCKED");
	putMarker(db, "ld-test-0027", { factored: 0, locked: T0, via: "outside" });
	c.eq(check("LD-TEST-0027")?.code, "FACTORING_LOCKED", "§10 ...at 0 too");

	// A database that can't answer, and one with no table.
	const closed = new Database(":memory:");
	S.ensureSchema(closed);
	closed.close();
	const unread = check("LD-TEST-0001", closed);
	c.eq([unread?.ok, unread?.http, unread?.code], [false, 503, "FACTORING_UNREADABLE"], "§10 a marker that can't be read refuses");
	c.eq(check("LD-TEST-0001", new Database(":memory:")), null, "§10 a database without the table (an old copy) reads as no mark");

	// The marks cleared, and when.
	const cleared = S.clearedMarks(db);
	c.ok(cleared instanceof Map && cleared.get("ld-test-0003") === T0, "§10 clearedMarks(): a row at 0 and when it was set");
	c.eq([cleared.has("ld-test-0010"), cleared.has("ld-test-0001"), cleared.has("ld-test-0026"), cleared.has("ld-test-0027")], [false, false, false, false], "§10 ...not a live mark, no row, or a final row either way");
	c.eq(S.clearedMarks(new Database(":memory:")).size, 0, "§10 ...no table: none");
	let threw = false;
	try { S.clearedMarks(closed); } catch { threw = true; }
	c.ok(threw, "§10 clearedMarks() on a marker that can't be read throws, never answers");
	return c;
}

// ------------------------------------------------------------------ §7
function checkLockWriters() {
	const c = checker();
	// The server as the scripts read it (scripts/lib/server-source.js, its route
	// modules spliced in), then lib/ and scripts/.
	const writes = (text) => (text.match(/locked_at\s*=\s*\?/g) || []).length;
	const writers = [];
	const serverWrites = writes(require("./lib/server-source").serverSource());
	if (serverWrites) writers.push(`the server:${serverWrites}`);
	for (const dir of ["lib", "scripts"]) {
		for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith(".js") && !x.startsWith("test-"))) {
			const n = writes(fs.readFileSync(path.join(ROOT, dir, f), "utf8"));
			if (n) writers.push(`${dir}/${f}:${n}`);
		}
	}
	c.eq(writers, ["lib/factoring-store.js:1"], "§7 locked_at has one writer: handledOutside() (lockForUpload() joins it in PR T2)");
	return c;
}

const GROUPS = [["§1  the schema", checkSchema], ["§2  marking", checkMark], ["§3  clearing", checkClear], ["§4  handled in Triumph's process", checkOutside],
	["§5  the Draft Invoice button's checks", checkButton], ["§6  Check Gmail; the dashboard annotation", checkResolveAndAnnotate],
	["§10 a Load ID change on a marked load; a mark cleared since", checkLoadIdChange]];
const REAL = loadStore(STORE_SRC);
for (const [title, fn] of GROUPS) {
	section(title);
	const c = fn(REAL);
	pass += c.count() - c.out.length;
	failures.push(...c.out);
	console.log(`  ${c.count() - c.out.length}/${c.count()} ok`);
}
section("§7  locked_at's writers");
{
	const c = checkLockWriters();
	pass += c.count() - c.out.length;
	failures.push(...c.out);
}

// ------------------------------------------------------------------ §9
// lib/factoring-routes.js: who may mark, clear and record; the switch; the
// answers. The handlers run on a capturing app (the role gate is its own runner's,
// scripts/test-invoice-draft-admin-only.js §6).
function checkRoutes(routesSrc) {
	const c = checker();
	const ROUTES_FILE = path.join(ROOT, "lib", "factoring-routes.js");
	const lib = (() => { const mod = { exports: {} }; new Function("module", "exports", "require", routesSrc)(mod, mod.exports, Module.createRequire(ROUTES_FILE)); return mod.exports; })();
	const build = (env, { replica = false } = {}) => {
		const db = freshDb(REAL);
		const refusals = [];
		const audits = [];
		const routes = lib.create({ db, env, replica, now: () => new Date(T0), logAudit: (req, action) => audits.push(action), logAuditRefusal: (req, action, e, id, d, code) => refusals.push(`${action}:${code}`) });
		const mounted = {};
		routes.mount({ post: (p, ...chain) => { mounted[p] = chain[chain.length - 1]; } }, { requireRole: () => () => {} });
		const post = (p, user, params, body) => {
			const out = { status: 200, body: null };
			mounted[p]({ params, body, session: { user } }, { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } });
			return out;
		};
		return { db, routes, refusals, audits,
			mark: (user, n, body = { factored: true, reason: "made-up" }) => post("/api/factoring/loads/:loadKey", user, { loadKey: `ld-test-000${n}` }, body),
			outside: (user, n, body = { reason: "made-up: handled in Triumph's portal" }) => post("/api/factoring/loads/:loadKey/handled-outside", user, { loadKey: `ld-test-000${n}` }, body) };
	};
	const ME = { id: 7, username: "made-up-admin", role: "Super Admin" };
	const OTHER = { id: 8, username: "made-up-other", role: "Super Admin" };
	const SHARED = { id: 9, username: "super_admin", role: "Super Admin" };
	const ON = { TRIUMPH_FACTORING_ENABLED: "true", TRIUMPH_FACTOR_MARK_IDS: "7,9" };
	let w = build({ TRIUMPH_FACTOR_MARK_IDS: "7" });
	c.eq([w.routes.markingOn, w.mark(ME, 1).status, w.mark(ME, 1).body.code], [false, 404, "FEATURE_OFF"], "§9 marking off: 404 FEATURE_OFF");
	c.eq(w.routes.markingOn, false, "§9 off unless exactly \"true\"");
	c.eq(build({ TRIUMPH_FACTORING_ENABLED: "true" }, { replica: true }).routes.markingOn, false, "§9 a replica never marks");
	c.eq(build({ TRIUMPH_FACTORING_ENABLED: "TRUE" }).routes.markingOn, false, "§9 \"TRUE\" is not \"true\"");
	for (const [label, ids] of [["unset", undefined], ["invalid", "seven"], ["blank", " "]]) {
		const x = build({ TRIUMPH_FACTORING_ENABLED: "true", ...(ids === undefined ? {} : { TRIUMPH_FACTOR_MARK_IDS: ids }) });
		c.eq([x.mark(ME, 1).status, x.mark(ME, 1).body.code, x.outside(ME, 1).status], [403, "FACTORING_NOT_LISTED", 403], `§9 TRIUMPH_FACTOR_MARK_IDS ${label}: nobody may mark or record`);
	}
	w = build(ON);
	c.eq([w.mark(OTHER, 1).status, w.outside(OTHER, 1).status], [403, 403], "§9 a Super Admin not listed: 403");
	c.eq([w.mark(SHARED, 1).status, w.outside(SHARED, 1).status], [403, 403], "§9 the shared login, even with its id listed: 403");
	c.eq(w.mark(ME, 1, { factored: "yes" }).body.code, "FACTORED_INVALID", "§9 factored must be true or false");
	const m = w.mark(ME, 1);
	c.eq([m.status, m.body, marker(w.db, "ld-test-0001").factored], [200, { ok: true, changed: true, factored: true }, 1], "§9 a listed account marks it");
	c.eq(w.audits, ["factoring_marked"], "§9 ...audited");
	putInflight(w.db, "ld-test-0002", { startedAt: T0 });
	c.eq([w.mark(ME, 2).status, w.refusals], [409, ["factoring_mark_blocked:INVOICE_DRAFT_IN_FLIGHT"]], "§9 a refusal answers 409 and writes a refusal audit row with its code");
	c.eq(w.mark(ME, 1, { factored: false, reason: "made-up" }).body, { ok: true, changed: true, factored: false }, "§9 ...and clears it");
	const sent = build(ON);
	putDraft(sent.db, "LD-TEST-0005", "auto-smtp");
	const late = sent.mark(ME, 5, { factored: true, reason: "made-up: says it never went", confirmNotSent: true });
	c.eq([late.status, late.body, marker(sent.db, "ld-test-0005"), sent.audits, sent.refusals],
		[409, { error: REAL.WORDS.INVOICE_ALREADY_SENT, code: "INVOICE_ALREADY_SENT" }, undefined, [], ["factoring_mark_blocked:INVOICE_ALREADY_SENT"]],
		"§9 marked after a send: the switch's answer is 409 INVOICE_ALREADY_SENT in its own words; no row, and only the refusal audited");
	const off = build({ TRIUMPH_FACTOR_MARK_IDS: "7" });
	putMarker(off.db, "ld-test-0003");
	const o = off.outside(ME, 3);
	c.eq([off.routes.markingOn, o.status, o.body, marker(off.db, "ld-test-0003").locked_via], [false, 200, { ok: true, locked: true }, "outside"],
		"§9 \"Handled in Triumph's process\" works with every switch off (no switch)");
	c.eq(off.outside(ME, 3).body.code, "FACTORING_LOCKED", "§9 ...once");
	// The dashboard's annotation: a Super Admin's rows only.
	const rows = () => [{ "Load ID": "LD-TEST-0003" }, { "Load ID": "LD-TEST-0006" }];
	const headers = ["Load ID", "Job Status"];
	const dispatcherRows = { active: rows(), completed: rows() };
	off.routes.annotateDashboard({ session: { user: { id: 2, username: "made-up-dispatch", role: "Dispatcher" } } }, { headers, ...dispatcherRows });
	c.eq([...dispatcherRows.active, ...dispatcherRows.completed].map((r) => Object.keys(r).length), [1, 1, 1, 1], "§9 a Dispatcher's rows get nothing");
	const adminRows = { active: rows(), completed: rows() };
	off.routes.annotateDashboard({ session: { user: OTHER } }, { headers, ...adminRows });
	c.eq([adminRows.completed[0]._factoring && adminRows.completed[0]._factoring.factored, adminRows.completed[1]._factoring, adminRows.active[0]._factoring.canRecordOutside],
		[true, undefined, false], "§9 a Super Admin's rows: the marked load only; an unlisted one may not record");
	// The switch itself, with marking on: the server gives it to a listed account only.
	const on = build(ON);
	putMarker(on.db, "ld-test-0003");
	const seen = (user) => {
		const r = { active: rows(), completed: rows() };
		on.routes.annotateDashboard({ session: { user } }, { headers, ...r });
		return [...r.active, ...r.completed].map((x) => (x._factoring ? [x._factoring.factored, x._factoring.canMark] : null));
	};
	c.eq(seen(ME), [[true, true], [false, true], [true, true], [false, true]], "§9 marking on, a listed account: every row, each with the switch");
	c.eq(seen(OTHER), [[true, false], null, [true, false], null], "§9 marking on, a Super Admin not listed: the marked load's chip and no switch; nothing on any other");
	c.eq(seen(SHARED), [[true, false], null, [true, false], null], "§9 marking on, the shared login, even with its id listed: the same");
	// The row saves' question (server.js), every setting off: a mark is honoured whatever they say.
	if (typeof off.routes.loadIdSave !== "function") {
		c.ok(false, "§9 FAILS ON THE OLD CODE: loadIdSave() exists");
		return c;
	}
	putMarker(off.db, "ld-test-0007");
	const asked = (from, to) => {
		try {
			return off.routes.loadIdSave({ from, to });
		} catch (e) {
			return { threw: String(e && e.message) };
		}
	};
	const saved = asked("LD-TEST-0007", "LD-TEST-0008");
	c.eq([saved.ok, saved.http, saved.code, saved.json], [false, 409, "LOAD_ID_FACTORED", { error: REAL.WORDS.LOAD_ID_FACTORED, code: "LOAD_ID_FACTORED" }], "§9 FAILS ON THE OLD CODE: a marked load, every setting off: refused, as the routes answer it");
	const noMark = asked("LD-TEST-0008", "LD-TEST-0009");
	c.eq([noMark.ok, typeof noMark.done], [true, "function"], "§9 FAILS ON THE OLD CODE: no mark: the save goes on, and says when it's done");
	return c;
}
section("§9  the routes: who may mark, the switch");
const ROUTES_FILE_SRC = fs.existsSync(path.join(ROOT, "lib", "factoring-routes.js")) ? fs.readFileSync(path.join(ROOT, "lib", "factoring-routes.js"), "utf8") : "";
{
	const c = ROUTES_FILE_SRC ? checkRoutes(ROUTES_FILE_SRC) : { out: ["lib/factoring-routes.js is missing"], count: () => 1 };
	pass += c.count() - c.out.length;
	failures.push(...c.out);
	console.log(`  ${c.count() - c.out.length}/${c.count()} ok`);
}

// ------------------------------------------------------------------ §8
section("§8  mutants: each rule removed, and a case catches it");
const MUTANTS = [
	["isFactored() answers false on a broken marker", "return rowFactored(markerFor(db, key));", "try { return rowFactored(markerFor(db, key)); } catch { return false; }", checkSchema],
	["a value that isn't 0 or 1 read as not factored", "Boolean(row) && Number(row.factored) !== 0", "Boolean(row) && row.factored === 1", checkSchema],
	["a view of that name read as no marker", "WHERE type IN ('table', 'view') AND name = ?", "WHERE type = 'table' AND name = ?", checkSchema],
	["mark: no lock check", "const row = markerFor(db, k);\n\t\tif (rowLocked(row)) return refusal(\"FACTORING_LOCKED\");\n\t\tconst inflight = inflightRefusal(inflightRows(db, k, nowIso));\n\t\tif (inflight) return inflight;\n\t\tif (autoClaimWorking",
		"const row = markerFor(db, k);\n\t\tconst inflight = inflightRefusal(inflightRows(db, k, nowIso));\n\t\tif (inflight) return inflight;\n\t\tif (autoClaimWorking", checkMark],
	["mark: the auto job's working claim ignored", "if (autoClaimWorking(db, k)) return refusal(\"AUTO_INVOICE_IN_FLIGHT\");", "", checkMark],
	["mark: a sent invoice not refused", "if (drafts.some((d) => SENT_VIAS.includes(d.via))) return refusal(\"INVOICE_ALREADY_SENT\");", "", checkMark],
	["mark: a send the job's record shows not refused", "\t\tif (autoClaimSent(db, k)) return refusal(\"INVOICE_ALREADY_SENT\");\n", "", checkMark],
	["mark: a send counts only once recorded", "[\"appending\", \"appended\", \"recorded\"].includes(c.stage)", "c.stage === \"recorded\"", checkMark],
	["mark: 'not sent' accepted without a reason", "if (drafts.length && !(confirmNotSent === true && why))", "if (drafts.length && !(confirmNotSent === true))", checkMark],
	["an in-flight row never goes stale", "Date.parse(nowIso) - started >= INFLIGHT_STALE_MS", "false", checkMark],
	["clear: a working Triumph claim not refused", "if (claim && claim.state === \"working\") return refusal(\"TRIUMPH_IN_FLIGHT\");", "", checkClear],
	["clear: a number past pdf_uploading voided too", "if (!claim || !triumphHoldsNumber(claim) || !STAGES_BEFORE_UPLOAD.has(claim.stage)) return \"\";", "if (!claim || !triumphHoldsNumber(claim)) return \"\";", checkClear],
	["handledOutside: the state check alone (M1)", "if (triumphWorkingLive(claim, nowIso)) return refusal(\"TRIUMPH_IN_FLIGHT\");", "if (claim && claim.state === \"working\") return refusal(\"TRIUMPH_IN_FLIGHT\");", checkOutside],
	["handledOutside: no lease check at all", "if (triumphWorkingLive(claim, nowIso)) return refusal(\"TRIUMPH_IN_FLIGHT\");", "", checkOutside],
	["handledOutside: no marker check", "if (!rowFactored(row)) return refusal(\"NOT_FACTORED\");", "", checkOutside],
	["handledOutside: limited to Needs attention and staged", "const claim = triumphClaim(db, k);\n\t\tif (triumphWorkingLive",
		"const claim = triumphClaim(db, k);\n\t\tif (!claim || ![\"needs_attention\", \"staged\"].includes(claim.state)) return refusal(\"TRIUMPH_IN_FLIGHT\");\n\t\tif (triumphWorkingLive", checkOutside],
	["handledOutside: no lock written", "db.prepare(`UPDATE ${FACTORING} SET locked_at = ?, locked_via = 'outside', updated_at = ? WHERE load_key = ?`).run(nowIso, nowIso, k);", "", checkOutside],
	["handledOutside: a button draft not refused", "if (inflight) return inflight;\n\t\tdb.prepare(`UPDATE ${FACTORING} SET locked_at", "db.prepare(`UPDATE ${FACTORING} SET locked_at", checkOutside],
	["button: the lock checked only when factored", "if (rowLocked(row)) return refusal(\"FACTORING_LOCKED\");\n\tconst factored = rowFactored(row);", "const factored = rowFactored(row);", checkButton],
	["button: the confirmation passes with no assignment lines", "if (hasAssignmentLines !== true) return refusal(\"NOA_UNCONFIGURED\");", "", checkButton],
	["button: the lines taken to exist unless told otherwise", "hasAssignmentLines = false", "hasAssignmentLines = true", checkButton],
	["button: anything truthy says the lines exist", "if (hasAssignmentLines !== true) return", "if (!hasAssignmentLines) return", checkButton],
	["button: who asks comes before the lines", "if (hasAssignmentLines !== true) return refusal(\"NOA_UNCONFIGURED\");\n\t\t// Before Triumph is live the lines send the broker to a party holding nothing.\n\t\tif (live !== true) return refusal(\"TRIUMPH_NOT_LIVE\");\n\t\tif (!mayConfirm) return refusal(\"FACTORING_NOT_LISTED\");",
		"if (!mayConfirm) return refusal(\"FACTORING_NOT_LISTED\");\n\t\tif (hasAssignmentLines !== true) return refusal(\"NOA_UNCONFIGURED\");\n\t\tif (live !== true) return refusal(\"TRIUMPH_NOT_LIVE\");", checkButton],
	["button: the confirmation passes before live", "if (live !== true) return refusal(\"TRIUMPH_NOT_LIVE\");", "", checkButton],
	["button: live taken unless told otherwise", "hasAssignmentLines = false, live = false }", "hasAssignmentLines = false, live = true }", checkButton],
	["button: anything truthy says it's live", "if (live !== true) return", "if (!live) return", checkButton],
	["button: live before the lines", "if (hasAssignmentLines !== true) return refusal(\"NOA_UNCONFIGURED\");\n\t\t// Before Triumph is live the lines send the broker to a party holding nothing.\n\t\tif (live !== true) return refusal(\"TRIUMPH_NOT_LIVE\");",
		"if (live !== true) return refusal(\"TRIUMPH_NOT_LIVE\");\n\t\tif (hasAssignmentLines !== true) return refusal(\"NOA_UNCONFIGURED\");", checkButton],
	["button: the words for not live are missing", "\tTRIUMPH_NOT_LIVE: \"This load is factored, and Triumph hasn't confirmed it is live yet, so no draft was made: the invoice would tell the broker to pay Triumph, which holds nothing for it. To invoice the load another way, clear the mark, then draft it as usual.\",\n", "", checkButton],
	["late check: the bank block on a confirmed factored load passes", "\t\tif (printedAssignment !== true) return refusal(\"FACTORING_CHANGED\");\n", "", checkButton],
	["late check: the lines on a load no longer factored pass", "\t} else if (printedAssignment === true) {\n\t\treturn refusal(\"FACTORING_CHANGED\");\n\t}", "\t}", checkButton],
	["late check: anything truthy says the lines printed", "if (printedAssignment !== true) return", "if (!printedAssignment) return", checkButton],
	["draftBegin: what printed not passed on", "const r = lateChecks(db, k, { confirmed, reissue, printedAssignment, nowIso });", "const r = lateChecks(db, k, { confirmed, reissue, nowIso });", checkButton],
	["draftBeforeN8n: what printed not passed on", "const r = lateChecks(db, k, { confirmed, reissue, printedAssignment, nowIso, own: String(invoiceId) });", "const r = lateChecks(db, k, { confirmed, reissue, nowIso, own: String(invoiceId) });", checkButton],
	["preview: a draft in flight refuses it", "return factoredCheck(db, keyOf(key), gates);", "return draftEarlyCheck(db, { key, nowIso: new Date().toISOString(), ...gates });", checkButton],
	["button: the words for the refusal are missing", "\tNOA_UNCONFIGURED: \"This load is factored, and the app can't put Triumph's assignment on an invoice yet, so no draft was made. Its invoice goes through Triumph's own process.\",\n", "", checkButton],
	["button: the confirmation from any account", "if (!mayConfirm) return refusal(\"FACTORING_NOT_LISTED\");", "", checkButton],
	["button: the confirmation refused only while the claim is working", "if (claim && (claim.state === \"working\" || triumphHoldsNumber(claim))) return refusal(\"TRIUMPH_IN_FLIGHT\");\n\t\tconfirmed = true;",
		"if (claim && claim.state === \"working\") return refusal(\"TRIUMPH_IN_FLIGHT\");\n\t\tconfirmed = true;", checkButton],
	["button: no in-flight check before prepare()", "const inflight = inflightRefusal(inflightRows(db, k, nowIso));\n\tif (inflight) return inflight;\n\treturn checked;", "return checked;", checkButton],
	["button: the late check on isFactored() alone", "if (rowLocked(row)) return refusal(\"FACTORING_LOCKED\");\n\tif (rowFactored(row)) {\n\t\tif (!confirmed) return factoredRefusal(db, k);\n\t\tconst claim = triumphClaim(db, k);\n\t\tif (claim && (claim.state === \"working\" || triumphHoldsNumber(claim))) return refusal(\"TRIUMPH_IN_FLIGHT\");\n\t\tif (printedAssignment !== true) return refusal(\"FACTORING_CHANGED\");\n\t} else if (printedAssignment === true) {\n\t\treturn refusal(\"FACTORING_CHANGED\");\n\t}",
		"if (rowFactored(row) && !confirmed) return refusal(\"LOAD_FACTORED\");", checkButton],
	["button: a refusal before n8n drops a maybe-drafted row", "keep: Boolean(own && own.state === \"maybe_drafted\")", "keep: false", checkButton],
	["resolve: an in-flight row resolved early", "if (row.effective !== \"maybe_drafted\") return refusal(\"INVOICE_DRAFT_IN_FLIGHT\");", "", checkResolveAndAnnotate],
	["annotate: every row gets _factoring", "if (m || all) {", "if (true) {", checkResolveAndAnnotate],
	["mark: a may-be claim asks nothing", "if (mayBeInGmail && !(confirmNotSent === true && why)) return refusal(\"INVOICE_MAYBE_IN_GMAIL\");", "", checkMark],
	["mark: 'not sent' on a may-be claim needs no reason", "if (mayBeInGmail && !(confirmNotSent === true && why))", "if (mayBeInGmail && !(confirmNotSent === true))", checkMark],
	["button: the refusal's words ignore a draft that may be out", "if (!confirm || confirm.confirmFactored !== true) return factoredRefusal(db, k);", "if (!confirm || confirm.confirmFactored !== true) return refusal(\"LOAD_FACTORED\");", checkButton],
	["Load ID: a live mark doesn't refuse", "\treturn rowFactored(row) ? refusal(\"LOAD_ID_FACTORED\") : null;", "\treturn null;", checkLoadIdChange],
	["Load ID: a final row doesn't refuse", "\tif (rowLocked(row)) return refusal(\"FACTORING_LOCKED\");\n\treturn rowFactored(row) ? refusal(\"LOAD_ID_FACTORED\") : null;", "\treturn rowFactored(row) ? refusal(\"LOAD_ID_FACTORED\") : null;", checkLoadIdChange],
	["Load ID: a marker that can't be read passes", "\t} catch {\n\t\treturn refusal(\"FACTORING_UNREADABLE\");\n\t}\n\tif (rowLocked(row)) return refusal(\"FACTORING_LOCKED\");\n\treturn rowFactored(row)", "\t} catch {\n\t\treturn null;\n\t}\n\tif (rowLocked(row)) return refusal(\"FACTORING_LOCKED\");\n\treturn rowFactored(row)", checkLoadIdChange],
	["Load ID: the refusal leaves out the way through", " can clear the mark, change the ID, then mark the load again.", " can change it.", checkLoadIdChange],
	["clearedMarks: a final row counts", " WHERE factored = 0 AND locked_at = ''", " WHERE factored = 0", checkLoadIdChange],
];
let caught = 0;
for (const [name, from, to, group] of MUTANTS) {
	if (STORE_SRC.split(from).length - 1 !== 1) { failures.push(`mutant anchor not found once: ${name}`); continue; }
	let c;
	try {
		c = group(loadStore(STORE_SRC.replace(from, to)));
	} catch (e) {
		c = { out: [`threw: ${e && e.message}`] };
	}
	if (c.out.length) { caught++; pass++; console.log(`  MUTANT ${name}: caught`); }
	else failures.push(`MUTANT ${name}: NOT caught`);
}
const ROUTE_MUTANTS = [
	["marking with the switch off", "if (!markingOn) return res.status(404)", "if (false) return res.status(404)"],
	["a replica marks", "const markingOn = !replica && ", "const markingOn = "],
	["the shared login listed", "&& !isSharedLoginName(user.username)", ""],
	["the dashboard annotated for every role", "if (user.role !== \"Super Admin\") return;", ""],
	["the switch given to any Super Admin", "canMark: markingOn && listed,", "canMark: markingOn,"],
	["every row annotated for any Super Admin", "all: markingOn && listed,", "all: markingOn,"],
	["marking by any Super Admin", "if (!mayMark(userOf(req))) return notListed(res);\n\t\t\tconst key = keyOf(req.params && req.params.loadKey);\n\t\t\tif (!key) return res.status(400).json({ error: \"Unknown load.\", code: \"LOAD_KEY_INVALID\" });\n\t\t\tconst body = bodyOf(req);\n\t\t\tif (typeof body.factored",
		"const key = keyOf(req.params && req.params.loadKey);\n\t\t\tif (!key) return res.status(400).json({ error: \"Unknown load.\", code: \"LOAD_KEY_INVALID\" });\n\t\t\tconst body = bodyOf(req);\n\t\t\tif (typeof body.factored"],
	["\"Handled in Triumph's process\" gated on the marking switch", "app.post(\"/api/factoring/loads/:loadKey/handled-outside\", requireRole(\"Super Admin\"), ...crossSite, (req, res) => {\n",
		"app.post(\"/api/factoring/loads/:loadKey/handled-outside\", requireRole(\"Super Admin\"), ...crossSite, (req, res) => {\n\t\t\tif (!markingOn) return res.status(404).json({ code: \"FEATURE_OFF\" });\n"],
];
let routeCaught = 0;
for (const [name, from, to] of ROUTE_MUTANTS) {
	if (!ROUTES_FILE_SRC || ROUTES_FILE_SRC.split(from).length - 1 !== 1) { failures.push(`route mutant anchor not found once: ${name}`); continue; }
	let c;
	try { c = checkRoutes(ROUTES_FILE_SRC.replace(from, to)); } catch (e) { c = { out: [`threw: ${e && e.message}`] }; }
	if (c.out.length) { routeCaught++; pass++; console.log(`  MUTANT ${name}: caught`); }
	else failures.push(`MUTANT ${name}: NOT caught`);
}
console.log(`  ${caught}/${MUTANTS.length} store mutants and ${routeCaught}/${ROUTE_MUTANTS.length} route mutants caught`);

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
