#!/usr/bin/env node
/**
 * The server-side admin scripts for the payout ledger and the Financials freeze:
 *
 *   §1 lib/server-lift.js — the closure reads code, not comments, strings or
 *      regex literals; follows dependencies in source order; refuses a denied
 *      name; ends a one-line function on its line and refuses a piece that runs
 *      into another top-level statement; and, over the real server.js, indexes
 *      every top-level declaration and lifts what the tools need and none of
 *      the server's HTTP server, sockets, Sheets writer or sheet ID. A script's
 *      database is its app directory's own or a copy under the temp directory.
 *   §2 scripts/freeze-closed-months.js, end to end on a file database seeded
 *      through the server's own reconcile (two closed months, stamped; a load
 *      corrected after the close):
 *        - the dry run is read-only and prints the plan, its fingerprint, the
 *          Settlement adjustment, and checks that each investor-month frozen adds
 *          up to what it settled and that Financials' figures do not move;
 *        - --apply refuses without --include-unverified, and refuses a
 *          fingerprint that is not the plan's, writing nothing and taking no
 *          backup;
 *        - --apply with the plan's fingerprint backs the database up next to it
 *          (owner-only, no -wal/-shm, integrity-checked), freezes every planned
 *          month, writes the endpoint's audit row per month plus one naming the
 *          script as the actor (and confirms them), and changes no payout row;
 *        - a second dry run plans nothing.
 *   §3 scripts/payout-rules-dry-run.js: read-only; prints the dry run by owner
 *      id (no names unless --names).
 *   §4 every script refuses a database outside its app directory and the temp
 *      directory; both ledger scripts refuse to run with no sheet named.
 *   §5 scripts/ensure-automation-user.js: refused where the app writes to the
 *      production sheet and with nothing on stdin; creates the Super Admin from
 *      the piped password with an audit row naming the script, never printing
 *      it; a second run changes nothing; another role's account is refused.
 *
 * Pure: a temp directory, child processes of the scripts themselves, no server,
 * no network.
 * Run: node scripts/test-admin-ledger-scripts.js    # exits 1 on failure
 */
"use strict";

process.env.TZ = "UTC";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const { closure, codeIdentifiers, indexDeclarations, DECL_START_RE } = require("./lib/server-lift");

let pass = 0, fail = 0;
function check(cond, label, detail) {
	if (cond) { pass++; console.log(`  ok    ${label}`); }
	else { fail++; console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}
function die(msg) { console.error(`SETUP FAILED: ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`); }

// ═══════════════════════════════════════════════════ §1 the lifter
console.log("§1 lib/server-lift.js");
{
	const ids = codeIdentifiers([
		"// helperInComment(",
		"const a = \"helperInString\" + 'alsoString';",
		"const re = /helperInRegex[\"']/g;",
		"const t = `text ${usedInTemplate(x)} more`;",
		"obj.propertyName(1); realCall(2);",
	].join("\n"));
	check(!ids.includes("helperInComment") && !ids.includes("helperInString") && !ids.includes("alsoString") && !ids.includes("helperInRegex"),
		"comments, strings and regex literals are not references", JSON.stringify(ids));
	check(ids.includes("usedInTemplate") && ids.includes("realCall") && !ids.includes("propertyName"),
		"a template's ${…} is code; a property after '.' is not a reference", JSON.stringify(ids));

	// server.js's shape: a top-level function closes with "}" alone on a line.
	const toy = [
		"const { helper, other: renamed } = require(\"./lib/x\");",
		"const LIST = [",
		"\t1, 2,",
		"];",
		"function a() {",
		"\treturn b() + LIST.length + renamed(1);",
		"}",
		"// c() is only in this comment",
		"async function b() {",
		"\treturn \"c()\";",
		"}",
		"function c() {",
		"\treturn 3;",
		"}",
		"let counter = 0;",
		"function bad() {",
		"\treturn secretThing();",
		"}",
		"function secretThing() {",
		"}",
		"",
	].join("\n");
	const { decls } = indexDeclarations(toy);
	check(decls.get("LIST").text === "const LIST = [\n\t1, 2,\n];" && decls.get("b").kind === "function" && decls.get("counter").kind === "let",
		"top-level declarations: a multi-line const runs through its closer", JSON.stringify(decls.get("LIST").text));
	check(decls.get("renamed") && decls.get("renamed") === decls.get("helper") && !decls.has("other"),
		"a destructuring declaration binds each name it declares (after a rename, the new name)", JSON.stringify([...decls.keys()]));
	const c = closure(toy, { roots: ["a"], provided: ["require"] });
	check(JSON.stringify(c.names) === JSON.stringify(["helper", "renamed", "LIST", "a", "b"]) && c.text.startsWith("const { helper, other: renamed } = require") && !/function c\(/.test(c.text),
		"the closure follows code references only, in source order, lifting the whole destructuring line", JSON.stringify(c.names));
	let refused = "";
	try { closure(toy, { roots: ["bad"], denied: ["secretThing"] }); } catch (e) { refused = e.message; }
	check(/secretThing/.test(refused), "a denied name the closure reaches is refused", refused);

	const oneLiners = [
		"function one() { return 1; }",
		"setInterval(() => {}, 1000);",
		"function two() {",
		"\treturn one();",
		"}",
		"",
	].join("\n");
	const ol = closure(oneLiners, { roots: ["one"] });
	check(ol.text === "function one() { return 1; }", "a one-line function is its own line (nothing after it is swallowed)", JSON.stringify(ol.text));
	let stray = "";
	try {
		closure(["function leaky() {", "\treturn 1;", "setInterval(() => {}, 1000);", "}", ""].join("\n"), { roots: ["leaky"] });
	} catch (e) { stray = e.message; }
	check(/runs into another top-level statement/.test(stray), "a piece with another top-level statement inside it is refused", stray);

	// Every line of server.js that starts a top-level declaration is one the index
	// reads, so no dependency can go missing (a top-level `const { x } = require(…)`
	// once did, and failed only when the code ran).
	const real0 = indexDeclarations(SRC);
	const starts = new Set([...real0.decls.values()].map((d) => d.start));
	const missed = [];
	let off = 0;
	for (const line of SRC.split("\n")) {
		if (DECL_START_RE.test(line) && !starts.has(off)) missed.push(line.slice(0, 80));
		off += line.length + 1;
	}
	check(missed.length === 0, "over server.js: every top-level declaration line is indexed", missed.slice(0, 5).join(" | "));

	const oneLineInServer = SRC.split("\n").filter((l) => /^(async\s+)?function\s+\w+\s*\(/.test(l) && /\}\s*$/.test(l));
	check(oneLineInServer.length > 0 && oneLineInServer.every((l) => real0.decls.get(l.match(/function\s+(\w+)/)[1]).text === l),
		"over server.js: each one-line function is indexed as its own line", `${oneLineInServer.length}`);

	const ledger = require("./lib/ledger-world");
	check(ledger.dbScope(path.join(ROOT, "app.db"), ROOT).scope === "app" && ledger.dbScope(path.join(os.tmpdir(), "x.db"), ROOT).scope === "copy",
		"a script's database: the app directory's own, or a copy under the temp directory", "");
	let outside = "", envForApp = "";
	try { ledger.dbScope(path.join(ROOT, "scripts", "app.db"), ROOT); } catch (e) { outside = e.message; }
	try { ledger.envFor({ root: ROOT, dbPath: path.join(ROOT, "app.db"), envFile: "/dev/null" }); } catch (e) { envForApp = e.message; }
	check(/refusing/.test(outside) && /--env-file is only for a copy/.test(envForApp),
		"…any other is refused, and the app's own database never takes another .env", `${outside} | ${envForApp}`);
	const roots = ["payoutRulesDryRun", "closedMonthFreezePlan", "buildFinancialsLedger", "installPeriodLockTriggers", "parseSheet", "deduplicateLoads"];
	const real = closure(SRC, {
		roots, routes: [ledger.FREEZE_HEAD],
		provided: ["db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "notifyChange", "getJobTrackingCached"],
		denied: ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "jtCacheInvalidate"],
	});
	const must = ["payoutRulesDryRun", "closedMonthFreezePlan", "writeLedgerFreeze", "settledMonthItems", "computeFleetLedger", "logAudit", "getEldTravelDaysByVehicleCached", "resolveCityState"];
	check(must.every((n) => real.names.includes(n)), "over server.js: the tools' code is lifted (the plan, the freeze, the ELD days, the address states)",
		must.filter((n) => !real.names.includes(n)).join(", "));
	const never = ["getJobTrackingCached", "getSheets", "SPREADSHEET_ID", "app", "io", "db", "server"];
	check(never.every((n) => !real.names.includes(n)), "…and none of the server's own sheet reader, Sheets writer, sheet ID, app, sockets or database handle",
		never.filter((n) => real.names.includes(n)).join(", "));
}

// ═══════════════════════════════════════════════════ §2–§4 the scripts
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "admin-ledger-"));
const DB = path.join(TMP, "app.db");
const VALUES = path.join(TMP, "job-tracking.json");
const ENV = path.join(TMP, "empty.env");
fs.writeFileSync(ENV, "");

const tableDdl = (table) => {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table}`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
};
const alters = (table) => SRC.match(new RegExp(`ALTER TABLE ${table} ADD COLUMN [^"\`]*`, "g")) || [];
const trucksDdl = () => {
	const m = SRC.match(/CREATE TABLE trucks_new \(([\s\S]*?)\n\t\t\);/);
	if (!m) die("could not locate the trucks rebuild (CREATE TABLE trucks_new)");
	return `CREATE TABLE trucks (${m[1]}\n)`;
};
const TABLES = ["users", "investors", "audit_trail", "truck_assignments", "carrier_driver_history", "drivers_directory", "expenses",
	"excluded_driver_days", "maintenance_fund", "compliance_fees", "deleted_loads", "investor_payouts", "investor_payout_history",
	"investor_payout_basis", "period_locks", "financials_ledger_items", "financials_ledger_freezes", "app_settings",
	"load_coordinates", "routemate_telemetry", "pay_rate_history", "dispatch_notifications"];
{
	const db = new Database(DB);
	// WAL, as the server runs it.
	db.pragma("journal_mode = WAL");
	const ddl = [trucksDdl(), ...alters("trucks"),
		...TABLES.flatMap((t) => [tableDdl(t), ...alters(t)]),
		"CREATE TABLE investor_config (owner_id INTEGER DEFAULT 0, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id, key))"];
	for (const sql of ddl) {
		try { db.exec(sql); } catch (e) { if (!/duplicate column name/.test(e.message)) die(`DDL failed: ${e.message}\n${sql.slice(0, 120)}`); }
	}
	db.close();
}

const HEADERS = ["Contract ID", "Load ID", "Details", "Driver", "Pickup Address", "Pickup Appointment", "Drop-off Address",
	"Drop-off Appointment", "Job Status", "  Payment  ", "Broker Contact Name", "Assigned Date", "Status Update Date", "Truck", "Owner ID"];
const E = "Eve Earner";
const D = "Dave Driver";
const load = (id, driver, assigned, pickup, dropoff, pay, truck, owner) =>
	["", id, "Dry van", driver, "", pickup, "", dropoff, "Delivered", pay, "", assigned, "", truck, owner];
const SHEET = [
	load("8001", E, "4/6/2026", "4/7/2026 8:00", "4/8/2026 10:00", "$5,000.00", "T5", "5"),
	load("8003", D, "4/15/2026", "4/16/2026 8:00", "4/16/2026 18:00", "$2,000.00", "C1", "0"),
	load("8004", E, "5/5/2026", "5/6/2026 8:00", "5/7/2026 10:00", "$3,000.00", "T5", "5"),
	load("8006", E, "6/8/2026", "6/9/2026 8:00", "6/10/2026 10:00", "$2,500.00", "T5", "5"),
];
const sheetData = () => ({ range: "'Job Tracking'!A1:O5", majorDimension: "ROWS", values: [HEADERS, ...SHEET.map((r) => [...r])] });

// Seed through the server's own reconcile, lifted the same way.
async function seed() {
	const db = new Database(DB);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, company_name) VALUES (?, ?, 'x', ?, ?)");
	user.run(1, "super_admin", "Super Admin", "");
	user.run(5, "inv5", "Investor", "Acme Carrier");
	db.prepare("INSERT INTO investor_config (owner_id, key, value) VALUES (0, 'investor_split_pct', '50')").run();
	const truck = db.prepare(`INSERT INTO trucks (id, unit_number, owner_id, status, in_service_date, created_at, insurance_monthly,
		eld_monthly, truck_payment_monthly, hvut_annual, irp_annual, driver_pay_daily, assigned_driver) VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	truck.run(1, "T5", 5, "2026-04-01", "2026-04-01 00:00:00", 1000, 50, 1500, 600, 1200, 300, E);
	truck.run(3, "C1", 0, "2026-04-01", "2026-04-01 00:00:00", 600, 50, 0, 0, 0, 260, D);
	const dir = db.prepare("INSERT INTO drivers_directory (driver_name, carrier_name, pay_type, pay_daily) VALUES (?, ?, 'fixed', 0)");
	dir.run(E, "Acme Carrier");
	dir.run(D, "");
	const assign = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date) VALUES (?, ?, '2026-04-01T17:00:00.000Z')");
	assign.run(1, E);
	assign.run(3, D);
	db.prepare("INSERT INTO expenses (timestamp, driver, type, amount, date, status, owner_id, truck_unit, posted_period, load_id) VALUES (?, ?, 'Fuel', 300, '2026-04-07', 'Approved', 5, 'T5', '', '8001')")
		.run("2026-04-07T20:00:00.000Z", E);

	const lifted = closure(SRC, {
		roots: ["reconcileInvestorPayouts", "getCarrierDBFromSQLite", "parseSheet", "deduplicateLoads"],
		provided: ["db", "require", "console", "process", "__dirname", "notifyChange", "getJobTrackingCached"],
		denied: ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "app"],
	});
	const { createRequire } = require("module");
	const body = `"use strict";\n${lifted.text}\nasync function getJobTrackingCached() { const p = parseSheet(__sheet); p.data = deduplicateLoads(p.data, p.headers); return p; }\n` +
		"return { reconcileInvestorPayouts, getCarrierDBFromSQLite };";
	const api = new Function("db", "require", "console", "process", "__dirname", "notifyChange", "__sheet", body)(
		db, createRequire(path.join(ROOT, "server.js")), console, { env: {} }, ROOT, () => {}, sheetData());
	const { payouts } = await api.reconcileInvestorPayouts(5, {
		sessionUser: { id: 1, username: "super_admin", role: "Super Admin" }, carrierDB: api.getCarrierDBFromSQLite(), globalConfig: { investor_split_pct: "50" },
	});
	// April and May closed: rows stamped with their breakdown, months locked.
	for (const p of payouts.filter((x) => x.period === "2026-04" || x.period === "2026-05")) {
		db.prepare("UPDATE investor_payouts SET finalized_at = ?, finalized_amount = amount, finalized_breakdown = ? WHERE id = ?")
			.run("2026-06-08T05:00:00.000Z", JSON.stringify({ ...p.breakdown, lossCarriedIn: p.lossCarriedIn, lossDeferred: p.lossDeferred }), p.id);
	}
	db.prepare("INSERT INTO period_locks (period, status, finalized_at, finalized_by) VALUES ('2026-04', 'locked', '2026-06-08T05:00:00.000Z', 'baseline'), ('2026-05', 'locked', '2026-06-08T05:00:00.000Z', 'baseline')").run();
	db.close();
	return payouts.filter((x) => x.period === "2026-04" || x.period === "2026-05").length;
}

function run(script, args) {
	const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
	let json = null;
	try { json = JSON.parse(r.stdout); } catch { json = null; }
	return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
const counts = () => {
	const db = new Database(DB, { readonly: true });
	const n = (sql) => db.prepare(sql).get().n;
	const out = {
		freezes: n("SELECT COUNT(*) AS n FROM financials_ledger_freezes WHERE released_at = ''"),
		items: n("SELECT COUNT(*) AS n FROM financials_ledger_items"),
		audits: n("SELECT COUNT(*) AS n FROM audit_trail"),
		history: n("SELECT COUNT(*) AS n FROM pay_rate_history"),
		payouts: crypto.createHash("sha256").update(JSON.stringify(db.prepare("SELECT * FROM investor_payouts ORDER BY id").all())).digest("hex"),
	};
	db.close();
	return out;
};
const backups = () => fs.readdirSync(TMP).filter((f) => f.startsWith("app.db.pre-freeze-"));

(async () => {
	const stamped = await seed();
	if (stamped !== 2) die(`expected 2 stamped payout rows (April, May), got ${stamped}`);
	// After the close: April's load corrected in the sheet.
	SHEET[0][9] = "$5,500.00";
	fs.writeFileSync(VALUES, JSON.stringify(sheetData()));
	const common = [`--db=${DB}`, `--values-json=${VALUES}`, `--env-file=${ENV}`];

	console.log("§2 scripts/freeze-closed-months.js");
	const before = counts();
	const dry = run("freeze-closed-months.js", common);
	const plan = dry.json || {};
	const periods = (plan.periods || []).map((p) => p.period);
	check(dry.code === 0 && plan.mode === "dry-run" && /^[0-9a-f]{64}$/.test(plan.fingerprint || "") && JSON.stringify(periods) === JSON.stringify(["2026-04", "2026-05"]),
		"dry run: the plan (April and May) and its fingerprint", `${dry.code} ${dry.stderr.slice(0, 300)} ${JSON.stringify(periods)}`);
	const april = (plan.periods || []).find((p) => p.period === "2026-04") || {};
	check((april.adjustments || []).some((a) => a.ownerId === 5 && a.adjusts === "revenue" && a.amount === -500),
		"dry run: April's Settlement adjustment for the corrected load (owner 5, revenue −$500)", JSON.stringify(april.adjustments));
	check((plan.checks || []).length === 2 && plan.checks.every((x) => x.settledTotalsMatch && x.financialsUnchanged),
		"dry run: each investor-month frozen adds up to what it settled, and Financials' figures do not move", JSON.stringify(plan.checks));
	check(JSON.stringify(counts()) === JSON.stringify(before), "dry run: writes nothing", "");

	const noFlag = run("freeze-closed-months.js", [...common, "--apply", `--fingerprint=${plan.fingerprint}`]);
	check(noFlag.code === 2 && /--include-unverified/.test(noFlag.stderr) && backups().length === 0 && JSON.stringify(counts()) === JSON.stringify(before),
		"apply: refused without --include-unverified; nothing written, no backup", `${noFlag.code} ${noFlag.stderr.slice(0, 200)}`);
	const wrong = run("freeze-closed-months.js", [...common, "--apply", `--fingerprint=${"0".repeat(64)}`, "--include-unverified"]);
	check(wrong.code === 2 && /fingerprint/.test(wrong.stderr) && backups().length === 0 && JSON.stringify(counts()) === JSON.stringify(before),
		"apply: a fingerprint that is not the plan's is refused; nothing written, no backup", `${wrong.code} ${wrong.stderr.slice(0, 200)}`);

	const applied = run("freeze-closed-months.js", [...common, "--apply", `--fingerprint=${plan.fingerprint}`, "--include-unverified"]);
	const a = applied.json || {};
	check(applied.code === 0 && JSON.stringify((a.applied || {}).frozenPeriods) === JSON.stringify(["2026-04", "2026-05"]) && a.payoutRowsUnchanged === true,
		"apply: freezes April and May and changes no payout row", `${applied.code} ${applied.stderr.slice(0, 300)} ${JSON.stringify(a.applied)}`);
	const after = counts();
	check(after.freezes === 2 && after.items > 0 && after.payouts === before.payouts, "apply: both months frozen with their items; the payout rows are byte-identical", JSON.stringify(after));
	const bk = backups();
	const mode = bk.length === 1 ? (fs.statSync(path.join(TMP, bk[0])).mode & 0o777) : -1;
	check(bk.length === 1 && mode === 0o600, "apply: the backup is owner-only, with no -wal/-shm beside it", `${JSON.stringify(bk)} mode ${mode.toString(8)}`);
	check(a.auditRowsComplete === true, "apply: the script confirms its audit rows were written", JSON.stringify(a.auditRowsComplete));
	let backupOk = false;
	// The script names the backup by its resolved path (macOS: /var is /private/var).
	if (bk.length === 1 && a.backup === fs.realpathSync(path.join(TMP, bk[0]))) {
		const copy = new Database(a.backup, { readonly: true });
		backupOk = copy.pragma("integrity_check", { simple: true }) === "ok"
			&& copy.pragma("journal_mode", { simple: true }) === "delete"
			&& copy.prepare("SELECT COUNT(*) AS n FROM financials_ledger_freezes").get().n === 0
			&& crypto.createHash("sha256").update(JSON.stringify(copy.prepare("SELECT * FROM investor_payouts ORDER BY id").all())).digest("hex") === before.payouts;
		copy.close();
	}
	check(backupOk, "apply: the database was backed up next to it first (self-contained, integrity ok, the state before the freeze)", `${JSON.stringify(bk)} ${a.backup}`);

	// The same apply on copies of the backup whose audit table refuses one row
	// (a month's, then the script's): logAudit() swallows the failure, the
	// script must not.
	const refusals = { "a month's": "NEW.action = 'financials_freeze' AND NEW.entity_id = '2026-05'", "the script's": "NEW.action = 'financials_freeze_script'" };
	for (const [which, when] of Object.entries(refusals)) {
		if (bk.length !== 1) break;
		const DB2 = path.join(TMP, `audit-refused-${which.length}.db`);
		fs.copyFileSync(path.join(TMP, bk[0]), DB2);
		const d2 = new Database(DB2);
		d2.exec(`CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_trail WHEN ${when} BEGIN SELECT RAISE(ABORT, 'refused'); END`);
		d2.close();
		const r2 = run("freeze-closed-months.js", [`--db=${DB2}`, `--values-json=${VALUES}`, `--env-file=${ENV}`, "--apply", `--fingerprint=${plan.fingerprint}`, "--include-unverified"]);
		check(r2.code === 1 && r2.json && r2.json.auditRowsComplete === false && /audit rows are not all there/.test(r2.stderr),
			`apply: ${which} audit row missing is reported and exits 1`, `${r2.code} ${r2.stderr.slice(0, 200)}`);
	}
	const db = new Database(DB, { readonly: true });
	const audits = db.prepare("SELECT username, action, entity_id, details FROM audit_trail WHERE action LIKE 'financials_freeze%' ORDER BY id").all();
	db.close();
	const perMonth = audits.filter((x) => x.action === "financials_freeze");
	const scriptRow = audits.find((x) => x.action === "financials_freeze_script");
	check(perMonth.length === 2 && perMonth.every((x) => /at the request of script:freeze-closed-months/.test(x.details))
		&& scriptRow && scriptRow.username === "script:freeze-closed-months" && scriptRow.details.includes(plan.fingerprint) && scriptRow.details.includes(bk[0]),
		"apply: the endpoint's audit row per month, and one naming the script as the actor (with the fingerprint and the backup)", JSON.stringify(audits));
	const again = run("freeze-closed-months.js", common);
	check(again.code === 0 && again.json && again.json.periods.length === 0, "a second dry run plans nothing", again.stderr.slice(0, 200));

	console.log("§3 scripts/payout-rules-dry-run.js");
	const pre = counts();
	const pr = run("payout-rules-dry-run.js", common);
	const r = pr.json || {};
	check(pr.code === 0 && Array.isArray(r.changes) && Array.isArray(r.movedLoads) && r.baseline === "every rule off" && r.summary && r.summary.changes === r.changes.length,
		"payout-rules dry run: answers with the changes and the moved loads", `${pr.code} ${pr.stderr.slice(0, 300)}`);
	check(r.changes && r.changes.every((x) => !("investor" in x)), "…by owner id only (no names without --names)", "");
	check(JSON.stringify(counts()) === JSON.stringify(pre), "…and writes nothing", "");

	console.log("§4 refusals before anything is read");
	// The same file, seen from a temp directory it is not under: neither the
	// app directory's database nor a copy, so all three scripts refuse it.
	const elsewhere = path.join(TMP, "elsewhere");
	fs.mkdirSync(elsewhere);
	const runFrom = (script, args, input) => spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args],
		{ encoding: "utf8", input, env: { ...process.env, TZ: "UTC", TMPDIR: elsewhere } });
	const outFreeze = runFrom("freeze-closed-months.js", common);
	const outPayout = runFrom("payout-rules-dry-run.js", common);
	const outUser = runFrom("ensure-automation-user.js", [`--db=${DB}`, "--username=e2e_playwright", `--env-file=${ENV}`], "x\n");
	check(outFreeze.status === 2 && /refusing/.test(outFreeze.stderr) && outPayout.status === 2 && /refusing/.test(outPayout.stderr)
		&& outUser.status === 2 && /refusing/.test(outUser.stderr),
		"a database outside the app directory and the temp directory is refused by every script", `${outFreeze.status} ${outPayout.status} ${outUser.status} ${outUser.stderr.slice(0, 120)}`);
	// A link inside the temp directory to a database outside it is that database.
	const link = path.join(elsewhere, "link.db");
	fs.symlinkSync(DB, link);
	const viaLink = runFrom("ensure-automation-user.js", [`--db=${link}`, "--username=e2e_playwright", `--env-file=${ENV}`], "x\n");
	check(viaLink.status === 2 && /refusing/.test(viaLink.stderr), "…including through a symbolic link that sits in the temp directory", `${viaLink.status} ${viaLink.stderr.slice(0, 120)}`);
	const ledger = require("./lib/ledger-world");
	const hard = path.join(TMP, "hard.db");
	fs.linkSync(DB, hard);
	let hardRefused = "";
	try { ledger.dbScope(hard, ROOT); } catch (e) { hardRefused = e.message; }
	fs.unlinkSync(hard);
	check(/more than one hard link/.test(hardRefused), "a database file with another hard link is refused", hardRefused);
	const withTmp = (dir, fn) => {
		const saved = process.env.TMPDIR;
		process.env.TMPDIR = dir;
		try { return fn(); } catch (e) { return e.message; } finally { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; }
	};
	const atRoot = withTmp("/", () => ledger.dbScope(DB, ROOT).scope);
	const aboveApp = withTmp(path.dirname(ROOT), () => ledger.dbScope(path.join(ROOT, "scripts", "x.db"), ROOT).scope);
	check(/refusing/.test(atRoot) && /refusing/.test(aboveApp), "no copy when the temp directory is / or holds the app directory", `${atRoot} | ${aboveApp}`);
	// Two deployments side by side (…/www/staging, …/www/prod): with the temp
	// directory set to the other one, its database is not a copy.
	const www = path.join(TMP, "www");
	fs.mkdirSync(path.join(www, "staging"), { recursive: true });
	fs.mkdirSync(path.join(www, "prod"), { recursive: true });
	fs.writeFileSync(path.join(www, "prod", "app.db"), "");
	const sibling = withTmp(path.join(www, "prod"), () => ledger.dbScope(path.join(www, "prod", "app.db"), path.join(www, "staging")).scope);
	// A folder that holds a server.js or a .env is an app directory, not a copy.
	const appLike = path.join(TMP, "app-like");
	fs.mkdirSync(appLike);
	fs.writeFileSync(path.join(appLike, "app.db"), "");
	fs.writeFileSync(path.join(appLike, "server.js"), "");
	const appLikeScope = (() => { try { return ledger.dbScope(path.join(appLike, "app.db"), ROOT).scope; } catch (e) { return e.message; } })();
	fs.unlinkSync(path.join(appLike, "server.js"));
	fs.writeFileSync(path.join(appLike, ".env"), "");
	const envLikeScope = (() => { try { return ledger.dbScope(path.join(appLike, "app.db"), ROOT).scope; } catch (e) { return e.message; } })();
	check(/refusing/.test(sibling) && /refusing/.test(appLikeScope) && /refusing/.test(envLikeScope),
		"no copy when the temp directory sits beside the app directory, or the copy's folder holds a server.js or a .env",
		`${sibling} | ${appLikeScope} | ${envLikeScope}`);
	const noSheet = run("freeze-closed-months.js", [`--db=${DB}`, `--env-file=${ENV}`]);
	const noSheetPr = run("payout-rules-dry-run.js", [`--db=${DB}`, `--env-file=${ENV}`]);
	check(noSheet.code !== 0 && noSheetPr.code !== 0 && /no default sheet/.test(noSheet.stderr) && /no default sheet/.test(noSheetPr.stderr),
		"both scripts refuse to run with no sheet named", `${noSheet.stderr.slice(0, 120)} | ${noSheetPr.stderr.slice(0, 120)}`);

	console.log("§5 scripts/ensure-automation-user.js");
	const PROD_ID = SRC.match(/^const SPREADSHEET_ID = process\.env\.SPREADSHEET_ID \|\| "([^"]+)"/m)[1];
	const envWith = (name, body) => { const f = path.join(TMP, name); fs.writeFileSync(f, body); return f; };
	const stagingEnv = envWith("staging.env", "SPREADSHEET_ID=staging-copy-of-the-sheet\n");
	const prodEnv = envWith("prod.env", `SPREADSHEET_ID=${PROD_ID}\n`);
	const pw = crypto.randomBytes(18).toString("base64url");
	const ensure = (env, input, username = "e2e_playwright") => {
		const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "ensure-automation-user.js"), `--db=${DB}`, `--username=${username}`, `--env-file=${env}`],
			{ encoding: "utf8", input });
		let json = null;
		try { json = JSON.parse(r.stdout); } catch { json = null; }
		return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
	};
	const userRow = (name) => {
		const d = new Database(DB, { readonly: true });
		const row = d.prepare("SELECT id, username, role, password_hash, must_change_password FROM users WHERE username = ?").get(name);
		d.close();
		return row;
	};
	const onProdUnset = ensure(ENV, `${pw}\n`);
	const onProdNamed = ensure(prodEnv, `${pw}\n`);
	check(onProdUnset.code === 2 && onProdNamed.code === 2 && /production sheet/.test(onProdUnset.stderr) && !userRow("e2e_playwright"),
		"refused where the app writes to the production sheet (no SPREADSHEET_ID, or the production one); no account", `${onProdUnset.code} ${onProdNamed.code}`);
	const empty = ensure(stagingEnv, "");
	check(empty.code === 2 && /no password/.test(empty.stderr) && !userRow("e2e_playwright"), "refused with nothing on stdin; no account", `${empty.code} ${empty.stderr.slice(0, 120)}`);
	const made = ensure(stagingEnv, `${pw}\n`);
	const row = userRow("e2e_playwright");
	const bcrypt = require("bcryptjs");
	check(made.code === 0 && made.json && made.json.created === true && row && row.role === "Super Admin" && row.must_change_password === 0
		&& bcrypt.compareSync(pw, row.password_hash),
		"creates the Super Admin from the piped password (no forced change)", `${made.code} ${made.stderr.slice(0, 200)}`);
	check(!made.stdout.includes(pw) && !made.stderr.includes(pw), "never prints the password", "");
	const d = new Database(DB, { readonly: true });
	const audit = d.prepare("SELECT username, action, entity_id FROM audit_trail WHERE action = 'automation_user_created'").all();
	d.close();
	check(audit.length === 1 && audit[0].username === "script:ensure-automation-user" && audit[0].entity_id === String(row && row.id),
		"writes an audit row naming the script as the actor", JSON.stringify(audit));
	const again2 = ensure(stagingEnv, "a-different-password\n", " E2E_Playwright ");
	const row2 = userRow("e2e_playwright");
	check(again2.code === 0 && again2.json && again2.json.created === false && row2.password_hash === row.password_hash,
		"run again (any case or spacing of the name): changes nothing, not even the password", `${again2.code} ${again2.stderr.slice(0, 120)}`);
	const inv = userRow("inv5");
	const notSa = ensure(stagingEnv, `${pw}\n`, "inv5");
	check(notSa.code === 2 && /role Investor/.test(notSa.stderr) && userRow("inv5").password_hash === inv.password_hash && userRow("inv5").role === "Investor",
		"an existing account with another role is refused and left as it is", `${notSa.code} ${notSa.stderr.slice(0, 120)}`);

	fs.rmSync(TMP, { recursive: true, force: true });
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})().catch((e) => { fs.rmSync(TMP, { recursive: true, force: true }); die(`crashed: ${e.stack || e.message}`); });
