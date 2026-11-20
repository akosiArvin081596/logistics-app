#!/usr/bin/env node
// lib/triumph-process.js and its routes (lib/factoring-routes.js): Process with Triumph's one
// press on a delivered C.H. Robinson load whose automatic invoice already went to the broker
// (plan reports/2026-11-17-process-with-triumph-plan.md §1.2, §2.2-§2.5, §5).
//
//   §1 the press: one mark (the fixed reason, the broker's invoice number and date on it) and one
//      claim carrying that invoice's number, date, row and total, reserved_at set, two audit rows,
//      in one transaction; a refused arm rolls the mark back
//   §2 every refusal in its own words, each before any write (every table the same after): not
//      delivered, not C.H. Robinson's, already with Triumph (any claim, any state; a mark), a
//      closed or unknown month, a payment date (the date flag alone), too old, no automatic
//      invoice, one not sent, still being sent, needing a person, drafted in Gmail, drafted by
//      hand, records that disagree, a Draft Invoice press in flight, submitting paused
//   §3 the advance check fails closed: an active advance line, any advance read (whatever its
//      verdict or figures, "unread" and 0 included), a lines or reads table that can't be read;
//      no table is no rows; any DVIR decision refuses, dvir_count 0 included
//   §4 the dry run: the press's verdicts, no row written, on a read-only handle
//   §5 the routes: off, not live, the hold off, marking off: 404; not listed: 403; the shared
//      login listed passes, its rows saying so; paused or no connection: 503; one press with
//      { loadId } and no question; never twice; a stale page; a Load ID change and a key off the
//      sheet; Try again only on a stop a retry can change; the plain mark refused while the
//      switch is on and Clear factored kept; canProcess only where the press would take it;
//      with the switch off every row and route reads as before
//   §6 mutants: each money rule removed in turn, and a case catches it
//   §7 the press and Try again, each that landed, tell every open dashboard once (dashboard:changed);
//      a refused one tells none; mutants of each
//
// Made-up loads and people only (123456701..., made-up.agent@chrobinson.com), in memory.
//   node scripts/test-triumph-process.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const PROCESS_FILE = path.join(ROOT, "lib", "triumph-process.js");
const ROUTES_FILE = path.join(ROOT, "lib", "factoring-routes.js");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const factoring = require(path.join(ROOT, "lib", "factoring-store.js"));
const ledger = require(path.join(ROOT, "lib", "triumph-ledger.js"));
const autoLedger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const rateconAdvanceRead = require(path.join(ROOT, "lib", "ratecon-advance-read.js"));
const invoiceEvidence = require(path.join(ROOT, "lib", "invoice-evidence.js"));
const jobLib = require(path.join(ROOT, "lib", "triumph-job.js"));
const PROCESS_SRC = fs.existsSync(PROCESS_FILE) ? fs.readFileSync(PROCESS_FILE, "utf8") : "";
const ROUTES_SRC = fs.readFileSync(ROUTES_FILE, "utf8");

let pass = 0;
const failures = [];
// The first check a mutant failed: the one that caught it.
const caughtBy = (list) => JSON.stringify(String(list[0]).split("\n")[0].trim().slice(0, 160));
// Where a failure goes: the run's list, or a mutant's own (§6).
let sink = failures;
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		if (sink === failures) pass++;
		return;
	}
	sink.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
const ok = (cond, label) => eq(Boolean(cond), true, label);
const section = (t) => { if (sink === failures) console.log(`\n${t}`); };

// A module built from source text, so a mutant is the same text changed; its own requires
// resolve from lib/, with `over` standing in for any of them.
function loadFrom(file, src, over = {}) {
	const mod = { exports: {} };
	const base = Module.createRequire(file);
	const req = (p) => (Object.hasOwn(over, p) ? over[p] : base(p));
	new Function("module", "exports", "require", "__filename", "__dirname", src)(mod, mod.exports, req, file, path.dirname(file));
	return mod.exports;
}

// ---------------------------------------------------------------- the made-up world
const T0 = "2026-11-12T15:00:00.000Z";
const SENT_AT = "2026-11-10T16:00:00.000Z";
const LOAD = "123456701";
const KEY = LOAD;
const N = "11102026-4";
const D = "2026-11-10";
const TOTAL = "$2,150.00";
const BROKER = "made-up.agent@chrobinson.com";
const HEADERS = ["Load ID", "Status", "Driver", "Email", "Payment", "Completion Date"];
const ME = Object.freeze({ id: 7, username: "made-up-admin", role: "Super Admin" });
const OTHER = Object.freeze({ id: 8, username: "made-up-other", role: "Super Admin" });
const SHARED = Object.freeze({ id: 9, username: "super_admin", role: "Super Admin" });
const NOTE = "; by super_admin · shared login, person not recorded";

const sheetRow = (over = {}) => ({ "Load ID": LOAD, Status: "Delivered", Driver: "Made-up Driver", Email: BROKER, Payment: "2150", "Completion Date": "11/10/2026 09:15", ...over });

// Patch the automatic claim, as a later step of its job would.
function autoPatchOf(db) {
	return (fields) => {
		const cols = Object.keys(fields);
		db.prepare(`UPDATE auto_invoice_claims SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE load_key = ?`).run(...cols.map((c) => fields[c]), KEY);
	};
}
// The database as the app has it after the automatic job sent a C.H. Robinson load's invoice:
// its claim drafted, sent and recorded, its one draft row via auto-smtp.
const makeWorld = (opts = {}) => {
	const w = (() => {
		const db = new Database(":memory:");
		db.exec(`CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, recipient_source TEXT, total TEXT,
			broker_name TEXT, order_number TEXT, via TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
		db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by TEXT)");
		factoring.ensureSchema(db);
		autoLedger.ensureSchema(db);
		if (opts.schema !== false && PROCESS_SRC) require(PROCESS_FILE).ensureSchema(db);
		else ledger.ensureSchema(db);
		return { db, audits: [], row: sheetRow(), closedMonths: [], autoPatch: autoPatchOf(db) };
	})();
	if (opts.sent !== false) {
		const r = w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, total, broker_name, order_number, via, created_by) VALUES (?, ?, ?, ?, 'C.H. Robinson (made up)', ?, 'auto-smtp', 'auto-invoice')")
			.run(LOAD, N, BROKER, TOTAL, LOAD);
		w.rowId = Number(r.lastInsertRowid);
		autoLedger.insertClaim(w.db, { key: KEY, loadId: LOAD, state: "drafted", nowIso: SENT_AT });
		w.autoPatch({ delivery: "send", stage: "recorded", invoice_id: N, invoice_date: D, sent_at: SENT_AT, draft_row_id: w.rowId,
			sent_json: JSON.stringify({ to: BROKER, subject: `C.H. Robinson Order #${LOAD}`, total: TOTAL }), fingerprint_json: JSON.stringify({ completed: true }) });
	}
	w.dump = () => Object.fromEntries(w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
		.map(({ name }) => [name, w.db.prepare(`SELECT * FROM ${name}`).all()]));
	w.marker = () => w.db.prepare("SELECT * FROM load_factoring WHERE load_key = ?").get(KEY) || null;
	w.claim = () => w.db.prepare("SELECT * FROM triumph_submissions WHERE load_key = ?").get(KEY) || null;
	w.press = (P, over = {}) => P.processWithTriumph(w.db, {
		key: KEY, loadId: LOAD, row: w.row, headers: HEADERS, closedMonths: w.closedMonths, nowIso: T0, actor: ME,
		audit: (action, details) => w.audits.push({ action, details }), ...over,
	});
	return w;
};

// A case that throws counts as one failure under its own label, so a tree without the module
// fails each rule by name.
function kase(label, fn) {
	try {
		fn();
	} catch (e) {
		sink.push(`${label}\n      threw ${e && e.message}`);
	}
}
async function kaseAsync(label, fn) {
	try {
		await fn();
	} catch (e) {
		sink.push(`${label}\n      threw ${e && e.message}`);
	}
}

// On a tree without the module every case runs against this, so each rule fails by its own name.
const MISSING = Object.freeze({
	WORDS: Object.freeze({}),
	refusal: () => { throw new Error("lib/triumph-process.js is missing: there is no Process with Triumph"); },
	processWithTriumph: () => { throw new Error("lib/triumph-process.js is missing: there is no Process with Triumph"); },
});

// ---------------------------------------------------------------- §1-§4 on a given module
// `src`: the module's own text, for the cases that load it again with a stand-in.
function checkPress(given, src = PROCESS_SRC) {
	const P = given && typeof given.processWithTriumph === "function" ? given : MISSING;

	// §1 ------------------------------------------------------------------------------
	section("§1 the press");
	kase("§1", () => {
		const w = makeWorld();
		const r = w.press(P);
		eq([r.ok, r.reuse], [true, { invoiceId: N, invoiceDate: D, draftRowId: w.rowId, total: TOTAL }], "§1 FAILS ON THE OLD CODE: a delivered C.H. Robinson load whose automatic invoice went: taken, carrying that invoice");
		const m = w.marker();
		eq([m.factored, m.source, m.reason, m.set_by, m.set_by_id, m.broker_invoice_id, m.broker_invoice_date, m.locked_at], [1, "person", "Process with Triumph", "made-up-admin", 7, N, D, ""],
			"§1 FAILS ON THE OLD CODE: ...the mark: factored, by the person, the fixed reason, the broker's invoice number and date on it");
		const c = w.claim();
		eq([c.state, c.number_source, c.invoice_id, c.invoice_date, c.reused_draft_id, c.expected_total, c.reserved_at, c.stage, c.number_voided_at],
			["queued", "chr_invoice", N, D, w.rowId, TOTAL, T0, "", ""], "§1 FAILS ON THE OLD CODE: ...the claim: queued, carrying the same number, date, row and total, reserved_at set (the caps count it)");
		eq(w.audits.map((a) => a.action), ["factoring_marked", "triumph_started"], "§1 FAILS ON THE OLD CODE: ...two audit rows");
		ok(w.audits.every((a) => a.details.includes(N) && a.details.includes("Process with Triumph")), "§1 ...each naming the invoice and the button");
		eq(w.db.prepare("SELECT COUNT(*) AS n FROM load_invoice_drafts").get().n, 1, "§1 FAILS ON THE OLD CODE: no second draft row");
		eq(w.db.prepare("SELECT invoice_id, number_voided_at FROM auto_invoice_claims").get(), { invoice_id: N, number_voided_at: "" }, "§1 ...and the broker's invoice stands, its number not voided");
		const again = w.press(P);
		eq([again.ok, again.code, w.audits.length], [false, "TRIUMPH_ALREADY", 2], "§1 FAILS ON THE OLD CODE: never twice: a second press is refused, nothing written");
		eq(again.error, "This load is already on its way to Triumph.", "§1 FAILS ON THE OLD CODE (M1): ...in words true while it waits its turn: on its way, never \"not sent\"");
	});
	kase("§1 a refused arm", () => {
		// The claim refused inside the press's own transaction (a row armed meanwhile): the mark rolls back.
		const w = makeWorld();
		const realArm = ledger.armClaim;
		const P2 = src ? loadFrom(PROCESS_FILE, src, { "./triumph-ledger": { ...ledger, armClaim: () => ({ ok: false, code: "TRIUMPH_ALREADY_STARTED" }) } }) : MISSING;
		const before = w.dump();
		const r = w.press(P2);
		eq([r.ok, r.code, w.dump()], [false, "TRIUMPH_ALREADY", before], "§1 FAILS ON THE OLD CODE: a claim refused inside the transaction: the mark rolls back with it, nothing written");
		eq(typeof realArm, "function", "§1 (fixture) the real armClaim untouched");
		// armClaim()'s own immediate transaction runs inside the press's as a savepoint.
		const w2 = makeWorld();
		eq(w2.press(P).ok, true, "§1 armClaim()'s immediate transaction nested in the press's: one commit");
	});

	// §2 ------------------------------------------------------------------------------
	section("§2 every refusal, in its words, before any write");
	// The section a refusal's label names: §2, then §3 for the advance and DVIR checks.
	let where = "§2";
	const refused = (label, prepare, code, words, over = {}) => kase(`${where} ${label}`, () => {
		const w = makeWorld(over.world || {});
		prepare(w);
		const before = w.dump();
		const dry = w.press(P, { ...(over.press || {}), dryRun: true });
		const r = w.press(P, over.press || {});
		eq([r.ok, r.code, r.error], [false, code, words], `${where} FAILS ON THE OLD CODE: ${label}: ${code}, in its words`);
		eq(w.dump(), before, `${where} FAILS ON THE OLD CODE: ${label}: nothing written`);
		eq([dry.ok, dry.code], [false, code], `${where} FAILS ON THE OLD CODE: ${label}: the dry run refuses the same way`);
	});
	const W = P.WORDS || {};
	refused("not delivered", (w) => { w.row = sheetRow({ Status: "At Receiver" }); }, "NOT_DELIVERED", "This load isn't delivered yet.");
	refused("not C.H. Robinson's (another broker's domain)", (w) => { w.row = sheetRow({ Email: "ap@example-broker.test" }); }, "NOT_CHR", "Only C.H. Robinson loads can go to Triumph from this button for now. Invoice this one the usual way.");
	refused("not C.H. Robinson's (a Load ID that isn't 9 digits)", (w) => { w.row = sheetRow({ "Load ID": "LD-TEST-0001" }); }, "NOT_CHR", W.NOT_CHR, { press: { key: "ld-test-0001", loadId: "LD-TEST-0001" } });
	refused("a look-alike domain", (w) => { w.row = sheetRow({ Email: "made-up@notchrobinson.com" }); }, "NOT_CHR", W.NOT_CHR);
	// A second press is refused whatever the claim's state, in words true for where the load stands:
	// on its way, with Triumph, marked, or back with its invoice to the broker after a stop or a clear.
	const ALREADY = Object.freeze({
		onItsWay: "This load is already on its way to Triumph.",
		there: "This load is already with Triumph.",
		marked: "This load is already marked factored: its invoice goes through Triumph.",
		stopped: "This load was already taken for Triumph once and didn't go: its invoice to the broker stands. Its Triumph line says why.",
	});
	const ALREADY_BY_STATE = { waiting: "stopped", queued: "onItsWay", working: "onItsWay", staged: "there", submitted: "there", needs_attention: "stopped", skipped: "stopped", closed_outside: "there" };
	const markIt = (w, factored) => w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, ?, 'person', ?, ?)").run(KEY, LOAD, factored, T0, T0);
	for (const state of factoring.TRIUMPH_STATES) {
		refused(`a Triumph claim already there (${state})`, (w) => { markIt(w, 1); ledger.insertClaim(w.db, { key: KEY, loadId: LOAD, state, nowIso: T0 }); }, "TRIUMPH_ALREADY", ALREADY[ALREADY_BY_STATE[state]]);
	}
	refused("a claim whose mark was cleared (M1)", (w) => { markIt(w, 0); ledger.insertClaim(w.db, { key: KEY, loadId: LOAD, state: "needs_attention", code: "SUBMIT_FAILED", nowIso: T0 }); }, "TRIUMPH_ALREADY", ALREADY.stopped);
	refused("a claim with no mark at all (M1)", (w) => ledger.insertClaim(w.db, { key: KEY, loadId: LOAD, state: "queued", nowIso: T0 }), "TRIUMPH_ALREADY", ALREADY.stopped);
	refused("a mark already there", (w) => w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'script', ?, ?)").run(KEY, LOAD, T0, T0), "TRIUMPH_ALREADY", ALREADY.marked);
	refused("a mark that is final", (w) => w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, locked_at, locked_via, updated_at) VALUES (?, ?, 1, 'person', ?, ?, 'outside', ?)").run(KEY, LOAD, T0, T0, T0), "FACTORING_LOCKED", factoring.WORDS.FACTORING_LOCKED);
	refused("a closed month", (w) => { w.closedMonths = ["2026-11"]; }, "MONTH_CLOSED", "This load's month is closed, so it can't go to Triumph.");
	refused("a month that can't be told", (w) => { w.closedMonths = null; }, "MONTH_CLOSED", W.MONTH_CLOSED);
	refused("a payment date on the Payments Table", (w) => invoiceEvidence.savePayments(w.db, KEY, { payments_payment_date: 1 }, { nowIso: T0 }), "PAID_ALREADY", "The Payments Table shows a payment date for this load, so it can't go to Triumph.");
	kase("§2 the payment date alone", () => {
		const w = makeWorld();
		invoiceEvidence.savePayments(w.db, KEY, { payments_status: 1, payments_invoice_number: 1 }, { nowIso: T0 });
		eq(w.press(P).ok, true, "§2 FAILS ON THE OLD CODE: a Payments Table status or invoice number alone (\"Unpaid\" is a status): taken; only a payment date refuses (M3)");
	});
	refused("an invoice sent 31 days ago", (w) => w.autoPatch({ sent_at: "2026-10-12T14:59:00.000Z" }), "INVOICE_TOO_OLD", "This load's invoice went to the broker more than 30 days ago, so it can't go to Triumph from the app.");
	kase("§2 an invoice sent 30 days ago", () => {
		const w = makeWorld();
		w.autoPatch({ sent_at: "2026-10-13T15:00:00.000Z" });
		eq(w.press(P).ok, true, "§2 an invoice sent 30 days ago: taken (decision P11)");
	});
	refused("no automatic invoice at all", (w) => w.db.exec("DELETE FROM auto_invoice_claims"), "NO_AUTO_INVOICE", "This load's automatic invoice hasn't gone to the broker, so the button can't take it. Invoice it the usual way.");
	refused("no automatic invoice table", (w) => w.db.exec("DROP TABLE auto_invoice_claims"), "NO_AUTO_INVOICE", W.NO_AUTO_INVOICE);
	for (const [label, patch] of [
		["skipped (LOAD_FACTORED)", { state: "skipped", reason_code: "LOAD_FACTORED", delivery: "", stage: "" }],
		["waiting", { state: "waiting", delivery: "", stage: "" }],
		["held for a person before any send", { state: "needs_attention", reason_code: "TOTAL_MISMATCH", delivery: "", stage: "reserved" }],
		["queued again after a Try again", { state: "queued", delivery: "", stage: "reserved" }],
	]) refused(`an automatic invoice not sent (${label})`, (w) => w.autoPatch(patch), "NO_AUTO_INVOICE", W.NO_AUTO_INVOICE);
	refused("an automatic invoice being made (working)", (w) => w.autoPatch({ state: "working", stage: "rendered" }), "AUTO_INVOICE_IN_FLIGHT", factoring.WORDS.AUTO_INVOICE_IN_FLIGHT);
	refused("a send with no answer yet (appending)", (w) => w.autoPatch({ state: "queued", stage: "appending" }), "AUTO_INVOICE_IN_FLIGHT", W.AUTO_INVOICE_IN_FLIGHT);
	refused("a send not yet recorded (appended)", (w) => w.autoPatch({ stage: "appended" }), "AUTO_INVOICE_IN_FLIGHT", W.AUTO_INVOICE_IN_FLIGHT);
	refused("a send that may have gone (MAYBE_SENT)", (w) => w.autoPatch({ state: "needs_attention", reason_code: "MAYBE_SENT", stage: "appending" }), "AUTO_INVOICE_NEEDS_PERSON", "This load's automatic invoice needs a person's look first.");
	refused("a draft in Gmail it couldn't record", (w) => w.autoPatch({ state: "needs_attention", reason_code: "IN_GMAIL_UNRECORDED", delivery: "", stage: "appended" }), "AUTO_INVOICE_NEEDS_PERSON", W.AUTO_INVOICE_NEEDS_PERSON);
	refused("a Gmail draft that may be there", (w) => w.autoPatch({ state: "queued", delivery: "", stage: "appending" }), "INVOICE_MAYBE_IN_GMAIL", W.INVOICE_MAYBE_IN_GMAIL);
	refused("a Gmail draft (drafted, not sent)", (w) => w.autoPatch({ delivery: "" }), "INVOICE_ALREADY_DRAFTED", W.INVOICE_ALREADY_DRAFTED);
	refused("a second draft row, drafted by hand", (w) => w.db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via) VALUES (?, '11112026-9', 'imap')").run(LOAD), "HAND_DRAFTED", "An invoice for this load was drafted by hand, so it can't go to Triumph from the app.");
	refused("its one row not the job's send", (w) => w.db.prepare("UPDATE load_invoice_drafts SET via = 'imap'").run(), "HAND_DRAFTED", W.HAND_DRAFTED);
	const MISMATCH = "This load's invoice records don't agree, or the load changed since its invoice went, so a person checks it first.";
	refused("the load changed since its invoice went (changed_fields)", (w) => w.autoPatch({ changed_fields: "payment" }), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("its number voided", (w) => w.autoPatch({ number_voided_at: T0 }), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("no number on the claim", (w) => w.autoPatch({ invoice_id: "" }), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("no sent time", (w) => w.autoPatch({ sent_at: "" }), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("the row isn't the claim's", (w) => w.autoPatch({ draft_row_id: w.rowId + 5 }), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("the row's number isn't the claim's", (w) => w.db.prepare("UPDATE load_invoice_drafts SET invoice_id = '11102026-5'").run(), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("the sent total isn't the row's", (w) => w.autoPatch({ sent_json: JSON.stringify({ to: BROKER, total: "$2,100.00" }) }), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("no row at all", (w) => w.db.exec("DELETE FROM load_invoice_drafts"), "INVOICE_RECORD_MISMATCH", MISMATCH);
	refused("a Draft Invoice press in flight", (w) => w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, '11122026-9', 'imap', 'in_flight', ?, ?)").run(KEY, LOAD, T0, T0), "INVOICE_DRAFT_IN_FLIGHT", factoring.WORDS.INVOICE_DRAFT_IN_FLIGHT);
	refused("a Draft Invoice press that may be in Gmail", (w) => w.db.prepare("INSERT INTO invoice_draft_inflight (load_key, load_id, invoice_id, path, state, started_at, updated_at) VALUES (?, ?, '11122026-9', 'imap', 'maybe_drafted', ?, ?)").run(KEY, LOAD, T0, T0), "INVOICE_MAYBE_DRAFTED", W.INVOICE_MAYBE_DRAFTED);
	refused("submitting paused (read again inside the transaction)", (w) => ledger.setPause(w.db, { reason: "LOGIN_REFUSED" }), "SUBMIT_PAUSED", "Sending to Triumph is paused right now, so nothing was marked. Try again once it resumes.");
	kase("§2 HTTP", () => {
		eq([P.refusal("SUBMIT_PAUSED").http, P.refusal("NOT_CHR").http, P.refusal("FEATURE_OFF").http], [503, 409, 404], "§2 a pause answers 503, a refusal 409, the switch off 404");
	});

	// §3 ------------------------------------------------------------------------------
	section("§3 the advance check fails closed; any DVIR decision refuses");
	where = "§3";
	const ADV = "This load's rate con shows an advance, or the app couldn't rule one out: it stays with its invoice to the broker.";
	const readRow = (w, verdict, reason, advance = 0) => {
		rateconAdvanceRead.ensureTable(w.db);
		w.db.prepare(`INSERT INTO ${rateconAdvanceRead.TABLE} (load_key, at, verdict, reason, total_cents, advance_cents, new_total_cents, switch_on) VALUES (?, ?, ?, ?, 0, ?, 0, 0)`).run(KEY, T0, verdict, reason, advance);
	};
	refused("an advance read on the rate con (person, after the invoice)", (w) => readRow(w, "person", "after_invoice", 50000), "ADVANCE_ON_RATECON", ADV);
	refused("an advance read the reader couldn't settle (figure_missing, advance 0)", (w) => readRow(w, "would_person", "figure_missing", 0), "ADVANCE_ON_RATECON", ADV);
	refused("a rate con the reader couldn't read (unread)", (w) => readRow(w, "unread", "unreadable", 0), "ADVANCE_ON_RATECON", ADV);
	refused("an advance read whatever its verdict (same)", (w) => readRow(w, "same", "own_line", 50000), "ADVANCE_ON_RATECON", ADV);
	refused("an advance read keyed with a leading #", (w) => { readRow(w, "filled", "sum_checks", 50000); w.db.prepare(`UPDATE ${rateconAdvanceRead.TABLE} SET load_key = ?`).run(KEY); }, "ADVANCE_ON_RATECON", ADV);
	refused("an active advance line", (w) => {
		w.db.exec("CREATE TABLE broker_invoice_lines (id INTEGER PRIMARY KEY, load_key TEXT, amount_cents INTEGER, voided_at TEXT, created_by TEXT)");
		w.db.prepare("INSERT INTO broker_invoice_lines (load_key, amount_cents, voided_at, created_by) VALUES (?, 50000, NULL, 'made-up-admin')").run(KEY);
	}, "ADVANCE_ON_RATECON", ADV);
	refused("an advance lines table that can't be read", (w) => w.db.exec("CREATE TABLE broker_invoice_lines (id INTEGER PRIMARY KEY)"), "ADVANCE_ON_RATECON", ADV);
	refused("an advance reads table that can't be read", (w) => w.db.exec(`CREATE TABLE made_up_gone (x); CREATE VIEW ${rateconAdvanceRead.TABLE} AS SELECT x AS load_key FROM made_up_gone; DROP TABLE made_up_gone`), "ADVANCE_ON_RATECON", ADV);
	kase("§3 no tables", () => {
		const w = makeWorld();
		eq(w.press(P).ok, true, "§3 no advance-reads table, no lines table, no DVIR table (each made on first use): no rows, taken");
		const v = makeWorld();
		v.db.exec("CREATE TABLE broker_invoice_lines (id INTEGER PRIMARY KEY, load_key TEXT, amount_cents INTEGER, voided_at TEXT, created_by TEXT)");
		v.db.prepare("INSERT INTO broker_invoice_lines (load_key, amount_cents, voided_at, created_by) VALUES (?, 50000, '2026-11-11T00:00:00Z', 'made-up-admin')").run(KEY);
		readRow(v, "would_fill", "sum_checks", 50000);
		v.db.prepare(`UPDATE ${rateconAdvanceRead.TABLE} SET load_key = 'another-load'`).run();
		eq(v.press(P).ok, true, "§3 a voided line and another load's read: taken");
	});
	const DVIR = "This load's rate con was re-issued for less: it stays with its invoice to the broker.";
	const dvirRow = (w, reason, count) => {
		w.db.exec(`CREATE TABLE IF NOT EXISTS ratecon_dvir_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, load_key TEXT NOT NULL, at TEXT NOT NULL, stored_cents INTEGER NOT NULL,
			sent_cents INTEGER NOT NULL, dvir_cents INTEGER NOT NULL, dvir_count INTEGER NOT NULL, reading TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL, switch_on INTEGER NOT NULL, protected_load INTEGER NOT NULL)`);
		w.db.prepare("INSERT INTO ratecon_dvir_decisions (load_key, at, stored_cents, sent_cents, dvir_cents, dvir_count, reading, verdict, reason, switch_on, protected_load) VALUES (?, ?, 215000, 211500, ?, ?, 'readable', 'held', ?, 1, 1)")
			.run(KEY, T0, count * 3500, count, reason);
	};
	refused("a DVIR decision (dvir_lines)", (w) => dvirRow(w, "dvir_lines", 1), "DVIR_LINES", DVIR);
	refused("a DVIR decision with dvir_count 0 (no_dvir_line)", (w) => dvirRow(w, "no_dvir_line", 0), "DVIR_LINES", DVIR);
	refused("a DVIR decision the reader couldn't confirm (unread)", (w) => dvirRow(w, "unread", 0), "DVIR_LINES", DVIR);
	refused("a DVIR table that can't be read", (w) => w.db.exec("CREATE TABLE made_up_gone (x); CREATE VIEW ratecon_dvir_decisions AS SELECT x AS load_key FROM made_up_gone; DROP TABLE made_up_gone"), "DVIR_LINES", DVIR);

	// §4 ------------------------------------------------------------------------------
	section("§4 the dry run");
	kase("§4", () => {
		const w = makeWorld();
		const before = w.dump();
		const dry = w.press(P, { dryRun: true });
		eq([dry.ok, dry.reuse && dry.reuse.invoiceId, Array.isArray(dry.wouldWrite) && dry.wouldWrite.length > 0, w.dump(), w.audits], [true, N, true, before, []],
			"§4 FAILS ON THE OLD CODE: the dry run: the press's verdict and what it would write, with no row written and no audit row");
		// The same world on disk under the system temp folder, opened read-only.
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "triumph-process-")), "made-up.db");
		makeWorld().db.prepare("VACUUM INTO ?").run(file);
		const ro = new Database(file, { readonly: true, fileMustExist: true });
		const r = P.processWithTriumph(ro, { key: KEY, loadId: LOAD, row: sheetRow(), headers: HEADERS, closedMonths: [], nowIso: T0, actor: ME, dryRun: true, audit: () => { throw new Error("no audit on a dry run"); } });
		eq([ro.readonly, r.ok], [true, true], "§4 FAILS ON THE OLD CODE: the dry run runs on a read-only handle");
		const wet = P.processWithTriumph(ro, { key: KEY, loadId: LOAD, row: sheetRow(), headers: HEADERS, closedMonths: [], nowIso: T0, actor: ME, audit: () => {} });
		eq([wet.ok, wet.code], [false, "RECORDS_UNREADABLE"], "§4 ...and a real press there can't write: refused, never a throw");
		ro.close();
		const refusedDry = makeWorld();
		refusedDry.row = sheetRow({ Email: "ap@example-broker.test" });
		eq(refusedDry.press(P, { dryRun: true }).code, "NOT_CHR", "§4 the dry run refuses as the press would");
	});
}

// ---------------------------------------------------------------- §5 the routes
const LIVE = { TRIUMPH_SUBMIT_ENABLED: "true", TRIUMPH_SUBMIT_DRY_RUN: "false", TRIUMPH_LIVE_CONFIRMED_ON: "2026-11-05" };
const ON = { ...LIVE, TRIUMPH_FACTORING_ENABLED: "true", TRIUMPH_FACTOR_MARK_IDS: "7,9", TRIUMPH_PROCESS_BUTTON_ENABLED: "true" };

function routesWorld(routesLib, { env = ON, hold = true, transport = true, replica = false, notifyChange = () => {} } = {}) {
	const w = makeWorld();
	w.sheet = { headers: HEADERS, data: [w.row] };
	w.refusals = [];
	w.rows = [];
	w.woke = 0;
	w.crossSite = true;
	const job = jobLib.create({ db: w.db, env, replica, transport: transport ? { configured: true } : null, now: () => new Date(T0), log: { info() {}, warn() {}, error() {} },
		logAudit: (req, action, entity, id, details) => w.rows.push({ action, details: String(details) }) });
	// The route's job is the real one, its wake() counted: a job with no wake() counts nothing.
	w.job = { mode: job.mode, transportReady: job.transportReady, wake: () => { job.wake(); w.woke++; }, retry: job.retry };
	w.routes = routesLib.create({ db: w.db, env, replica, now: () => new Date(T0),
		logAudit: (req, action, entity, id, details) => w.rows.push({ action, details: String(details) }),
		logAuditRefusal: (req, action, entity, id, details, code) => w.refusals.push({ action, code, details: String(details) }),
		readJobTracking: async () => w.sheet,
		closedMonthsOf: () => w.closedMonths,
		reissueHoldOn: hold,
		triumphJob: () => w.job,
		notifyChange });
	w.mounted = {};
	w.routes.mount({ post: (p, ...chain) => { w.mounted[p] = chain; } }, {
		requireRole: (role) => (req, res, next) => (req.session.user.role === role ? next() : res.status(403).json({ code: "FORBIDDEN" })),
		refuseCrossSite: (req, res, next) => (w.crossSite ? next() : res.status(403).json({ code: "CROSS_SITE" })),
	});
	w.post = async (p, user, body, params = {}) => {
		const out = { status: 200, body: null };
		const res = { status(s) { out.status = s; return res; }, json(b) { out.body = b; return res; } };
		const req = { params, body, session: { user } };
		for (const handler of w.mounted[p] || []) {
			let goOn = false;
			await handler(req, res, () => { goOn = true; });
			if (!goOn) break;
		}
		return out;
	};
	w.press = (user = ME, body = { loadId: LOAD }) => w.post("/api/factoring/process-with-triumph", user, body);
	w.retry = (user = ME, body = { loadId: LOAD }) => w.post("/api/factoring/triumph-retry", user, body);
	w.mark = (user, body) => w.post("/api/factoring/loads/:loadKey", user, body, { loadKey: KEY });
	w.dashboard = (user = ME) => {
		const r = { active: [], completed: [{ ...w.row }] };
		w.routes.annotateDashboard({ session: { user } }, { headers: HEADERS, ...r });
		return r.completed[0]._factoring;
	};
	return w;
}

async function checkRoutes(routesLib) {
	section("§5 the routes");
	await kaseAsync("§5 the press", async () => {
		const w = routesWorld(routesLib);
		eq(w.dashboard().canProcess, true, "§5 FAILS ON THE OLD CODE: canProcess on the load the press would take, for a listed account");
		const r = await w.press();
		eq([r.status, r.body && r.body.ok, w.claim() && w.claim().state, w.woke], [200, true, "queued", 1], "§5 FAILS ON THE OLD CODE: one press with { loadId } and nothing else: taken, and the job woken");
		eq([r.body.factoring && r.body.factoring.byButton, r.body.factoring && r.body.factoring.triumphState, r.body.factoring && r.body.factoring.brokerInvoiceId], [true, "queued", N], "§5 ...its answer is the tile's own row");
		eq([w.rows.map((x) => x.action), w.rows.every((x) => !x.details.includes("shared login"))], [["factoring_marked", "triumph_started"], true], "§5 ...audited twice, a named account's rows with no note");
		const twice = await w.press();
		eq([twice.status, twice.body.code, w.rows.length], [409, "TRIUMPH_ALREADY", 2], "§5 FAILS ON THE OLD CODE: never twice: a second press (a page loaded before the first) is refused, nothing written");
		eq([w.refusals.map((x) => `${x.action}:${x.code}`)], [["triumph_process_refused:TRIUMPH_ALREADY"]], "§5 ...and the refusal audited by its code");
		eq(w.dashboard().canProcess, false, "§5 ...and the row no longer offers the button");
		ok(!/confirm|reason/i.test(JSON.stringify(Object.keys(r.body))), "§5 the press asks nothing back: no question, no reason box");
	});
	await kaseAsync("§5 the shared login", async () => {
		const w = routesWorld(routesLib);
		const r = await w.press(SHARED);
		eq([r.status, w.rows.map((x) => x.details.endsWith(NOTE))], [200, [true, true]], "§5 FAILS ON THE OLD CODE: the shared login, its own id listed, presses; both rows say the shared login pressed, person not recorded");
		const nl = routesWorld(routesLib, { env: { ...ON, TRIUMPH_FACTOR_MARK_IDS: "7" } });
		eq([(await nl.press(SHARED)).status, nl.claim()], [403, null], "§5 the shared login not listed: 403, nothing written");
	});
	await kaseAsync("§5 the guards", async () => {
		const answer = async (opts, user = ME, mutate = null) => {
			const w = routesWorld(routesLib, opts);
			if (mutate) mutate(w);
			const r = await w.press(user);
			return [r.status, r.body && r.body.code, w.claim() ? "claim" : "none"];
		};
		eq(await answer({ env: { ...ON, TRIUMPH_PROCESS_BUTTON_ENABLED: "" } }), [404, "FEATURE_OFF", "none"], "§5 the switch off: 404, nothing written");
		eq(await answer({ env: { ...ON, TRIUMPH_PROCESS_BUTTON_ENABLED: "TRUE" } }), [404, "FEATURE_OFF", "none"], "§5 \"TRUE\" is not \"true\"");
		eq(await answer({ env: { ...ON, TRIUMPH_SUBMIT_DRY_RUN: "true" } }), [404, "FEATURE_OFF", "none"], "§5 FAILS ON THE OLD CODE: the submit mode dry: 404 (the button works only live)");
		eq(await answer({ env: { ...ON, TRIUMPH_FACTORING_ENABLED: "" } }), [404, "FEATURE_OFF", "none"], "§5 marking off: 404");
		eq(await answer({ hold: false }), [404, "FEATURE_OFF", "none"], "§5 FAILS ON THE OLD CODE: the re-issue hold off (no advance or DVIR reading is recorded): 404, the advance check fails closed");
		eq(await answer({ replica: true }), [404, "FEATURE_OFF", "none"], "§5 a replica: 404");
		eq(await answer({}, OTHER), [403, "FACTORING_NOT_LISTED", "none"], "§5 a Super Admin not listed: 403");
		eq(await answer({}, { id: 3, username: "made-up-dispatch", role: "Dispatcher" }), [403, "FORBIDDEN", "none"], "§5 a Dispatcher: 403 at the role gate");
		eq(await answer({}, ME, (w) => { w.crossSite = false; }), [403, "CROSS_SITE", "none"], "§5 cross-site: refused before the handler");
		eq(await answer({ transport: false }), [503, "TRANSPORT_UNCONFIGURED", "none"], "§5 FAILS ON THE OLD CODE: the connection unset: 503, nothing marked");
		eq(await answer({}, ME, (w) => ledger.setPause(w.db, { reason: "LOGIN_REFUSED" })), [503, "SUBMIT_PAUSED", "none"], "§5 FAILS ON THE OLD CODE: submitting paused: 503, nothing marked");
		eq(await answer({}, ME, (w) => { w.sheet = { headers: HEADERS, data: [] }; }), [409, "LOAD_NOT_ON_SHEET", "none"], "§5 a key off the sheet: refused");
		eq(await answer({}, ME, (w) => { w.sheet = null; }), [503, "FACTORING_SHEET_UNREADABLE", "none"], "§5 a sheet that can't be read: 503");
		eq(await answer({}, ME, (w) => { w.closedMonths = ["2026-11"]; }), [409, "MONTH_CLOSED", "none"], "§5 the server's own month check reaches the press");
		const changing = routesWorld(routesLib);
		const save = changing.routes.loadIdSave({ from: LOAD, to: "123456702" });
		const during = await changing.press();
		save.done();
		eq([during.status, during.body.code, changing.claim()], [409, "LOAD_ID_CHANGING", null], "§5 a Load ID change running: refused");
		const bad = routesWorld(routesLib);
		eq([(await bad.press(ME, {})).status, (await bad.press(ME, { loadId: ["x"] })).status], [400, 400], "§5 no load, or one that isn't text: 400");
	});
	await kaseAsync("§5 Try again", async () => {
		const w = routesWorld(routesLib);
		await w.press();
		ledger.transition(w.db, KEY, { from: ["queued"], nowIso: T0, patch: { state: "needs_attention", reason_code: "SUBMIT_FAILED", stage: "built" } });
		eq(w.dashboard().canRetry, true, "§5 FAILS ON THE OLD CODE: a stop a retry can change: the row offers Try again");
		const r = await w.retry();
		eq([r.status, w.claim().state, w.claim().invoice_id, w.claim().number_voided_at], [200, "queued", N, ""], "§5 FAILS ON THE OLD CODE: Try again: back in line with the same number, nothing voided");
		for (const code of factoring.BUTTON_STOPS) {
			ledger.transition(w.db, KEY, { from: ["queued", "needs_attention"], nowIso: T0, patch: { state: "needs_attention", reason_code: code } });
			const t = await w.retry();
			eq([t.status, t.body.code, w.claim().state, w.dashboard().canRetry], [409, "NOT_RETRYABLE", "needs_attention", false], `§5 FAILS ON THE OLD CODE: ${code}: no Try again (it would only repeat the stop)`);
		}
		ledger.transition(w.db, KEY, { from: ["needs_attention"], nowIso: T0, patch: { reason_code: "MAYBE_SUBMITTED", stage: "csv_uploading" } });
		eq([(await w.retry()).body.code, w.dashboard().canRetry], ["NOT_RETRYABLE", false], "§5 MAYBE_SUBMITTED: no Try again");
		const plain = routesWorld(routesLib);
		plain.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'script', ?, ?)").run(KEY, LOAD, T0, T0);
		ledger.insertClaim(plain.db, { key: KEY, loadId: LOAD, state: "needs_attention", code: "SUBMIT_FAILED", nowIso: T0 });
		eq((await plain.retry()).body.code, "NOT_RETRYABLE", "§5 a claim the button didn't arm: not this route's");
	});
	await kaseAsync("§5 Try again on a mark cleared since the page loaded", async () => {
		const w = routesWorld(routesLib);
		await w.press();
		ledger.transition(w.db, KEY, { from: ["queued"], nowIso: T0, patch: { state: "needs_attention", reason_code: "SUBMIT_FAILED", stage: "built" } });
		w.db.prepare("UPDATE load_factoring SET factored = 0 WHERE load_key = ?").run(KEY);
		const r = await w.retry();
		eq([r.status, r.body.code, w.claim().state], [409, "NOT_FACTORED", "needs_attention"], "§5 a cleared mark: Try again refused, nothing changed");
		eq(r.body.error, "This load's mark was cleared, so Try again can't send it: its invoice to the broker stands.", "§5 FAILS ON THE OLD CODE (L5): ...in words that say the mark was cleared");
	});
	await kaseAsync("§5 the plain mark while the switch is on", async () => {
		const w = routesWorld(routesLib);
		w.db.exec("DELETE FROM auto_invoice_claims; DELETE FROM load_invoice_drafts");
		const m = await w.mark(ME, { factored: true, reason: "made-up", loadId: LOAD });
		eq([m.status, m.body.code, m.body.error, w.marker()], [409, "MARK_BY_BUTTON", "While Process with Triumph is on, a load goes to Triumph only through its button.", null],
			"§5 FAILS ON THE OLD CODE: the mark route refuses factored: true while the switch is on (a page loaded before the deploy included)");
		eq(w.dashboard().canMark, false, "§5 FAILS ON THE OLD CODE: ...and no row offers the switch");
		w.db.prepare("INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES (?, ?, 1, 'script', ?, ?)").run(KEY, LOAD, T0, T0);
		eq(w.dashboard().canClear, true, "§5 FAILS ON THE OLD CODE: Clear factored on its own, for a factored load");
		const c = await w.mark(ME, { factored: false, reason: "made-up", loadId: LOAD });
		eq([c.status, w.marker().factored], [200, 0], "§5 ...and Clear factored still works");
	});
	await kaseAsync("§5 canProcess", async () => {
		const tile = (opts, mutate, user = ME) => {
			const w = routesWorld(routesLib, opts);
			if (mutate) mutate(w);
			return w.dashboard(user);
		};
		eq(tile({ env: { ...ON, TRIUMPH_SUBMIT_DRY_RUN: "true" } }).canProcess, false, "§5 FAILS ON THE OLD CODE: dry: no button");
		eq(tile({ hold: false }).canProcess, false, "§5 the hold off: no button");
		eq(tile({ transport: false }).canProcess, false, "§5 no connection: no button");
		eq(tile({}, (w) => ledger.setPause(w.db, { reason: "LOGIN_REFUSED" })).canProcess, false, "§5 paused: no button");
		eq(tile({}, null, OTHER), undefined, "§5 a Super Admin not listed: no row annotation at all (marking needs a listed account)");
		eq(tile({}, (w) => { w.row = sheetRow({ Email: "ap@example-broker.test" }); }).canProcess, false, "§5 FAILS ON THE OLD CODE: another broker's load: no button");
		eq(tile({}, (w) => { w.closedMonths = ["2026-11"]; }).canProcess, false, "§5 a closed month: no button");
		eq(tile({}, (w) => w.autoPatch({ sent_at: "2026-10-01T00:00:00.000Z" })).canProcess, false, "§5 an invoice sent long ago: no button");
	});
	await kaseAsync("§5 with the switch off, as before", async () => {
		const OFF = { ...LIVE, TRIUMPH_FACTORING_ENABLED: "true", TRIUMPH_FACTOR_MARK_IDS: "7,9" };
		const w = routesWorld(routesLib, { env: OFF });
		eq(Object.keys(w.dashboard()).sort(), ["canMark", "canRecordOutside", "factored", "lockedVia", "locked", "triumphState"].sort(), "§5 the switch off: each row carries exactly the keys it did before");
		eq([(await w.press()).status, (await w.retry()).status], [404, 404], "§5 ...and both routes answer 404");
		w.db.exec("DELETE FROM auto_invoice_claims; DELETE FROM load_invoice_drafts");
		eq((await w.mark(ME, { factored: true, reason: "made-up", loadId: LOAD })).status, 200, "§5 ...and the plain mark works as before");
	});
}

// ---------------------------------------------------------------- the run
(async () => {
	const P = PROCESS_SRC ? require(PROCESS_FILE) : null;
	checkPress(P);
	const routesLib = require(ROUTES_FILE);
	await checkRoutes(routesLib);

	section("§6 mutants: each money rule removed in turn, and a case catches it");
	const PRESS_MUTANTS = [
		["a load that isn't C.H. Robinson's taken", "if (!rateconDvirKeep.isChrLoad(row, headers)) return refusal(\"NOT_CHR\");", ""],
		["not delivered taken", "if (!autoRules.isCompletedStatus(status)) return refusal(\"NOT_DELIVERED\");", ""],
		["an existing claim taken (never twice)", "if (claim || (marker && Number(marker.factored) !== 0)) return { ...refusal(\"TRIUMPH_ALREADY\"), error: alreadyWords(claim, marker) };", "if (marker && Number(marker.factored) !== 0) return { ...refusal(\"TRIUMPH_ALREADY\"), error: alreadyWords(claim, marker) };"],
		["a stopped or cleared load said to be with Triumph (M1)", "error: alreadyWords(claim, marker) };", "error: WORDS.TRIUMPH_ALREADY };"],
		["a load on its way said to be stopped (M1)", "\tif (!factored || STOPPED_STATES.has(claim.state)) return ALREADY_WORDS.stopped;\n", "\tif (true) return ALREADY_WORDS.stopped;\n"],
		["a closed month taken", "if (!Array.isArray(closedMonths) || closedMonths.length) return refusal(\"MONTH_CLOSED\");", "if (Array.isArray(closedMonths) && closedMonths.length) return refusal(\"MONTH_CLOSED\");"],
		["the advance check skipped", "if (advanceDoubt(db, key)) return refusal(\"ADVANCE_ON_RATECON\");", ""],
		["an \"unread\" or 0-advance read passed", "return Boolean(db.prepare(`SELECT 1 FROM ${rateconAdvanceRead.TABLE} WHERE load_key = ? LIMIT 1`).get(recordKey(key)));",
			"return Boolean(db.prepare(`SELECT 1 FROM ${rateconAdvanceRead.TABLE} WHERE load_key = ? AND verdict <> 'unread' AND advance_cents > 0 LIMIT 1`).get(recordKey(key)));"],
		["an advance read that can't be read passed", "\t\treturn Boolean(db.prepare(`SELECT 1 FROM ${rateconAdvanceRead.TABLE} WHERE load_key = ? LIMIT 1`).get(recordKey(key)));\n\t} catch {\n\t\treturn true;",
			"\t\treturn Boolean(db.prepare(`SELECT 1 FROM ${rateconAdvanceRead.TABLE} WHERE load_key = ? LIMIT 1`).get(recordKey(key)));\n\t} catch {\n\t\treturn false;"],
		["the DVIR check skipped", "if (dvirDoubt(db, key)) return refusal(\"DVIR_LINES\");", ""],
		["a DVIR row with dvir_count 0 passed", "return Boolean(db.prepare(`SELECT 1 FROM ${DVIR_TABLE} WHERE load_key = ? LIMIT 1`).get(recordKey(key)));",
			"return Boolean(db.prepare(`SELECT 1 FROM ${DVIR_TABLE} WHERE load_key = ? AND dvir_count > 0 LIMIT 1`).get(recordKey(key)));"],
		["the payment date skipped", "if (paidFlag(db, key)) return refusal(\"PAID_ALREADY\");", ""],
		["the status column read as paid", "return Boolean(saved) && Number(saved.payments_payment_date) > 0;", "return Boolean(saved) && (Number(saved.payments_payment_date) > 0 || Number(saved.payments_status) > 0);"],
		["no age limit", "if (Date.parse(nowIso) - sentMs > maxAgeDays * DAY_MS) return refusal(\"INVOICE_TOO_OLD\");", ""],
		["an invoice not sent taken (a draft)", "if (!sending) {\n\t\tif (claim.stage === \"appending\" || claim.stage === \"appended\") return refusal(\"INVOICE_MAYBE_IN_GMAIL\");\n\t\treturn refusal(claim.state === \"drafted\" ? \"INVOICE_ALREADY_DRAFTED\" : \"NO_AUTO_INVOICE\");\n\t}", ""],
		["the exception for a hand draft", "if (rows.length > 1 || rows.some((r) => r.via !== autoRules.VIA_SEND)) return refusal(\"HAND_DRAFTED\");", ""],
		["the records' agreement skipped (changed_fields)", "|| claim.changed_fields) return refusal(\"INVOICE_RECORD_MISMATCH\");", ") return refusal(\"INVOICE_RECORD_MISMATCH\");"],
		["the totals not compared", "if (!total || String(row.total ?? \"\") !== total) return refusal(\"INVOICE_RECORD_MISMATCH\");", "if (!total) return refusal(\"INVOICE_RECORD_MISMATCH\");"],
		["the pause not read in the transaction", "if (pause) return refusal(\"SUBMIT_PAUSED\");", ""],
		["the dry run writes the mark and the claim", "if (dryRun) return { ok: true, reuse, wouldWrite:", "if (false) return { ok: true, reuse, wouldWrite:"],
		["a refused arm leaves the mark", "if (!armed.ok) throw Object.assign(new Error(`the claim wasn't armed: ${armed.code}`), { armRefused: armed.code });", "if (!armed.ok) return refusal(\"TRIUMPH_ALREADY\");"],
	];
	let caught = 0;
	for (const [name, from, to] of PRESS_MUTANTS) {
		if (!PROCESS_SRC || PROCESS_SRC.split(from).length - 1 !== 1) { failures.push(`mutant anchor not found once: ${name}`); continue; }
		const mine = [];
		sink = mine;
		try {
			const mutated = PROCESS_SRC.replace(from, () => to);
			checkPress(loadFrom(PROCESS_FILE, mutated), mutated);
		} catch (e) {
			mine.push(`threw ${e && e.message}`);
		}
		sink = failures;
		if (mine.length) { caught++; pass++; console.log(`  MUTANT ${name}: caught by ${caughtBy(mine)}`); }
		else failures.push(`MUTANT ${name}: NOT caught`);
	}
	const ROUTE_MUTANTS = [
		["the button shown in dry mode", "const buttonWorks = () => processButtonOn && markingOn && submitMode === \"live\" && d.reissueHoldOn === true;", "const buttonWorks = () => processButtonOn && markingOn && d.reissueHoldOn === true;"],
		["the button without the re-issue hold", "const buttonWorks = () => processButtonOn && markingOn && submitMode === \"live\" && d.reissueHoldOn === true;", "const buttonWorks = () => processButtonOn && markingOn && submitMode === \"live\";"],
		["the mark route taking factored: true", "if (processButtonOn && body.factored === true) return refuse(", "if (false) return refuse("],
		["the mark switch left visible", "canMark: markingOn && listed && !processButtonOn,", "canMark: markingOn && listed,"],
		["a press while paused or with no connection", "const blocked = sendingBlocked();\n\t\t\tif (blocked) {", "const blocked = \"\";\n\t\t\tif (blocked) {"],
		["the press from any Super Admin", "if (!mayMark(userOf(req))) {\n\t\t\t\tnotListed(res);", "if (false) {\n\t\t\t\tnotListed(res);"],
		["Try again on a code a retry can't change", "if (!store.buttonRetryable(claim)) return refuseButton(", "if (!claim) return refuseButton("],
	];
	let routeCaught = 0;
	for (const [name, from, to] of ROUTE_MUTANTS) {
		if (ROUTES_SRC.split(from).length - 1 !== 1) { failures.push(`route mutant anchor not found once: ${name}`); continue; }
		const mine = [];
		sink = mine;
		try {
			await checkRoutes(loadFrom(ROUTES_FILE, ROUTES_SRC.replace(from, () => to)));
		} catch (e) {
			mine.push(`threw ${e && e.message}`);
		}
		sink = failures;
		if (mine.length) { routeCaught++; pass++; console.log(`  MUTANT ${name}: caught by ${caughtBy(mine)}`); }
		else failures.push(`MUTANT ${name}: NOT caught`);
	}
	console.log(`  ${caught}/${PRESS_MUTANTS.length} press mutants and ${routeCaught}/${ROUTE_MUTANTS.length} route mutants caught`);

	// §7 (the Triumph status plan, N9): a press and a Try again that landed each tell every open dashboard
	// once; one refused tells none.
	section("§7 the press and Try again: dashboard:changed");
	async function checkNotices(lib) {
		await kaseAsync("§7 the press and Try again", async () => {
			const told = [];
			const w = routesWorld(lib, { notifyChange: (domain) => told.push(domain) });
			// What one step told: the notices since `from`.
			let from = told.length;
			eq([(await w.press()).status, told.slice(from)], [200, ["dashboard"]], "§7 FAILS ON THE OLD CODE (N9): a press that landed: one dashboard:changed");
			from = told.length;
			eq([(await w.press()).status, told.length - from], [409, 0], "§7 a second press, refused: none");
			ledger.transition(w.db, KEY, { from: ["queued"], nowIso: T0, patch: { state: "needs_attention", reason_code: "SUBMIT_FAILED", stage: "built" } });
			from = told.length;
			eq([(await w.retry()).status, told.slice(from)], [200, ["dashboard"]], "§7 FAILS ON THE OLD CODE (N9): a Try again that landed: one");
			ledger.transition(w.db, KEY, { from: ["queued"], nowIso: T0, patch: { state: "needs_attention", reason_code: "ADVANCE_ON_RATECON" } });
			from = told.length;
			eq([(await w.retry()).status, told.length - from], [409, 0], "§7 a Try again refused: none");
		});
	}
	await checkNotices(routesLib);
	let noticeCaught = 0;
	const NOTICE_MUTANTS = [
		["no notice after a press", "\t\t\tif (!r.ok) return refuseButton(req, res, loadId, r);\n\t\t\tdashboardChanged();\n", "\t\t\tif (!r.ok) return refuseButton(req, res, loadId, r);\n"],
		["no notice after Try again", "\t\t\tdashboardChanged();\n\t\t\treturn res.json({ ok: true, factoring: tileFor(user, gate.key) });\n\t\t});", "\t\t\treturn res.json({ ok: true, factoring: tileFor(user, gate.key) });\n\t\t});"],
	];
	for (const [name, from, to] of NOTICE_MUTANTS) {
		if (ROUTES_SRC.split(from).length - 1 !== 1) { failures.push(`§7 mutant anchor not found once: ${name}`); continue; }
		const mine = [];
		sink = mine;
		try {
			await checkNotices(loadFrom(ROUTES_FILE, ROUTES_SRC.replace(from, () => to)));
		} catch (e) {
			mine.push(`threw ${e && e.message}`);
		}
		sink = failures;
		if (mine.length) { noticeCaught++; pass++; console.log(`  MUTANT ${name}: caught by ${caughtBy(mine)}`); }
		else failures.push(`§7 MUTANT ${name}: NOT caught`);
	}
	console.log(`  ${noticeCaught}/${NOTICE_MUTANTS.length} mutants caught`);

	console.log(`\n${pass} passed, ${failures.length} failed`);
	for (const f of failures) console.log(`FAIL  ${f}`);
	process.exit(failures.length ? 1 : 0);
})().catch((e) => {
	console.log(`FAIL  the runner itself: ${e && e.stack}`);
	process.exit(1);
});
