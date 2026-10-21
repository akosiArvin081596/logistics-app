#!/usr/bin/env node
/**
 * scripts/data-fix-driver-rates.js: the data fix that gives a daily-rate
 * driver a dated rate schedule (pay plan 2026-10-21, decisions a and b; #547's
 * dated rates read it).
 *
 * Written before the script: on the base every case fails, because the script
 * does not exist there.
 *
 * Made-up data only. Pat Sample drives T-11 ($160 a day on the truck) with no
 * rate of his own ($0, a $0 seed row); the plan gives him $160 from Thu Oct 1,
 * his Drivers Database rate included. Lee Rowan drives T-12 at $360 (a $360
 * seed row); the plan gives him $310 through Oct 1 and $360 from Fri Oct 2.
 * Kim Doe is not in the plan. The seed rows are dated Fri 10/2, 11 PM Eastern
 * (2026-10-03T03:00:20.343Z). August and September are closed.
 *
 * Cases:
 *   F1  the dry run writes nothing (the file is byte-identical) and prints the
 *       five writes with their references, the October table and the V2 listing
 *   F2  the apply writes exactly those five, each with a system audit row
 *   F3  after the apply, the server's own dated reader (loadPayRateIndex(),
 *       lifted) reads the plan's rates, and recordPayRateChanges() adds nothing
 *   F4  idempotent: a second apply writes 0 rows and exits 0; a dry run says
 *       "already applied"
 *   F5  a dated row in a closed month is refused, nothing written
 *   F6  a Drivers Database rate change the month lock refuses (the truck rate
 *       differs, so a closed month would reprice) is refused, nothing written
 *   F7  an ambiguous driver name (two Drivers Database rows) and an unknown one
 *       are refused, nothing written
 *   F8  PAYOUT_RULES_V2 on: the closed-month days the new first row reaches are
 *       refused, nothing written
 *   F9  a month closed under the daily-rate rule refuses any changed day
 *   F10 uncertain states are skipped and the apply writes nothing for anyone: a
 *       rate a person saved after the plan's first day, a Drivers Database rate
 *       the plan does not expect, a written reference whose row is gone
 *   F11 the apply needs the plan's approval; a plan naming an approval the
 *       script does not list is refused
 *   F12 #547's rate runners still pass
 *
 * Run: node scripts/test-data-fix-driver-rates.js    # exits 1 on failure
 */
"use strict";
process.env.TZ = "UTC"; // production's clock zone

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "data-fix-driver-rates.js");
const ACTOR = "system: data-fix-driver-rates";
const APPROVAL = "arvin-2026-10-21-a-b";

let pass = 0, fail = 0;
function check(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); }
	else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

if (!fs.existsSync(SCRIPT)) die("scripts/data-fix-driver-rates.js does not exist");
let Database;
try { Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }
const { closure } = require("./lib/server-lift");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "driver-rates-fix-test-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// The production schema of every table the script reads or writes.
const SCHEMA = `
CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE investor_payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, period TEXT NOT NULL, amount REAL NOT NULL, due_date TEXT NOT NULL, status TEXT DEFAULT 'owed' CHECK(status IN ('owed','processing','paid')), processed_at TEXT, processed_by TEXT, paid_at TEXT, paid_by TEXT, notes TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, adjustment REAL DEFAULT 0, adjustment_note TEXT DEFAULT '', adjusted_by TEXT DEFAULT '', adjusted_at TEXT DEFAULT '', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', finalized_at TEXT DEFAULT '', finalized_amount REAL, finalized_breakdown TEXT DEFAULT '', statement_pdf_file_name TEXT DEFAULT '', UNIQUE(owner_id, period));
CREATE TABLE investor_payout_history (id INTEGER PRIMARY KEY AUTOINCREMENT, payout_id INTEGER, owner_id INTEGER NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'recompute', old_amount REAL, new_amount REAL, delta REAL, detail TEXT DEFAULT '', breakdown TEXT DEFAULT '', actor TEXT DEFAULT '', changed_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE financials_ledger_items (id INTEGER PRIMARY KEY AUTOINCREMENT, period TEXT NOT NULL, owner_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, adjusts TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '', cents INTEGER NOT NULL, load_id TEXT NOT NULL DEFAULT '', driver TEXT NOT NULL DEFAULT '', truck TEXT NOT NULL DEFAULT '', expense_id INTEGER, source_id INTEGER, expense_type TEXT NOT NULL DEFAULT '', pay_type TEXT NOT NULL DEFAULT '', pickup_state TEXT NOT NULL DEFAULT '', delivery_state TEXT NOT NULL DEFAULT '', freeze_id TEXT NOT NULL, frozen_at TEXT NOT NULL);
CREATE TABLE financials_ledger_freezes (freeze_id TEXT PRIMARY KEY, period TEXT NOT NULL, source TEXT NOT NULL, frozen_at TEXT NOT NULL, frozen_by TEXT NOT NULL DEFAULT 'system', item_count INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '', released_at TEXT NOT NULL DEFAULT '');
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '');
CREATE TABLE pay_rate_history (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL CHECK(subject IN ('truck','driver')), subject_key TEXT NOT NULL, rate REAL NOT NULL, effective_from TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'change');
CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL, owner_id INTEGER DEFAULT 0, driver_pay_daily REAL DEFAULT 0, assigned_driver TEXT DEFAULT '', status TEXT DEFAULT 'Active');
CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT NOT NULL UNIQUE, carrier_name TEXT DEFAULT '', user_id INTEGER DEFAULT 0, pay_daily REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'active', pay_type TEXT DEFAULT 'fixed', pay_percentage REAL DEFAULT 0);
`;
const SEED_AT = "2026-10-03T03:00:20.343Z";
const OCT1_ET = "2026-10-01T04:00:00.000Z";
const OCT2_ET = "2026-10-02T04:00:00.000Z";
// A literal for a RegExp: every character the pattern syntax reads, escaped.
const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildFixture(name, o = {}) {
	const opt = { patTruckRate: 160, leeRate: 360, extraPat: false, history: [], settings: [], ...o };
	const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(SCHEMA);
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-08', 'locked', '2026-09-08T05:00:00.000Z'), ('2026-09', 'locked', '2026-10-08T05:00:25.792Z')").run();
	db.prepare("INSERT INTO trucks (id, unit_number, owner_id, driver_pay_daily, assigned_driver) VALUES (11, 'T-11', 5, ?, 'Pat Sample'), (12, 'T-12', 5, 200, 'Lee Rowan'), (13, 'T-13', 6, 280, 'Kim Doe')").run(opt.patTruckRate);
	db.prepare("INSERT INTO drivers_directory (id, driver_name, pay_daily) VALUES (1, 'Pat Sample', 0), (2, 'Lee Rowan', ?), (3, 'Kim Doe', 280)").run(opt.leeRate);
	if (opt.extraPat) db.prepare("INSERT INTO drivers_directory (id, driver_name, pay_daily) VALUES (4, 'pat  sample', 0)").run();
	const seed = db.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES (?, ?, ?, ?, 'seed')");
	seed.run("truck", "11", opt.patTruckRate, SEED_AT);
	seed.run("truck", "12", 200, SEED_AT);
	seed.run("truck", "13", 280, SEED_AT);
	seed.run("driver", "pat sample", 0, SEED_AT);
	seed.run("driver", "lee rowan", opt.leeRate, SEED_AT);
	seed.run("driver", "kim doe", 280, SEED_AT);
	for (const h of opt.history) db.prepare("INSERT INTO pay_rate_history (subject, subject_key, rate, effective_from, source) VALUES ('driver', ?, ?, ?, ?)").run(h.key, h.rate, h.from, h.source);
	for (const [k, v] of opt.settings) db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run(k, JSON.stringify(v));
	db.prepare("INSERT INTO financials_ledger_freezes (freeze_id, period, source, frozen_at, item_count) VALUES ('2026-09:close:1', '2026-09', 'close', '2026-10-08T05:00:25.792Z', 2)").run();
	db.prepare("INSERT INTO financials_ledger_items (period, owner_id, kind, day, cents, driver, truck, pay_type, freeze_id, frozen_at) VALUES ('2026-09', 5, 'driver_pay', '2026-09-14', 15000, 'pat sample', 'T-11', 'fixed', '2026-09:close:1', '2026-10-08T05:00:25.792Z'), ('2026-09', 5, 'driver_pay', '2026-09-15', 30000, 'lee rowan', 'T-12', 'fixed', '2026-09:close:1', '2026-10-08T05:00:25.792Z')").run();
	db.prepare("INSERT INTO investor_payouts (owner_id, period, amount, due_date, finalized_at) VALUES (5, '2026-09', 1234.5, '2026-10-15', '2026-10-08T05:00:25.792Z')").run();
	db.close();
	return file;
}

const PLAN = {
	approval: APPROVAL,
	drivers: [
		{ name: "Pat Sample", expect: { payDaily: 0 }, payDaily: 160, rates: [{ from: "2026-10-01", rate: 160 }] },
		{ name: "Lee Rowan", expect: { payDaily: 360 }, rates: [{ from: "2026-10-01", rate: 310 }, { from: "2026-10-02", rate: 360 }] },
	],
};
function planFile(name, plan = PLAN) {
	const f = path.join(TMP, `${name}-plan.json`);
	fs.writeFileSync(f, JSON.stringify(plan));
	return f;
}
function envFile(name, extra = "") {
	const f = path.join(TMP, `${name}-flags.txt`);
	fs.writeFileSync(f, `APP_TIMEZONE=America/New_York\n${extra}`);
	return f;
}
function run(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), TZ: "UTC", APP_TIMEZONE: "America/New_York" } });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const dry = (db, plan, env) => run([`--plan=${plan}`, "--dry-run", `--db=${db}`, `--env-file=${env}`]);
const applyRun = (db, plan, env, approval = APPROVAL) => run([`--plan=${plan}`, `--approval=${approval}`, `--db=${db}`, `--env-file=${env}`]);
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function rows(file, sql, ...p) {
	const db = new Database(file, { readonly: true });
	try { return db.prepare(sql).all(...p); } finally { db.close(); }
}
const counts = (file) => ({
	history: rows(file, "SELECT COUNT(*) AS n FROM pay_rate_history")[0].n,
	audit: rows(file, "SELECT COUNT(*) AS n FROM audit_trail")[0].n,
	pat: rows(file, "SELECT pay_daily FROM drivers_directory WHERE id = 1")[0].pay_daily,
});

// The server's own reader and recorder, lifted and bound to a database.
let LIFT = null;
function serverRates(file) {
	if (!LIFT) LIFT = closure(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"), { roots: ["loadPayRateIndex", "recordPayRateChanges"], provided: ["db", "require", "console", "process"], denied: ["server", "io", "getSheets", "sendEmail"] });
	const db = new Database(file);
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const api = new Function("db", "require", "console", "process", `"use strict";\n${LIFT.text}\nreturn { loadPayRateIndex, recordPayRateChanges };`)(
		db, appRequire, { log() {}, warn() {}, error() {} }, { env: { APP_TIMEZONE: "America/New_York" } });
	return { db, ...api };
}

// ---------------------------------------------------------------- F1-F4

console.log("F1-F4: dry run, apply, the server's reader, replay");
{
	const db = buildFixture("main");
	const plan = planFile("main");
	const env = envFile("main");
	const before = hash(db);
	const d = dry(db, plan, env);
	check(d.code === 0, "F1 the dry run exits 0", d.out.slice(-600));
	check(hash(db) === before, "F1 the dry run leaves the database byte-identical");
	check(/read-only handle/.test(d.out), "F1 the dry run's handle is read-only");
	const want = [
		/DRF-20261021-1 {2}drivers_directory row 1: pay_daily \$0\.00 -> \$160\.00 {2}\[would write\]/,
		new RegExp(`DRF-20261021-2 {2}pay_rate_history \\+ driver \\$160\\.00 from ${reEscape(OCT1_ET)} \\(2026-10-01\\), source data-fix {2}\\[would write\\]`),
		new RegExp(`DRF-20261021-3 {2}pay_rate_history \\+ driver \\$160\\.00 from ${reEscape(SEED_AT)} \\(2026-10-02\\), source data-fix, after seed row 4 \\(\\$0\\.00\\) at the same instant {2}\\[would write\\]`),
		new RegExp(`DRF-20261021-4 {2}pay_rate_history \\+ driver \\$310\\.00 from ${reEscape(OCT1_ET)} \\(2026-10-01\\), source data-fix {2}\\[would write\\]`),
		new RegExp(`DRF-20261021-5 {2}pay_rate_history \\+ driver \\$360\\.00 from ${reEscape(OCT2_ET)} \\(2026-10-02\\), source data-fix {2}\\[would write\\]`),
	];
	want.forEach((re, i) => check(re.test(d.out), `F1 the dry run prints write ${i + 1} with its reference`, re.source));
	check(!/DRF-20261021-6/.test(d.out), "F1 no sixth write (Lee's seed already reads $360 on Oct 2; Kim is not in the plan)");
	check(/2026-10-01 {16}\| \$360\.00 -> \$360\.00 +\| \$360\.00 -> \$310\.00 +\| \$360\.00 -> \$310\.00/.test(d.out),
		"F1 Lee's Oct 1: unchanged with the flags as set, $360 -> $310 under the daily-rate rule and V2's dated reader");
	check(/2026-10-02 \.\. 2026-10-31 +\| \$360\.00 -> \$360\.00 +\| \$360\.00 -> \$360\.00 +\| \$360\.00 -> \$360\.00/.test(d.out), "F1 Lee's Oct 2-31 unchanged under every reader");
	check(/2026-10-01 \.\. 2026-10-31 +\| \$160\.00 -> \$160\.00 +\| \$250\.00 -> \$160\.00 +\| \$0\.00 -> \$160\.00/.test(d.out),
		"F1 Pat's October: $160 with the flags as set before and after (his truck's rate, then his own); the rule's $250 default becomes $160");
	check(/\.\. 2026-09-30: \$360\.00 -> \$310\.00 \(every earlier day reads the same\)/.test(d.out), "F1 V2 listing: Lee's closed-month days read $310 (accepted, Q13)");
	check(/\.\. 2026-09-30: \$0\.00 -> \$160\.00 \(every earlier day reads the same\)/.test(d.out), "F1 V2 listing: Pat's closed-month days read $160");
	check(/Result: 5 write\(s\) planned; the replay on an in-memory copy reads the plan's rate through the server's loadPayRateIndex\(\)/.test(d.out), "F1 the dry run's replay passes on an in-memory copy");

	const a = applyRun(db, plan, env);
	check(a.code === 0, "F2 the apply exits 0", a.out.slice(-600));
	const audit = rows(db, "SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail ORDER BY id");
	check(audit.length === 5 && audit.every((r) => r.user_id === 0 && r.username === ACTOR && r.role === "system"), "F2 five audit rows, each a system change (user 0, role system)", JSON.stringify(audit.map((r) => [r.user_id, r.username, r.role])));
	check(audit.map((r) => r.action).join() === "update_driver_pay,pay_rate_entry,pay_rate_entry,pay_rate_entry,pay_rate_entry", "F2 the audit actions", audit.map((r) => r.action).join());
	check(audit.every((r, i) => r.details.includes(`[DRF-20261021-${i + 1}]`) && r.details.includes(APPROVAL)), "F2 each audit row carries its reference and the approval");
	check(/pay_daily 0\.00 -> 160\.00/.test(audit[0].details) && audit[0].entity === "drivers_directory" && audit[0].entity_id === "1", "F2 the directory audit row names the change");
	check(counts(db).pat === 160, "F2 Pat's Drivers Database rate is $160");
	const added = rows(db, "SELECT id, subject_key, rate, effective_from, source FROM pay_rate_history WHERE source = 'data-fix' ORDER BY id");
	check(JSON.stringify(added.map((r) => [r.subject_key, r.rate, r.effective_from])) === JSON.stringify([
		["pat sample", 160, OCT1_ET], ["pat sample", 160, SEED_AT], ["lee rowan", 310, OCT1_ET], ["lee rowan", 360, OCT2_ET],
	]), "F2 four history rows appended, as planned", JSON.stringify(added));
	check(rows(db, "SELECT rate FROM pay_rate_history WHERE subject_key = 'pat sample' AND source = 'seed'")[0].rate === 0, "F2 Pat's $0 seed row is left as it was (appended, never edited)");
	check(audit.slice(1).every((r, i) => r.entity === "pay_rate_history" && r.entity_id === String(added[i].id)), "F2 each history audit row names its row");

	const s = serverRates(db);
	const at = s.loadPayRateIndex();
	const read = (k, day) => at.at("driver", k, day);
	check(read("pat sample", "2026-09-15") === 160 && read("pat sample", "2026-10-01") === 160 && read("pat sample", "2026-10-02") === 160 && read("pat sample", "2026-10-20") === 160,
		"F3 the server's reader: Pat $160 every day (the $0 seed never prices a day)");
	check(read("lee rowan", "2026-10-01") === 310 && read("lee rowan", "2026-10-02") === 360 && read("lee rowan", "2026-10-20") === 360,
		"F3 the server's reader: Lee $310 on Oct 1, $360 from Oct 2");
	check(read("kim doe", "2026-10-01") === 280, "F3 a driver not in the plan reads as before");
	const n0 = s.db.prepare("SELECT COUNT(*) AS n FROM pay_rate_history").get().n;
	s.recordPayRateChanges();
	check(s.db.prepare("SELECT COUNT(*) AS n FROM pay_rate_history").get().n === n0, "F3 recordPayRateChanges() finds every latest row equal to the current rate and adds nothing");
	s.db.close();

	const c0 = counts(db);
	const h0 = hash(db);
	const again = applyRun(db, plan, env);
	check(again.code === 0, "F4 a second apply exits 0", again.out.slice(-400));
	check(JSON.stringify(counts(db)) === JSON.stringify(c0) && hash(db) === h0, "F4 a second apply writes 0 rows");
	check(/Result: already applied\. 0 rows to write/.test(again.out) && (again.out.match(/\[already applied\]/g) || []).length === 5, "F4 each write reads as already applied");
	const dry2 = dry(db, plan, env);
	check(dry2.code === 0 && /Result: already applied/.test(dry2.out), "F4 a dry run after the apply says already applied");
}

// ---------------------------------------------------------------- F5-F9 refusals

function refusedUntouched(label, file, out, re) {
	check(out.code === 2, `${label}: exit 2`, out.out.slice(-500));
	check(re.test(out.out), `${label}: says why`, out.out.slice(-500));
}

console.log("F5-F9: refusals");
{
	const db = buildFixture("closed");
	const plan = planFile("closed", { approval: APPROVAL, drivers: [{ name: "Lee Rowan", expect: { payDaily: 360 }, rates: [{ from: "2026-09-30", rate: 310 }, { from: "2026-10-02", rate: 360 }] }] });
	const env = envFile("closed");
	const h = hash(db);
	refusedUntouched("F5 a dated row on Sep 30 (closed)", db, applyRun(db, plan, env), /dated 2026-09-30, in or before the latest closed month 2026-09/);
	check(hash(db) === h, "F5 nothing written");
	refusedUntouched("F5 its dry run", db, dry(db, plan, env), /in or before the latest closed month/);
}
{
	const db = buildFixture("lock", { patTruckRate: 175 });
	const plan = planFile("lock");
	const env = envFile("lock");
	const h = hash(db);
	refusedUntouched("F6 Pat's rate $0 -> $160 while his truck pays $175", db, applyRun(db, plan, env), /the month lock refuses pay_daily \(2026-08, 2026-09\)/);
	check(hash(db) === h, "F6 nothing written");
}
{
	const db = buildFixture("ambiguous", { extraPat: true });
	const env = envFile("ambiguous");
	const h = hash(db);
	refusedUntouched("F7 two Drivers Database rows read as Pat Sample", db, applyRun(db, planFile("ambiguous"), env), /"Pat Sample" matches 2 Drivers Database rows; exactly one is needed/);
	const unknown = planFile("unknown", { approval: APPROVAL, drivers: [{ name: "Nobody Here", expect: { payDaily: 0 }, rates: [{ from: "2026-10-01", rate: 160 }] }] });
	refusedUntouched("F7 a name with no Drivers Database row", db, applyRun(db, unknown, env), /"Nobody Here" matches 0 Drivers Database rows/);
	check(hash(db) === h, "F7 nothing written");
}
{
	const db = buildFixture("v2");
	const env = envFile("v2", "PAYOUT_RULES_V2_ENABLED=true\n");
	const h = hash(db);
	refusedUntouched("F8 PAYOUT_RULES_V2 on", db, applyRun(db, planFile("v2"), env), /PAYOUT_RULES_V2 is on here and \d+ closed-month day\(s\) would read a different rate/);
	check(hash(db) === h, "F8 nothing written");
}
{
	const db = buildFixture("rule", { settings: [
		["driver_rate_only.started", { from: "2026-09", startedAt: "2026-09-01T12:00:00.000Z" }],
		["driver_rate_only.closed:2026-09", { applied: true, from: "2026-09", closedAt: "2026-10-08T05:00:25.792Z" }],
	] });
	const env = envFile("rule");
	const h = hash(db);
	const out = applyRun(db, planFile("rule"), env);
	refusedUntouched("F9 September closed under the daily-rate rule", db, out, /2026-09 closed under the daily-rate rule/);
	check(hash(db) === h, "F9 nothing written");
}

// ---------------------------------------------------------------- F10 skips

console.log("F10: skips");
{
	// Lee's rate was saved at $370 on Sat 10/10 and back to $360 on Thu 10/15.
	const db = buildFixture("person", { history: [
		{ key: "lee rowan", rate: 370, from: "2026-10-10T15:00:00.000Z", source: "change" },
		{ key: "lee rowan", rate: 360, from: "2026-10-15T15:00:00.000Z", source: "change" },
	] });
	const env = envFile("person");
	const h = hash(db);
	const out = applyRun(db, planFile("person"), env);
	check(out.code === 2 && /SKIPPED: a rate saved on 2026-10-10 \(row \d+, \$370\.00, source change\) differs from the plan's \$360\.00/.test(out.out), "F10 a rate a person saved after the first day: skipped, never covered", out.out.slice(-600));
	check(/Result: skipped/.test(out.out) && hash(db) === h, "F10 the apply wrote nothing, for Pat either");
	const sameRate = buildFixture("person-same", { history: [{ key: "lee rowan", rate: 360, from: "2026-10-10T15:00:00.000Z", source: "change" }] });
	const ok = dry(sameRate, planFile("person-same"), envFile("person-same"));
	check(ok.code === 0 && !/SKIPPED/.test(ok.out), "F10 control: a saved rate equal to the plan's is no conflict", ok.out.slice(-600));
}
{
	const db = buildFixture("expect", { leeRate: 370 });
	const env = envFile("expect");
	const h = hash(db);
	const out = applyRun(db, planFile("expect"), env);
	check(out.code === 2 && /SKIPPED: the Drivers Database rate is \$370\.00; the plan expects \$360\.00/.test(out.out), "F10 an unexpected Drivers Database rate: skipped", out.out.slice(-600));
	check(hash(db) === h, "F10 nothing written");
}
{
	const db = buildFixture("gone");
	const plan = planFile("gone");
	const env = envFile("gone");
	check(applyRun(db, plan, env).code === 0, "F10 setup: applied once");
	const w = new Database(db);
	w.prepare("DELETE FROM pay_rate_history WHERE source = 'data-fix' AND subject_key = 'lee rowan' AND rate = 310").run();
	w.close();
	const h = hash(db);
	const out = applyRun(db, plan, env);
	check(out.code === 2 && /SKIPPED: DRF-20261021-4 is in the audit trail but its write is not in place/.test(out.out), "F10 a written reference whose row is gone: skipped, not written twice", out.out.slice(-600));
	check(hash(db) === h, "F10 nothing written");
}

// ---------------------------------------------------------------- F11 approval

console.log("F11: approval");
{
	const db = buildFixture("approval");
	const plan = planFile("approval");
	const env = envFile("approval");
	const h = hash(db);
	const none = run([`--plan=${plan}`, `--db=${db}`, `--env-file=${env}`]);
	check(none.code === 2 && /needs --approval/.test(none.out), "F11 no --approval and no --dry-run: refused", none.out);
	const wrong = applyRun(db, plan, env, "arvin-2026-10-20-x");
	check(wrong.code === 2 && /needs --approval=arvin-2026-10-21-a-b/.test(wrong.out), "F11 a different approval: refused", wrong.out);
	const unlisted = applyRun(db, planFile("unlisted", { ...PLAN, approval: "someone-else" }), env, "someone-else");
	check(unlisted.code === 2 && /is not one this script applies/.test(unlisted.out), "F11 a plan naming an approval the script does not list: refused", unlisted.out);
	const typo = run([`--plan=${plan}`, "--dryrun", `--db=${db}`, `--env-file=${env}`]);
	check(typo.code === 2 && /unknown option --dryrun/.test(typo.out), "F11 a mistyped --dry-run is refused, never an apply", typo.out);
	check(hash(db) === h, "F11 nothing written");
}

// ---------------------------------------------------------------- F12

console.log("F12: #547's rate runners");
for (const r of ["test-driver-rate-dated.js", "test-driver-rate-only.js", "test-driver-rate-only-guards.js"]) {
	const out = spawnSync(process.execPath, [path.join(__dirname, r)], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
	check(out.status === 0, `F12 ${r} passes`, `${out.stdout}${out.stderr}`.slice(-400));
}

console.log(`\n${pass} passed, ${fail} failed (of ${pass + fail})`);
process.exit(fail ? 1 : 0);
