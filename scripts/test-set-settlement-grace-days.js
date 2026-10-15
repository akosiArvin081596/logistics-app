#!/usr/bin/env node
/**
 * scripts/set-settlement-grace-days.js: its bounds, its one write and its
 * command line, on a file database with the production schema of the tables it
 * reads (made-up data only).
 *
 *   §1 the command line: an unknown option, no --days, an empty --days and a
 *      --dry-run with a value are refused (exit 2) before anything is opened;
 *   §2 the lift: PUT /api/investor/config and the helpers resolve in this
 *      checkout's server.js and reach none of the denied names;
 *   §3 the route's bounds: 29, -1, 14.5, "abc" are refused; 0 and 28 pass;
 *   §4 the dry run writes nothing and prints old → new, the audit row and the
 *      close dates (October closes Sun Nov 15 00:00 ET under 14, Sun Nov 8
 *      under 7);
 *   §5 the write: the global row becomes 14, nothing else in investor_config
 *      moves, exactly one audit row, a system change "settlement_grace_days:
 *      7 → 14", and the server's settlementGraceDays() reads 14;
 *   §6 idempotent: a second run says "already 14" and writes nothing; "14.0"
 *      is the same value;
 *   §7 an unset value: shown as the server's default, audited "unset → 14";
 *   §8 a value that would close an open month at once is named in a WARNING;
 *      a longer window names none;
 *   §9 an audit row that is not written rolls the change back.
 *
 * Pure: a temp directory, child processes of the script itself, no server,
 * no network. Run: node scripts/test-set-settlement-grace-days.js  # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "set-settlement-grace-days.js");
const grace = require(SCRIPT);
const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
	if (ok) { passes++; return; }
	failures++;
	console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grace-days-"));
const SCHEMA = `
CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key));
CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')), finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system', reopened_at TEXT DEFAULT '', reopened_by TEXT DEFAULT '', reopen_reason TEXT DEFAULT '', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`;
let seq = 0;
function fixture(mutate) {
	const dir = path.join(tmp, `f${++seq}`);
	fs.mkdirSync(dir);
	const file = path.join(dir, "app.db");
	const db = new Database(file);
	db.exec(SCHEMA);
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'settlement_grace_days', '7'), (0, 'investor_split_pct', '50'), (0, 'maintenance_fund_monthly', '800'), (12, 'investor_split_pct', '45')").run();
	db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES ('2026-08', 'locked', '2026-09-08T05:00:00Z'), ('2026-09', 'locked', '2026-10-09T14:45:52Z')").run();
	db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES ('2026-10-01T12:00:00Z', 1, 'admin', 'Super Admin', 'update_investor_config', 'investor_config', 'owner:12', 'investor_split_pct: 50 → 45')").run();
	if (mutate) mutate(db);
	return { dir, file, db };
}
function snapshot(db) {
	const h = (sql) => {
		let rows;
		try { rows = db.prepare(sql).all(); } catch (err) { rows = `unreadable: ${err.message}`; }
		return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
	};
	return { config: h("SELECT * FROM investor_config ORDER BY owner_id, key"), audit: h("SELECT * FROM audit_trail ORDER BY id"), locks: h("SELECT * FROM period_locks ORDER BY period") };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stored = (db) => (db.prepare("SELECT value FROM investor_config WHERE owner_id = 0 AND key = 'settlement_grace_days'").get() || {}).value;
function cli(args) {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: tmp, encoding: "utf8", timeout: 60000 });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const planOf = (f, days, today = "2026-10-15") => {
	const { api } = grace.buildWorld({ db: f.db });
	try { return { p: grace.plan(f.db, api, { days }, { today }) }; } catch (err) { return { err }; }
};

// ── §1 the command line ────────────────────────────────────────────────────────
{
	check("§1 --days reads", same(grace.readOptions(["--days", "14"]), { days: "14", db: null, dryRun: false }));
	check("§1 --dry-run reads", grace.readOptions(["--days=14", "--dry-run"]).dryRun === true);
	const refuses = (name, argv, re) => {
		let err = null;
		try { grace.readOptions(argv); } catch (e) { err = e; }
		check(`§1 refuses ${name}`, err instanceof grace.Refusal && re.test(err.message), err ? err.message : "accepted");
	};
	refuses("an unknown option", ["--days", "14", "--owner", "5"], /unknown option --owner/);
	refuses("no --days", ["--dry-run"], /--days/);
	refuses("an empty --days", ["--days="], /--days/);
	refuses("a --dry-run with a value", ["--days", "14", "--dry-run=yes"], /--dry-run takes no value/);
	const run = cli(["--days", "14", "--apply"]);
	check("§1 the command line exits 2 on an unknown option", run.code === 2 && /unknown option --apply/.test(run.out), run.out);
}

// ── §2 the lift ────────────────────────────────────────────────────────────────
{
	const f = fixture();
	let w = null;
	let err = null;
	try { w = grace.buildWorld({ db: f.db }); } catch (e) { err = e; }
	check("§2 the route and every root lift and compile", w && grace.ROOTS.every((r) => w.liftedNames.includes(r)), err && err.message);
	check("§2 no denied name is lifted", w && !w.liftedNames.some((n) => grace.DENIED.includes(n)));
	f.db.close();
}

// ── §3 the route's bounds ──────────────────────────────────────────────────────
{
	const f = fixture();
	for (const bad of ["29", "-1", "14.5", "abc", "1,4"]) {
		const { err } = planOf(f, bad);
		check(`§3 ${JSON.stringify(bad)} is refused`, err instanceof grace.Refusal && /whole number from 0 to 28/.test(err.message), err ? err.message : "accepted");
	}
	for (const good of ["0", "28", "14"]) {
		const { p, err } = planOf(f, good);
		check(`§3 ${good} passes`, p && p.state === "set" && p.newDays === Number(good), err && err.message);
	}
	const cliBad = cli(["--days", "29", "--dry-run", "--db", f.file]);
	check("§3 the command line exits 2 on 29", cliBad.code === 2 && /whole number from 0 to 28/.test(cliBad.out), cliBad.out);
	f.db.close();
}

// ── §4 the dry run ─────────────────────────────────────────────────────────────
{
	const f = fixture();
	const before = snapshot(f.db);
	const { p, err } = planOf(f, "14");
	const lines = p ? grace.describe(p) : [];
	check("§4 old → new", p && p.oldDays === 7 && p.newDays === 14 && lines[0] === "settlement_grace_days: 7 → 14", err ? err.message : lines.join("\n"));
	check("§4 October closes Sun Nov 15 00:00 ET (now Sun Nov 8)", lines.includes("  October 2026 closes Sun Nov 15, 2026 00:00 ET (now: Sun Nov 8, 2026 00:00 ET)"), lines.join("\n"));
	check("§4 November closes Tue Dec 15 00:00 ET", lines.includes("  November 2026 closes Tue Dec 15, 2026 00:00 ET (now: Tue Dec 8, 2026 00:00 ET)"));
	check("§4 a closed September is not listed", !lines.some((l) => /September/.test(l)));
	check("§4 the audit row it would write", lines.includes('Audit row: update_investor_config, investor_config global, by "system: settlement-grace-days script" (system): settlement_grace_days: 7 → 14'));
	check("§4 planning writes nothing", same(snapshot(f.db), before));
	f.db.close();
	const run = cli(["--days", "14", "--dry-run", "--db", f.file]);
	const ro = new Database(f.file, { readonly: true });
	check("§4 the command-line dry run exits 0 and says so", run.code === 0 && /DRY RUN: nothing written\./.test(run.out) && /settlement_grace_days: 7 → 14/.test(run.out), run.out);
	check("§4 the command-line dry run writes nothing", same(snapshot(ro), before));
	ro.close();
}

// ── §5 the write, §6 idempotent ────────────────────────────────────────────────
{
	const f = fixture();
	const configBefore = f.db.prepare("SELECT * FROM investor_config WHERE NOT (owner_id = 0 AND key = 'settlement_grace_days') ORDER BY owner_id, key").all();
	const lastAudit = f.db.prepare("SELECT MAX(id) AS id FROM audit_trail").get().id;
	const locksBefore = snapshot(f.db).locks;
	f.db.close();
	const run = cli(["--days", "14", "--db", f.file]);
	check("§5 the command line writes (exit 0)", run.code === 0 && /WRITTEN: settlement_grace_days = 14; audit row \d+/.test(run.out), run.out);
	const db = new Database(f.file);
	check("§5 the global row is 14", stored(db) === "14");
	check("§5 nothing else in investor_config moves", same(db.prepare("SELECT * FROM investor_config WHERE NOT (owner_id = 0 AND key = 'settlement_grace_days') ORDER BY owner_id, key").all(), configBefore));
	check("§5 no lock moves", snapshot(db).locks === locksBefore);
	const audits = db.prepare("SELECT * FROM audit_trail WHERE id > ?").all(lastAudit);
	check("§5 exactly one audit row", audits.length === 1, String(audits.length));
	const a = audits[0] || {};
	check("§5 the audit row is a system change with old and new", a.user_id === 0 && a.username === "system: settlement-grace-days script" && a.role === "system"
		&& a.action === "update_investor_config" && a.entity === "investor_config" && a.entity_id === "global" && a.details === "settlement_grace_days: 7 → 14", JSON.stringify(a));
	const { api } = grace.buildWorld({ db });
	check("§5 the server's settlementGraceDays() reads 14", api.settlementGraceDays() === 14);
	const after = snapshot(db);
	db.close();

	const again = cli(["--days", "14", "--db", f.file]);
	const db2 = new Database(f.file, { readonly: true });
	check("§6 a second run says already and exits 0", again.code === 0 && /already 14; nothing written/.test(again.out), again.out);
	check("§6 a second run writes nothing", same(snapshot(db2), after));
	db2.close();
	const db3 = new Database(f.file);
	const same14 = planOf({ db: db3 }, "14.0");
	check("§6 14.0 is the same value", same14.p && same14.p.state === "already", same14.err && same14.err.message);
	db3.close();
}

// ── §7 an unset value ──────────────────────────────────────────────────────────
{
	const f = fixture((db) => db.prepare("DELETE FROM investor_config WHERE key = 'settlement_grace_days'").run());
	const { p } = planOf(f, "14");
	const lines = p ? grace.describe(p) : [];
	check("§7 unset shows the server's default", lines[0] === "settlement_grace_days: unset (the server uses 7) → 14", lines[0]);
	const { call } = grace.buildWorld({ db: f.db });
	const id = grace.apply(f.db, call, p);
	const a = f.db.prepare("SELECT * FROM audit_trail WHERE id = ?").get(id);
	check("§7 audited unset → 14 and written", a && a.details === "settlement_grace_days: unset → 14" && stored(f.db) === "14", a && a.details);
	f.db.close();
}

// ── §8 a value that would close an open month at once ──────────────────────────
{
	const f = fixture((db) => db.prepare("DELETE FROM period_locks WHERE period = '2026-09'").run());
	const short = planOf(f, "3", "2026-10-05");
	check("§8 3 days on Oct 5 with September open warns", short.p && short.p.warnings.length === 1 && /^September 2026 would close at the next sweep tick: its last open day under 3 is 2026-10-03, before today \(2026-10-05\)$/.test(short.p.warnings[0]), short.p ? short.p.warnings.join("; ") : short.err.message);
	check("§8 the warning is printed", short.p && grace.describe(short.p).some((l) => /^WARNING: September 2026 would close/.test(l)));
	const long = planOf(f, "14", "2026-10-05");
	check("§8 14 days on Oct 5 warns of nothing and lists September", long.p && long.p.warnings.length === 0 && grace.describe(long.p).includes("  September 2026 closes Thu Oct 15, 2026 00:00 ET (now: Thu Oct 8, 2026 00:00 ET)"), long.p ? grace.describe(long.p).join("\n") : long.err.message);
	f.db.close();
}

// ── §9 no audit row, no change ─────────────────────────────────────────────────
{
	const f = fixture();
	const { p } = planOf(f, "14");
	// A trigger that drops the audit insert: the route's logAudit() swallows the error.
	f.db.exec("CREATE TRIGGER no_audit BEFORE INSERT ON audit_trail BEGIN SELECT RAISE(ABORT, 'audit refused'); END;");
	const { call } = grace.buildWorld({ db: f.db });
	let err = null;
	const quiet = console.error;
	console.error = () => {};
	try { grace.apply(f.db, call, p); } catch (e) { err = e; } finally { console.error = quiet; }
	check("§9 a missing audit row stops the run", err && /audit row is not the one expected/.test(err.message), err ? err.message : "applied");
	check("§9 and the value is not written", stored(f.db) === "7");
	f.db.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`test-set-settlement-grace-days: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
