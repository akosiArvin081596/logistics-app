#!/usr/bin/env node
// lib/auto-invoice-ledger.js: the SQLite ledger of the automatic invoice drafts.
//
//   §1 the schema: three tables, created only by ensureSchema(), idempotent; the
//      state and stage CHECKs refuse anything else
//   §2 claims: one per load; a move names the state it expects (and the lease
//      owner) and reports 0 when the claim had moved on; only claim columns
//   §3 leases: only a due queued claim; one owner; a takeover only once expired
//   §4 the invoice number: minted once, inside the check that the claim is still
//      ours and nobody drafted the load by hand; every retry reuses it
//   §5 two processes on one database file: one lease, one number
//   §6 meta and the opt-out settings
//   §7 the local records the rules read, on a database without some tables
//   §8 the shadow log keeps when a load was first seen
//   §9 counters and the queue order
//
// Made-up loads only (LD-TEST-*), in memory or a fresh temp folder.
//   node scripts/test-auto-invoice-ledger.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const L = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let pass = 0;
const failures = [];
function eq(actual, expected, label) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { pass++; return; }
	failures.push(`${label}\n      expected ${e}\n      actual   ${a}`);
}
function ok(cond, label) { eq(Boolean(cond), true, label); }
function throws(fn, label) {
	try { fn(); } catch { pass++; return; }
	failures.push(`${label}\n      expected a throw`);
}
function section(t) { console.log(`\n${t}`); }

const T0 = "2026-10-20T12:00:00.000Z";
const at = (min) => new Date(Date.parse(T0) + min * 60000).toISOString();
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);

// The server's own tables the ledger reads, as server.js creates them.
function serverTables(db) {
	db.exec(`
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT,
			recipient_source TEXT, total TEXT, broker_name TEXT, order_number TEXT, via TEXT, created_at TEXT, created_by TEXT,
			edited INTEGER DEFAULT 0, edited_fields TEXT DEFAULT '');
		CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
		CREATE TABLE bison_invoice_seq (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
	`);
}
// nextInvoiceNumber() in server.js, on a given handle.
const minter = (db) => {
	const stmt = db.prepare("INSERT INTO bison_invoice_seq (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 RETURNING n");
	const calls = [];
	const mint = (date) => {
		calls.push(date);
		return `10202026-${stmt.get("10202026").n}`;
	};
	return { mint, calls };
};

// ------------------------------------------------------------------ §1
section("§1  the schema");
const db = new Database(":memory:");
serverTables(db);
const before = tables(db);
ok(!L.hasSchema(db), "§1 nothing exists before ensureSchema()");
L.ensureSchema(db);
L.ensureSchema(db);
eq(tables(db).filter((t) => !before.includes(t) && t !== "sqlite_sequence"), ["auto_invoice_claims", "auto_invoice_meta", "auto_invoice_shadow"], "§1 three tables, and a second call changes nothing");
ok(L.hasSchema(db), "§1 hasSchema() sees them");
throws(() => db.prepare("INSERT INTO auto_invoice_claims (load_key, state, first_seen_at, updated_at) VALUES ('x', 'sent', ?, ?)").run(T0, T0), "§1 an unknown state is refused");
throws(() => db.prepare("INSERT INTO auto_invoice_claims (load_key, state, stage, first_seen_at, updated_at) VALUES ('x', 'queued', 'sent', ?, ?)").run(T0, T0), "§1 an unknown stage is refused");
throws(() => db.prepare("INSERT INTO auto_invoice_shadow (load_key, verdict, first_seen_at, updated_at) VALUES ('x', 'WOULD_SEND', ?, ?)").run(T0, T0), "§1 an unknown shadow verdict is refused");

// ------------------------------------------------------------------ §2
section("§2  claims");
eq(L.insertClaim(db, { key: "ld-test-0001", loadId: "LD-TEST-0001", state: "queued", nowIso: T0 }), 1, "§2 a new claim");
eq(L.insertClaim(db, { key: "ld-test-0001", loadId: "#LD-TEST-0001", state: "baseline", nowIso: at(1) }), 0, "§2 a second claim for the load is ignored");
const c1 = L.getClaim(db, "ld-test-0001");
eq([c1.state, c1.load_id, c1.first_seen_at, c1.next_attempt_at, c1.attempts, c1.stage], ["queued", "LD-TEST-0001", T0, T0, 0, ""], "§2 the first claim stands");
eq(L.transition(db, "ld-test-0001", { from: ["waiting"], patch: { state: "skipped" }, nowIso: at(2) }), 0, "§2 a move from a state the claim isn't in changes nothing");
eq(L.transition(db, "ld-test-0001", { from: ["queued"], owner: "worker-b", patch: { state: "skipped" }, nowIso: at(2) }), 0, "§2 a move for another owner changes nothing");
eq(L.transition(db, "ld-test-0001", { from: ["queued", "waiting"], patch: { reason_code: "RETRY_LATER" }, nowIso: at(2) }), 1, "§2 a move from the right state");
eq(L.getClaim(db, "ld-test-0001").updated_at, at(2), "§2 a move stamps updated_at");
throws(() => L.transition(db, "ld-test-0001", { from: ["queued"], patch: { "state = 'drafted', load_key": "x" }, nowIso: at(3) }), "§2 only claim columns can be patched");
eq(L.getClaim(db, "ld-test-0099"), null, "§2 no claim: null");

// ------------------------------------------------------------------ §3
section("§3  leases");
L.insertClaim(db, { key: "ld-test-0002", loadId: "LD-TEST-0002", state: "queued", nowIso: T0, nextAttemptAt: at(30) });
eq(L.lease(db, "ld-test-0002", "worker-a", { nowIso: at(10), untilIso: at(25) }), 0, "§3 a claim not yet due is not leased");
eq(L.lease(db, "ld-test-0002", "worker-a", { nowIso: at(30), untilIso: at(45) }), 1, "§3 a due claim is leased");
eq(L.lease(db, "ld-test-0002", "worker-b", { nowIso: at(30), untilIso: at(45) }), 0, "§3 a second worker gets nothing");
const leased = L.getClaim(db, "ld-test-0002");
eq([leased.state, leased.lease_owner, leased.lease_until], ["working", "worker-a", at(45)], "§3 the claim is working, for worker-a, until its lease ends");
eq(L.setStage(db, "ld-test-0002", "worker-b", "reserved", at(31)), 0, "§3 another worker can't move its stage");
eq(L.setStage(db, "ld-test-0002", "worker-a", "reserved", at(31)), 1, "§3 its owner can");
eq(L.takeOver(db, "ld-test-0002", "worker-b", { nowIso: at(40), untilIso: at(55) }), 0, "§3 no takeover while the lease runs");
eq(L.expiredWorking(db, at(40)).length, 0, "§3 nothing expired yet");
eq(L.expiredWorking(db, at(46)).map((c) => c.load_key), ["ld-test-0002"], "§3 expired once the lease ends");
eq(L.takeOver(db, "ld-test-0002", "worker-b", { nowIso: at(46), untilIso: at(61) }), 1, "§3 a takeover after it ends");
eq(L.getClaim(db, "ld-test-0002").lease_owner, "worker-b", "§3 the new owner holds it");

// ------------------------------------------------------------------ §4
section("§4  the invoice number");
const m = minter(db);
const reserve = (owner, minutes) => L.reserveNumber(db, "ld-test-0002", owner, {
	mint: m.mint, now: new Date(at(minutes)), dayKey: "2026-10-20", messageId: `<made-up-${minutes}.auto-invoice@example.com>`, nowIso: at(minutes),
});
eq(reserve("worker-a", 47), { ok: false, reason: "lost" }, "§4 a worker that lost the claim mints nothing");
eq(m.calls.length, 0, "§4 no number was minted for it");
const first = reserve("worker-b", 47);
eq(first, { ok: true, invoiceId: "10202026-1", invoiceDate: "2026-10-20", messageId: "<made-up-47.auto-invoice@example.com>", reused: false, voided: null }, "§4 the owner mints once");
const again = reserve("worker-b", 120);
eq(again, { ok: true, invoiceId: "10202026-1", invoiceDate: "2026-10-20", messageId: "<made-up-47.auto-invoice@example.com>", reused: true, voided: null }, "§4 a retry reuses the number, its date and its Message-ID");
eq(m.calls.length, 1, "§4 the sequence was called once");
{
	const s = new Database(":memory:");
	serverTables(s);
	L.ensureSchema(s);
	const ms = minter(s);
	L.insertClaim(s, { key: "ld-test-0004", loadId: "LD-TEST-0004", state: "queued", nowIso: T0 });
	L.lease(s, "ld-test-0004", "w", { nowIso: T0, untilIso: at(15) });
	const opts = (minutes, stale) => ({ mint: ms.mint, now: new Date(at(minutes)), dayKey: "2026-10-20", messageId: `<m${minutes}@example.com>`, nowIso: at(minutes), staleBeforeIso: stale });
	const r1 = L.reserveNumber(s, "ld-test-0004", "w", opts(0, at(-1440)));
	eq([r1.invoiceId, L.getClaim(s, "ld-test-0004").reserved_at], ["10202026-1", T0], "§4 the reservation's time is kept");
	eq(L.reserveNumber(s, "ld-test-0004", "w", opts(1439, at(-1))).reused, true, "§4 a reservation not yet stale is reused");
	const r2 = L.reserveNumber(s, "ld-test-0004", "w", { ...opts(1441, at(1)), dayKey: "2026-10-21" });
	eq([r2.reused, r2.invoiceId, r2.invoiceDate, r2.voided], [false, "10202026-2", "2026-10-21", { invoiceId: "10202026-1", invoiceDate: "2026-10-20" }], "§4 a stale reservation is given up and a fresh number minted");
	L.transition(s, "ld-test-0004", { from: ["working"], owner: "w", patch: { stage: "appending" }, nowIso: at(1442) });
	eq(L.reserveNumber(s, "ld-test-0004", "w", opts(4000, at(3999))).reused, true, "§4 a number that may be in Gmail (appending) is never replaced");
	s.close();
}
eq([L.getClaim(db, "ld-test-0002").stage, L.getClaim(db, "ld-test-0002").invoice_id], ["reserved", "10202026-1"], "§4 the claim holds the number at stage reserved");
db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, created_at) VALUES (?, ?, ?, ?)").run("LD-TEST-0002", "10202026-1", "auto-imap", at(50));
eq(L.otherDraftRows(db, L.getClaim(db, "ld-test-0002")).length, 0, "§4 the claim's own automatic row is not somebody else's draft");
eq(L.ownDraftRow(db, L.getClaim(db, "ld-test-0002")).invoice_id, "10202026-1", "§4 its own row is found by its number");
L.insertClaim(db, { key: "ld-test-0003", loadId: "LD-TEST-0003", state: "queued", nowIso: T0 });
L.lease(db, "ld-test-0003", "worker-a", { nowIso: at(1), untilIso: at(16) });
db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, created_at) VALUES (?, ?, ?, ?)").run("#ld-test-0003", "10202026-9", "imap", at(1));
const callsBefore = m.calls.length;
eq(L.reserveNumber(db, "ld-test-0003", "worker-a", { mint: m.mint, now: new Date(at(2)), dayKey: "2026-10-20", messageId: "<x.auto-invoice@example.com>", nowIso: at(2) }),
	{ ok: false, reason: "drafted" }, "§4 a hand draft (either spelling of the id) stops the mint");
eq(m.calls.length, callsBefore, "§4 and no number is used");
eq(L.draftRowsFor(db, "ld-test-0003").map((r) => r.invoice_id), ["10202026-9"], "§4 draftRowsFor() finds '#id' rows");
let failed = false;
try {
	L.reserveNumber(db, "ld-test-0001", "nobody", { mint: () => { throw new Error("boom"); }, now: new Date(T0), dayKey: "2026-10-20", messageId: "<y@example.com>", nowIso: T0 });
} catch { failed = true; }
eq(failed, false, "§4 a claim that isn't working never reaches the mint");

// ------------------------------------------------------------------ §5
section("§5  two processes on one database file");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "auto-invoice-ledger-"));
try {
	const file = path.join(TMP, "app.db");
	const a = new Database(file);
	a.pragma("journal_mode = WAL");
	serverTables(a);
	L.ensureSchema(a);
	const b = new Database(file);
	b.pragma("busy_timeout = 2000");
	a.pragma("busy_timeout = 2000");
	L.ensureSchema(b);
	eq(L.insertClaim(a, { key: "ld-test-0010", loadId: "LD-TEST-0010", state: "queued", nowIso: T0 }) + L.insertClaim(b, { key: "ld-test-0010", loadId: "LD-TEST-0010", state: "queued", nowIso: T0 }), 1, "§5 both insert the claim: one row");
	const got = [L.lease(a, "ld-test-0010", "proc-a", { nowIso: at(1), untilIso: at(16) }), L.lease(b, "ld-test-0010", "proc-b", { nowIso: at(1), untilIso: at(16) })];
	eq(got, [1, 0], "§5 both lease it: one wins");
	const ma = minter(a);
	const mb = minter(b);
	const ra = L.reserveNumber(a, "ld-test-0010", "proc-a", { mint: ma.mint, now: new Date(at(2)), dayKey: "2026-10-20", messageId: "<a@example.com>", nowIso: at(2) });
	const rb = L.reserveNumber(b, "ld-test-0010", "proc-b", { mint: mb.mint, now: new Date(at(2)), dayKey: "2026-10-20", messageId: "<b@example.com>", nowIso: at(2) });
	eq([ra.ok, rb.ok, rb.reason], [true, false, "lost"], "§5 only the owner reserves");
	eq([ma.calls.length, mb.calls.length], [1, 0], "§5 one number minted in all");
	eq(b.prepare("SELECT invoice_id FROM auto_invoice_claims WHERE load_key = 'ld-test-0010'").get().invoice_id, ra.invoiceId, "§5 the other process reads the same number");
	a.close();
	b.close();
} finally {
	fs.rmSync(TMP, { recursive: true, force: true });
}

// ------------------------------------------------------------------ §6
section("§6  meta and settings");
eq(L.getMeta(db), {}, "§6 no meta yet");
L.setMeta(db, "baseline_at", T0);
L.setMeta(db, "baseline_at", at(5));
L.setMeta(db, "off_gap_since", "");
eq(L.getMeta(db), { baseline_at: at(5), off_gap_since: "" }, "§6 meta is one value per key");
eq(L.readSettings(db), { optOutDomains: [], unreadable: false }, "§6 no settings row: nothing opted out");
L.writeSettings(db, { optOutDomains: ["example-broker.test"] }, { by: "made-up-admin", nowIso: T0 });
eq(L.readSettings(db), { optOutDomains: ["example-broker.test"], unreadable: false }, "§6 settings round-trip");
eq(db.prepare("SELECT updated_by, updated_at FROM app_settings WHERE key = ?").get(L.SETTINGS_KEY), { updated_by: "made-up-admin", updated_at: T0 }, "§6 who changed them and when");
db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run("{not json", L.SETTINGS_KEY);
eq(L.readSettings(db), { optOutDomains: [], unreadable: true }, "§6 an unreadable value fails closed (unreadable)");
db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(JSON.stringify({ optOutDomains: ["ok.example.test", "not a domain"] }), L.SETTINGS_KEY);
eq(L.readSettings(db), { optOutDomains: [], unreadable: true }, "§6 a list with a bad entry fails closed too");
const bare = new Database(":memory:");
eq(L.readSettings(bare), { optOutDomains: [], unreadable: false }, "§6 no app_settings table: nothing opted out");

// ------------------------------------------------------------------ §7
section("§7  local records");
eq(L.readRecords(bare), { documents: [], drafts: [], deletedLoads: [] }, "§7 a database without the tables reads empty");
eq(L.activeAdvanceLines(bare, "ld-test-0001"), 0, "§7 no advance-lines table (its flag never on): no lines");
{
	const lines = new Database(":memory:");
	lines.exec("CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL)");
	const invoiceLines = require(path.join(ROOT, "lib", "broker-invoice.js")).invoiceLines;
	invoiceLines.ensureSchema(lines);
	const add = lines.prepare(`INSERT INTO ${invoiceLines.TABLE} (load_id, load_key, kind, label, amount_cents) VALUES (?, ?, 'advance', 'Fuel advance', 65000)`);
	add.run("#LD-TEST-0001", "ld-test-0001");
	add.run("LD-TEST-0001", "ld-test-0001");
	lines.prepare(`UPDATE ${invoiceLines.TABLE} SET voided_at = '2026-10-20T12:00:00Z', voided_by = 'made-up', void_reason = 'made-up' WHERE id = 2`).run();
	eq([L.activeAdvanceLines(lines, "ld-test-0001"), L.activeAdvanceLines(lines, "ld-test-0002")], [1, 0], "§7 active advance lines through their own module: a voided one doesn't count");
	lines.close();
}
const LEDGER_SRC = fs.readFileSync(path.join(ROOT, "lib", "auto-invoice-ledger.js"), "utf8");
ok(!/broker_invoice_lines|broker-invoice-lines/.test(LEDGER_SRC), "§7 the ledger never names the lines table or module (lib/broker-invoice.js hands it over)");
bare.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, load_id TEXT, type TEXT, file_name TEXT, drive_file_id TEXT, drive_url TEXT, uploaded_at TEXT)");
bare.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES (?, ?, ?, ?)").run("LD-TEST-0001", "POD", "pod.pdf", "2026-10-01 12:00:00");
bare.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at) VALUES (?, ?, ?, ?)").run("LD-TEST-0001", "Receipt", "r.jpg", "2026-10-01 12:00:00");
eq(L.readRecords(bare).documents.map((d) => d.type), ["POD"], "§7 a documents table without deleted_at: PODs and rate cons only");
bare.exec("ALTER TABLE documents ADD COLUMN deleted_at TEXT");
bare.prepare("INSERT INTO documents (load_id, type, file_name, uploaded_at, deleted_at) VALUES (?, ?, ?, ?, ?)").run("LD-TEST-0001", "RATECON", "rc.pdf", "2026-10-01 12:00:00", "2026-10-02 12:00:00");
eq(L.readRecords(bare).documents.length, 1, "§7 a deleted document is left out");
bare.close();

// ------------------------------------------------------------------ §8
section("§8  the shadow log");
L.upsertShadow(db, { key: "ld-test-0020", loadId: "LD-TEST-0020", verdict: "WOULD_WAIT", code: "WAITING_POD", nowIso: T0 });
L.upsertShadow(db, { key: "ld-test-0020", loadId: "LD-TEST-0020", verdict: "WOULD_ATTEMPT", readyAt: at(30), nowIso: at(30) });
const sh = L.getShadow(db, "ld-test-0020");
eq([sh.first_seen_at, sh.ready_at, sh.verdict, sh.reason_code, sh.updated_at], [T0, at(30), "WOULD_ATTEMPT", "", at(30)], "§8 first seen is kept; the verdict and ready time move");
eq(L.shadowCounts(db), { BASELINE: 0, WOULD_ATTEMPT: 1, WOULD_WAIT: 0, WOULD_NEED_ATTENTION: 0, WOULD_SKIP: 0 }, "§8 counts by verdict");

// ------------------------------------------------------------------ §9
section("§9  counters and the queue");
const q = new Database(":memory:");
serverTables(q);
L.ensureSchema(q);
L.insertClaim(q, { key: "b", loadId: "B", state: "queued", nowIso: T0, nextAttemptAt: at(5) });
L.insertClaim(q, { key: "a", loadId: "A", state: "queued", nowIso: at(1), nextAttemptAt: at(5) });
L.insertClaim(q, { key: "c", loadId: "C", state: "queued", nowIso: T0, nextAttemptAt: at(2) });
L.insertClaim(q, { key: "d", loadId: "D", state: "queued", nowIso: T0, nextAttemptAt: at(60) });
eq(L.nextQueued(q, at(10)).load_key, "c", "§9 the earliest due first");
L.transition(q, "c", { from: ["queued"], patch: { state: "drafted", drafted_at: at(9) }, nowIso: at(9) });
eq(L.nextQueued(q, at(10)).load_key, "b", "§9 then, at the same due time, the first seen");
eq(L.nextQueued(q, at(1)), null, "§9 nothing due yet");
L.lease(q, "b", "w", { nowIso: at(10), untilIso: at(25) });
eq([L.inFlight(q, at(11)), L.inFlight(q, at(26))], [1, 0], "§9 in flight while the lease runs");
eq([L.draftedSince(q, at(0)), L.draftedSince(q, at(10))], [1, 0], "§9 drafted since a time");
eq(L.countsByState(q), { baseline: 0, waiting: 0, queued: 2, working: 1, drafted: 1, needs_attention: 0, skipped: 0 }, "§9 counts by state");
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(L.getClaim(q, "a").first_seen_at), "§9 times are ISO 'Z' strings");
q.close();
db.close();

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
