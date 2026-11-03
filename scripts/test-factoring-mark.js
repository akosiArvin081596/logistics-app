#!/usr/bin/env node
// scripts/factoring-mark.js: the lead's script that marks loads factored, or
// clears marks, from a list.
//
//   §1 --dry-run writes nothing (the file's bytes are the same after it) and says
//      what --apply would do
//   §2 --apply: the same checks as the route; a changed load gets one audit row
//      as the system actor; a replay changes nothing and audits nothing
//   §3 --clear leaves a locked row as it is, in both modes, and counts it
//   §4 the command line: every refusal exits 2, with nothing written
//   §5 mutants: each rule removed, and a case catches it
//
// Made-up loads only (LD-TEST-*), in a fresh temp folder.
//   node scripts/test-factoring-mark.js      # exits 1 on any failure
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "factoring-mark.js");
const SCRIPT_SRC = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, "utf8") : "";
const ledger = require(path.join(ROOT, "lib", "auto-invoice-ledger.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));
const optional = (p) => {
	try {
		return require(p);
	} catch {
		return null;
	}
};
const store = optional(path.join(ROOT, "lib", "factoring-store.js"));

let pass = 0;
const failures = [];
function section(t) { console.log(`\n${t}`); }
function checker() {
	const out = [];
	let n = 0;
	const eq = (a, e, label) => { n++; const A = JSON.stringify(a); const E = JSON.stringify(e); if (A !== E) out.push(`${label}\n      expected ${E}\n      actual   ${A}`); };
	return { eq, ok: (c, label) => eq(Boolean(c), true, label), out, count: () => n };
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "factoring-mark-"));
const NOW = "2026-11-03T15:00:00.000Z";
let files = 0;

// A database as the app leaves it: the audit trail, the draft rows, the auto
// job's claims and the factoring tables.
function makeDb() {
	const file = path.join(TMP, `app-${++files}.db`);
	const db = new Database(file);
	db.exec(`CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
		action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
		CREATE TABLE load_invoice_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, load_id TEXT NOT NULL, invoice_id TEXT, recipient TEXT, via TEXT, created_at TEXT, created_by TEXT);`);
	ledger.ensureSchema(db);
	if (store) store.ensureSchema(db);
	db.prepare("INSERT INTO load_invoice_drafts (load_id, invoice_id, via, created_at) VALUES ('LD-TEST-0003', '11022026-7', 'imap', ?)").run(NOW);
	db.prepare(`INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, locked_at, locked_via, updated_at) VALUES ('ld-test-0004', 'LD-TEST-0004', 1, 'script', ?, ?, 'outside', ?)`).run(NOW, NOW, NOW);
	db.prepare(`INSERT INTO load_factoring (load_key, load_id, factored, source, set_at, updated_at) VALUES ('ld-test-0005', 'LD-TEST-0005', 1, 'script', ?, ?)`).run(NOW, NOW);
	db.close();
	return file;
}
const read = (file) => {
	const db = new Database(file, { readonly: true });
	const out = {
		markers: db.prepare("SELECT load_key, factored, source, locked_at FROM load_factoring ORDER BY load_key").all(),
		audits: db.prepare("SELECT user_id, username, role, action, entity_id FROM audit_trail ORDER BY id").all(),
	};
	db.close();
	return out;
};
const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60000 });

function mod(src) {
	const m = { exports: {} };
	new Function("module", "exports", "require", "__dirname", src.replace(/^#!.*\n/, ""))(m, m.exports, Module.createRequire(SCRIPT), path.dirname(SCRIPT));
	return m.exports;
}

// The run() cases, on a script built from `src` (the shipped one, or a mutant).
function checkRun(src) {
	const c = checker();
	const S = mod(src);
	const file = makeDb();
	const bytes = fs.readFileSync(file);
	const ids = ["LD-TEST-0001", "#ld-test-0002", "LD-TEST-0003", "LD-TEST-0004", "LD-TEST-0001"];
	const ro = new Database(file, { readonly: true });
	const dry = S.run({ db: ro, ids, mode: "mark", dryRun: true, reason: "made-up: D's list", nowIso: NOW });
	ro.close();
	c.eq(fs.readFileSync(file).equals(bytes), true, "§1 --dry-run: the database file is byte for byte the same");
	c.eq(dry.counts, { asked: 5, duplicate: 1, changed: 2, unchanged: 0, locked: 1, refused: 1, refusedBy: { INVOICE_ALREADY_DRAFTED: 1 } },
		"§1 --dry-run says what --apply would do: two marked, one locked, one already drafted, a repeat counted once");
	c.eq(dry.loads.map((l) => `${l.load}:${l.outcome}:${l.code}`), ["...0001:changed:", "...0002:changed:", "...0003:refused:INVOICE_ALREADY_DRAFTED", "...0004:locked:FACTORING_LOCKED"],
		"§1 ...each load by its last four characters");

	const db = new Database(file);
	const applied = S.run({ db, ids, mode: "mark", dryRun: false, reason: "made-up: D's list", nowIso: NOW });
	db.close();
	c.eq(applied.counts, dry.counts, "§2 --apply does what the dry run said");
	const after = read(file);
	c.eq(after.markers.map((m) => [m.load_key, m.factored, m.source]), [["ld-test-0001", 1, "script"], ["ld-test-0002", 1, "script"], ["ld-test-0004", 1, "script"], ["ld-test-0005", 1, "script"]],
		"§2 the two loads are marked (source script); the drafted load is not");
	c.eq(after.audits, [
		{ user_id: 0, username: "factoring-mark", role: "system", action: "factoring_marked", entity_id: "LD-TEST-0001" },
		{ user_id: 0, username: "factoring-mark", role: "system", action: "factoring_marked", entity_id: "#ld-test-0002" },
	], "§2 one audit row per change, as the system actor");
	const db2 = new Database(file);
	const replay = S.run({ db: db2, ids, mode: "mark", dryRun: false, reason: "made-up: D's list", nowIso: NOW });
	db2.close();
	c.eq([replay.counts.changed, replay.counts.unchanged, read(file).audits.length], [0, 2, 2], "§2 a replay changes nothing and audits nothing");

	const clearIds = ["LD-TEST-0004", "LD-TEST-0005", "LD-TEST-0001"];
	const ro2 = new Database(file, { readonly: true });
	const dryClear = S.run({ db: ro2, ids: clearIds, mode: "clear", dryRun: true, reason: "made-up: stop factoring", nowIso: NOW });
	ro2.close();
	c.eq([dryClear.counts.changed, dryClear.counts.locked], [2, 1], "§3 --clear --dry-run: the locked row is left and counted");
	const db3 = new Database(file);
	const cleared = S.run({ db: db3, ids: clearIds, mode: "clear", dryRun: false, reason: "made-up: stop factoring", nowIso: NOW });
	db3.close();
	const end = read(file);
	c.eq([cleared.counts.changed, cleared.counts.locked], [2, 1], "§3 --clear --apply: the same counts");
	c.eq(end.markers.map((m) => [m.load_key, m.factored, Boolean(m.locked_at)]), [["ld-test-0001", 0, false], ["ld-test-0002", 1, false], ["ld-test-0004", 1, true], ["ld-test-0005", 0, false]],
		"§3 the locked row stays factored and locked; the others are cleared");
	c.eq(end.audits.filter((a) => a.action === "factoring_cleared").map((a) => a.entity_id), ["LD-TEST-0005", "LD-TEST-0001"], "§3 one factoring_cleared row per change");
	return c;
}

function checkCli() {
	const c = checker();
	const file = makeDb();
	const before = fs.readFileSync(file);
	const base = [`--db=${file}`, "--mark", "--loads=LD-TEST-0001", "--reason=made-up"];
	for (const [label, args] of [
		["no --dry-run or --apply", base],
		["both --dry-run and --apply", [...base, "--dry-run", "--apply"]],
		["no --reason", [`--db=${file}`, "--mark", "--loads=LD-TEST-0001", "--apply"]],
		["both --mark and --clear", [...base, "--clear", "--apply"]],
		["no --db", ["--mark", "--loads=LD-TEST-0001", "--reason=made-up", "--apply"]],
		["a Load ID that isn't one", [`--db=${file}`, "--mark", "--loads=LD-TEST-0001,<x>", "--reason=made-up", "--apply"]],
		["an unknown argument", [...base, "--apply", "--force"]],
	]) {
		const r = cli(args);
		c.eq(r.status, 2, `§4 ${label}: exit 2`);
	}
	c.eq(fs.readFileSync(file).equals(before), true, "§4 ...and nothing was written");
	const bare = path.join(TMP, "bare.db");
	new Database(bare).close();
	c.eq(cli([`--db=${bare}`, "--mark", "--loads=LD-TEST-0001", "--reason=made-up", "--apply"]).status, 2, "§4 a database without the tables: exit 2");
	c.eq(cli([`--db=${path.join(TMP, "none.db")}`, "--mark", "--loads=LD-TEST-0001", "--reason=made-up", "--dry-run"]).status, 2, "§4 a --db that names no file: exit 2, none made");
	c.eq(fs.existsSync(path.join(TMP, "none.db")), false, "§4 ...no file was created");
	const dry = cli([`--db=${file}`, "--mark", "--loads=LD-TEST-0001", "--reason=made-up", "--dry-run"]);
	c.eq([dry.status, /DRY RUN \(nothing written\)/.test(dry.stdout), fs.readFileSync(file).equals(before)], [0, true, true], "§4 --dry-run from the command line: exit 0, says so, writes nothing");
	const applied = cli([`--db=${file}`, "--mark", "--loads=LD-TEST-0001", "--reason=made-up", "--apply", "--json"]);
	let parsed = null;
	try { parsed = JSON.parse(applied.stdout); } catch { parsed = null; }
	c.eq([applied.status, parsed && parsed.counts.changed, read(file).markers.some((m) => m.load_key === "ld-test-0001")], [0, 1, true], "§4 --apply from the command line marks it");
	c.ok(!/made-up/.test(dry.stdout) && !/LD-TEST-0001/.test(dry.stdout), "§4 the output carries no reason and no full Load ID");
	return c;
}

section("§1-§3  run()");
let c = SCRIPT_SRC ? checkRun(SCRIPT_SRC) : { out: ["scripts/factoring-mark.js is missing"], count: () => 1 };
pass += c.count() - c.out.length;
failures.push(...c.out);
console.log(`  ${c.count() - c.out.length}/${c.count()} ok`);
section("§4  the command line");
c = SCRIPT_SRC ? checkCli() : { out: ["scripts/factoring-mark.js is missing"], count: () => 1 };
pass += c.count() - c.out.length;
failures.push(...c.out);
console.log(`  ${c.count() - c.out.length}/${c.count()} ok`);

section("§5  mutants");
for (const [name, from, to] of [
	["--dry-run writes", "const args = { key, loadId, reason, source: \"script\", actor: ACTOR, nowIso, audit, dryRun };", "const args = { key, loadId, reason, source: \"script\", actor: ACTOR, nowIso, audit: dryRun ? () => {} : audit, dryRun: false };"],
	["a locked row counted as refused", "else if (r.code === \"FACTORING_LOCKED\") outcome = \"locked\";", ""],
	["a repeated Load ID run twice", "if (seen.has(key)) {", "if (false) {"],
]) {
	if (SCRIPT_SRC.split(from).length - 1 !== 1) { failures.push(`mutant anchor not found once: ${name}`); continue; }
	let m;
	try { m = checkRun(SCRIPT_SRC.replace(from, to)); } catch (e) { m = { out: [`threw: ${e && e.message}`] }; }
	if (m.out.length) { pass++; console.log(`  MUTANT ${name}: caught`); } else failures.push(`MUTANT ${name}: NOT caught`);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
