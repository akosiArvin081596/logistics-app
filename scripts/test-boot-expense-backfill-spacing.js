#!/usr/bin/env node
/**
 * The boot backfill of legacy expenses, backfillLegacyExpenseTrucks() in
 * server.js, attributes a receipt to its driver's truck across a spacing variant
 * of the driver's name, writes only a row that matched, never writes into a
 * finalized month, and runs at a point in boot where nothing it calls is still
 * in its temporal dead zone.
 *
 * Every boot, pass 1 stamps truck_unit + owner_id on an expense with a blank
 * truck_unit from the truck_assignments row covering the expense's day, newest
 * start first, and pass 2 refreshes owner_id from the truck. Those decide whose
 * P&L a receipt lands on. Pass 1 matched the driver with LOWER(), which folds
 * case, not spacing, so a receipt filed as "Shorn  King" never met the
 * assignment to "Shorn King" and stayed off the investor's P&L. A second step
 * now takes, for a row the case-aside SQL leaves blank, the covering assignment
 * naming the driver through normalizeDriverName(), in the same window and order,
 * and only while no other account holds the name under another spelling
 * (driverNameHeldByOtherSpelling(), the rule findTruckForDriverStamp() applies
 * to the same stamp at insert). And pass 1 used to write every candidate: its
 * row-value SET assigned NULL to both columns when no assignment matched, so an
 * unmatched row was rewritten, counted and logged on every boot. Only a row
 * that matched is written now.
 *
 * WHAT IS ASSERTED: the shipping function and its whole call graph, lifted out
 * of server.js (it cannot be required: it opens SQLite, reads a key and listens
 * on import) and run against an in-memory SQLite exactly as boot runs them. The
 * health object and the call statement are lifted too, and every binding
 * server.js declares below the call is declared below it here, uninitialised
 * when the call runs, so a reference to one throws the real ReferenceError.
 *   §1 step 2: a spacing variant of the assigned driver's name, in an open month
 *      inside the assignment window, gets the truck and its owner, on the
 *      assignment's first and last day too; outside the window it does not; the
 *      covering assignment with the newest start wins.
 *   §2 the period lock: the same row in a finalized month is untouched and
 *      counted, logged and audited as skipped, and so is a prior-period
 *      adjustment whose date is in one; an unreadable lock table withholds
 *      every row, pass 2's included.
 *   §3 the other-account guard: while another account holds the name under
 *      another spelling, a spacing match is refused, in either direction.
 *   §4 step 1 and pass 2 unchanged: a case-aside match still stamps, first,
 *      whatever other spellings exist; pass 2 still refreshes owner_id.
 *   §5 only a matched row is written: an unmatched row keeps what it had, and a
 *      second boot over the same data changes nothing and logs no backfill line.
 *   §6 boot order: the call sits where the block always ran, below every table
 *      and column its graph reads, and the TDZ simulation is not vacuous.
 *   §7 mutants: the other-account guard removed, the match guard (EXISTS)
 *      removed, step 2 run over the finalized months, and a binding declared
 *      below the call read from the call graph. Each must flip at least one
 *      assertion above; a test that passes on both has not tested anything.
 *
 * Pure: no server, no app.db, no network, no Sheets.
 * Run: node scripts/test-boot-expense-backfill-spacing.js     # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	console.error(`FAILED: better-sqlite3 did not load (${e.message}); run under the .nvmrc Node`);
	process.exit(1);
}

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const LINES = SRC.split("\n");

// ───────────────────────────────────────────────────────────────── lifting
// Each lift is anchored on a newline and counted, so a mention in a comment is
// never taken for the definition and a second copy fails the run. A top-level
// function ends at the first column-0 "}" line.
function liftBetween(needle, terminator, label) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 ${label} in server.js, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf(terminator, a);
	if (end < 0) throw new Error(`no terminator after ${label}`);
	return SRC.slice(a, end + terminator.length);
}
function liftFn(name) {
	const body = liftBetween(`\nfunction ${name}(`, "\n}\n", `function ${name}()`);
	if (/\n(async )?function /.test(body)) throw new Error(`the lift of ${name}() spanned more than one declaration`);
	return body;
}
// Replace exactly one occurrence, or fail loudly: a mutant whose target is gone
// would run the ORIGINAL code and "pass", proving nothing.
function mutate(src, from, to) {
	const n = src.split(from).length - 1;
	if (n !== 1) throw new Error(`mutant target found ${n}x (expected 1): ${from.slice(0, 80)}`);
	return src.replace(from, () => to);
}

// The backfill and everything it calls, transitively. A function missing here is
// a ReferenceError inside the backfill's try, which lands in health.error and
// fails every scenario, so the list cannot silently fall short.
const GRAPH = [
	"backfillLegacyExpenseTrucks",
	// The period lock.
	"periodLocksReadable", "periodLockStmt", "isLocked", "expensePostedPeriod", "expenseRowPeriodLocked",
	// The name rule.
	"normalizeDriverName", "isBuiltInPropertyName", "driverNameHeldByOtherSpelling", "driverNameHeldByOtherAccount", "findDriverNameClashes",
	"logAudit",
];
const GRAPH_SRC = Object.fromEntries(GRAPH.map((n) => [n, liftFn(n)]));

// The two boot statements: the health object and the call, which runs the
// backfill at module top level.
const HEALTH_DECL = liftBetween("\nconst legacyExpenseBackfillHealth = {", "\n};\n", "const legacyExpenseBackfillHealth");
const CALL_STMT = "backfillLegacyExpenseTrucks(legacyExpenseBackfillHealth);";
const callLines = LINES.map((l, i) => (l === CALL_STMT ? i : -1)).filter((i) => i >= 0);
if (callLines.length !== 1) throw new Error(`expected the call ${CALL_STMT} exactly once at column 0, found ${callLines.length}`);
const CALL_LINE = callLines[0];

// Every binding server.js declares at column 0 BELOW the call. At boot each is
// still in its temporal dead zone when the backfill runs (a `var` is hoisted as
// undefined instead), so each is declared below the call here too. A shape this
// cannot read (nested destructuring, several declarators on one line) is
// collected and fails §6 rather than being silently missed.
//
// Is there a second declarator after the first name (`let a = 1, b;`)? A comma
// at nesting depth 0, outside a string or a regex literal, before the statement
// ends.
function declaresSeveral(rest) {
	let depth = 0, quote = "", prev = "";
	for (let i = 0; i < rest.length; i++) {
		const c = rest[i];
		if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
		if (/\s/.test(c)) continue;
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "/" && rest[i + 1] === "/") return false;
		else if (c === "/" && "=(,:[!&|?{};+-*%<>~^".includes(prev)) {
			// A regex literal: skip to its closing slash, past any character class.
			for (let cls = false, j = i + 1; j < rest.length; j++) {
				const d = rest[j];
				if (d === "\\") { j++; continue; }
				if (d === "[") cls = true;
				else if (d === "]") cls = false;
				else if (d === "/" && !cls) { i = j; break; }
			}
		}
		else if ("([{".includes(c)) depth++;
		else if (")]}".includes(c)) depth--;
		else if (c === ";" && depth === 0) return false;
		else if (c === "," && depth === 0) return true;
		prev = c;
	}
	return false;
}
// The names a column-0 line declares, as { kind, names }, or null for a shape
// this cannot read. One-line flat destructuring (`const { a, b: c } = ...`) is
// read; anything nested is not.
function declaredNames(line) {
	let m = line.match(/^(const|let|var|class)\s+([A-Za-z_$][\w$]*)/);
	if (m) return m[1] !== "class" && declaresSeveral(line.slice(m[0].length)) ? null : { kind: m[1], names: [m[2]] };
	m = line.match(/^(const|let|var)\s*[{[]([^{}[\]]*)[}\]]\s*=/);
	if (m) {
		const names = m[2].split(",").map((s) => s.trim()).filter(Boolean)
			.map((s) => s.replace(/^\.\.\./, "").split("=")[0].split(":").pop().trim());
		return names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n)) ? { kind: m[1], names } : null;
	}
	return /^(const|let|var)\s*[{[]/.test(line) ? null : { kind: "", names: [] };
}
const LATE = { lexical: new Set(), vars: new Set() };
const UNREAD_DECLARATIONS = [];
for (let i = CALL_LINE + 1; i < LINES.length; i++) {
	const d = declaredNames(LINES[i]);
	if (!d) { UNREAD_DECLARATIONS.push(`${i + 1}: ${LINES[i].slice(0, 70)}`); continue; }
	for (const n of d.names) (d.kind === "var" ? LATE.vars : LATE.lexical).add(n);
}
const LATE_DECL = [
	LATE.lexical.size ? `let ${[...LATE.lexical].join(", ")};` : "",
	LATE.vars.size ? `var ${[...LATE.vars].join(", ")};` : "",
].join("\n");

const QUIET = { log() {}, warn() {}, error() {} };
// Runs the boot statements over `db`: the call graph (hoisted declarations), the
// health object, the call, then the late bindings. Sloppy, like server.js, which
// has no "use strict"; a `new Function` body does not inherit this file's.
function boot(db, { over = {}, cons = QUIET } = {}) {
	const graph = GRAPH.map((n) => (n in over ? over[n] : GRAPH_SRC[n])).join("\n");
	const body = [graph, HEALTH_DECL, CALL_STMT, LATE_DECL, "return legacyExpenseBackfillHealth;"].join("\n");
	return new Function("db", "console", body)(db, cons);
}

// ───────────────────────────────────────────────────────────────── fixtures
const DDL = [
	"CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL, driver_name TEXT DEFAULT '')",
	"CREATE TABLE trucks (id INTEGER PRIMARY KEY AUTOINCREMENT, unit_number TEXT NOT NULL UNIQUE, owner_id INTEGER DEFAULT 0, assigned_driver TEXT DEFAULT '')",
	`CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, truck_id INTEGER NOT NULL, driver_name TEXT NOT NULL,
		start_date TEXT NOT NULL, end_date TEXT DEFAULT '')`,
	// truck_unit and owner_id carry the defaults server.js's migrations give them
	// (pinned in §6), so an untouched row reads ('', 0) as it does in production.
	`CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, driver TEXT NOT NULL, date TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP, owner_id INTEGER DEFAULT 0, truck_unit TEXT DEFAULT '', posted_period TEXT DEFAULT '')`,
	`CREATE TABLE period_locks (period TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','reopened')),
		finalized_at TEXT NOT NULL, finalized_by TEXT NOT NULL DEFAULT 'system')`,
	`CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL,
		role TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT DEFAULT '', details TEXT DEFAULT '')`,
];
// accounts: [id, driver_name]; trucks: [id, unit_number, owner_id];
// assignments: [truck_id, driver_name, start_date, end_date = ""];
// locks: [period, status = "locked"];
// expenses: { id, driver, date, truck_unit?, owner_id?, posted_period? }.
function makeDb({ accounts = [], trucks = [], assignments = [], locks = [], expenses = [] } = {}) {
	const db = new Database(":memory:");
	for (const sql of DDL) db.exec(sql);
	const u = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, 'Driver', ?)");
	for (const [id, name] of accounts) u.run(id, `LogisX-${1000 + id}`, name);
	const t = db.prepare("INSERT INTO trucks (id, unit_number, owner_id) VALUES (?, ?, ?)");
	for (const [id, unit, owner = 0] of trucks) t.run(id, unit, owner);
	const a = db.prepare("INSERT INTO truck_assignments (truck_id, driver_name, start_date, end_date) VALUES (?, ?, ?, ?)");
	for (const [truckId, name, start, end = ""] of assignments) a.run(truckId, name, start, end);
	const l = db.prepare("INSERT INTO period_locks (period, status, finalized_at) VALUES (?, ?, '2026-08-08T05:00:00.000Z')");
	for (const [period, status = "locked"] of locks) l.run(period, status);
	const e = db.prepare(`INSERT INTO expenses (id, driver, date, created_at, truck_unit, owner_id, posted_period)
		VALUES (@id, @driver, @date, @created_at, @truck_unit, @owner_id, @posted_period)`);
	for (const x of expenses) e.run({ truck_unit: "", owner_id: 0, posted_period: "", created_at: `${x.date} 15:00:00`, ...x });
	return db;
}
const snapshot = (db) => db.prepare(
	"SELECT id, truck_unit, typeof(truck_unit) AS tu, owner_id, typeof(owner_id) AS oi FROM expenses ORDER BY id").all();

// Boots `world` once. `before` is the expenses table just before the boot;
// again() boots the same database a second time.
function runWorld(world, over, prepare) {
	const db = makeDb(world);
	if (prepare) prepare(db);
	const before = snapshot(db);
	const logs = [];
	const cons = {
		log: (...a) => logs.push(`log ${a.join(" ")}`),
		warn: (...a) => logs.push(`warn ${a.join(" ")}`),
		error: (...a) => logs.push(`error ${a.join(" ")}`),
	};
	const health = boot(db, { over, cons });
	return {
		db, before, health, logs,
		row: (id) => { const r = db.prepare("SELECT truck_unit, owner_id FROM expenses WHERE id = ?").get(id); return [r.truck_unit, r.owner_id]; },
		audits: () => db.prepare("SELECT action, details FROM audit_trail ORDER BY id").all().map((r) => `${r.action}: ${r.details}`),
		again: () => { logs.length = 0; return boot(db, { over, cons }); },
	};
}

const SK = "Shorn King";
const T101 = [1, "101", 5];
const T205 = [2, "205", 7];
const T300 = [3, "300", 9];
const T410 = [4, "410", 11];
// 22:30Z is 17:30 in Houston: the first-day case coversExpenseDay()'s substr is for.
const SEP1 = "2026-09-01T22:30:00.000Z";
const AUG1 = "2026-08-01T12:00:00.000Z";
const JUN1 = "2026-06-01T12:00:00.000Z";
const OPEN_DAY = "2026-09-10";
const SPACING_LOG = (n, spacing, pass2 = 0) =>
	`log Expense backfill: pass1 ${n} (truck_unit+owner_id; ${spacing} through a spacing variant of the driver's name), pass2 ${pass2} (owner_id refresh)`;

// ───────────────────────────────────────────────────────────────── assertions
// Sections collect into a list, so §7 can run them against a mutant and count
// what they catch; record() tallies a list.
let pass = 0, fail = 0;
const failures = [];
function collector() {
	const results = [];
	const t = (name, actual, expected) => {
		const a = JSON.stringify(actual), e = JSON.stringify(expected);
		results.push({ ok: a === e, name, a, e });
	};
	return { results, t };
}
function record(results) {
	for (const r of results) {
		if (r.ok) { pass++; continue; }
		fail++;
		failures.push(`${r.name}\n     expected ${r.e}\n     actual   ${r.a}`);
		console.log(`  FAIL  ${r.name}\n          expected ${r.e}\n          actual   ${r.a}`);
	}
}

// ───────────────────────────────────────────────────────────────── §1 step 2
function stepTwoSection(over) {
	const { results, t } = collector();
	{
		// A driver with no account (a directory-only driver): the receipt filed with
		// a doubled space meets the assignment to the single-spaced name.
		const w = runWorld({ trucks: [T101], assignments: [[1, SK, SEP1]],
			expenses: [{ id: 1, driver: "Shorn  King", date: OPEN_DAY }] }, over);
		t("§1 a doubled-space variant of the assigned driver's name, open month, inside the window: the truck and its owner",
			w.row(1), ["101", 5]);
		t("§1 ...counted in pass1 and in pass1Spacing, with no error", [w.health.pass1, w.health.pass1Spacing, w.health.pass2, w.health.error], [1, 1, 0, null]);
		t("§1 ...and logged as a spacing match", w.logs, [SPACING_LOG(1, 1)]);
	}
	{
		// The driver's own account holds the doubled-space spelling their session
		// files receipts under; the truck was assigned under the single-spaced one.
		const w = runWorld({ accounts: [[2, "Shorn  King"]], trucks: [T101], assignments: [[1, SK, SEP1]],
			expenses: [{ id: 1, driver: "Shorn  King", date: OPEN_DAY }] }, over);
		t("§1 the driver's own account spelled as the receipt is: stamped", [w.row(1), w.health.error], [["101", 5], null]);
	}
	{
		const w = runWorld({ trucks: [T101], assignments: [[1, SK, SEP1]],
			expenses: [{ id: 1, driver: " shorn   KING ", date: OPEN_DAY }] }, over);
		t("§1 edge spaces, a longer run and case together: stamped", w.row(1), ["101", 5]);
	}
	{
		// The window is step 1's: each bound inclusive of its own day, nothing outside.
		const w = runWorld({ trucks: [T101, T205],
			assignments: [[1, SK, SEP1], [2, "Deshorn King", AUG1, "2026-09-05T23:10:00.000Z"]],
			expenses: [
				{ id: 1, driver: "Shorn  King", date: "2026-09-01" },
				{ id: 2, driver: "Shorn  King", date: "2026-08-31" },
				{ id: 3, driver: "Deshorn  King", date: "2026-09-05" },
				{ id: 4, driver: "Deshorn  King", date: "2026-09-06" },
			] }, over);
		t("§1 the assignment's first day (a 22:30Z start): stamped", w.row(1), ["101", 5]);
		t("§1 the day before it starts: untouched", w.row(2), ["", 0]);
		t("§1 the day it ends: stamped", w.row(3), ["205", 7]);
		t("§1 the day after it ends: untouched", w.row(4), ["", 0]);
	}
	{
		// Two covering assignments name the driver across spacing: the newest start
		// wins, not the newest row (the newer start is written first here).
		const w = runWorld({ trucks: [T101, T300], assignments: [[1, "Shorn   King", SEP1], [3, SK, AUG1]],
			expenses: [{ id: 1, driver: "Shorn  King", date: OPEN_DAY }] }, over);
		t("§1 two covering spacing variants: the one with the newest start_date", w.row(1), ["101", 5]);
	}
	return results;
}

// ───────────────────────────────────────────────────────────────── §2 the period lock
function lockSection(over) {
	const { results, t } = collector();
	{
		const w = runWorld({ trucks: [T101], assignments: [[1, SK, JUN1]], locks: [["2026-07"]],
			expenses: [
				{ id: 1, driver: "Shorn  King", date: "2026-07-10" },
				{ id: 2, driver: "Shorn  King", date: OPEN_DAY },
			] }, over);
		t("§2 the same spacing match in a finalized month: untouched", w.row(1), ["", 0]);
		t("§2 ...while its open-month twin is stamped, so the lock is what held it", w.row(2), ["101", 5]);
		t("§2 ...counted as skipped under its month, and not as written",
			[w.health.skippedLockedPeriod, w.health.skippedPeriods, w.health.pass1, w.health.pass1Spacing], [1, ["2026-07"], 1, 1]);
		t("§2 ...logged as ACTION NEEDED",
			w.logs.filter((l) => l.startsWith("warn")),
			["warn Expense backfill: ACTION NEEDED — 1 legacy receipt(s) in finalized period(s) [2026-07] could not be attributed (truck_unit/owner_id). Reopen the period to correct them."]);
		t("§2 ...and audited", w.audits(),
			["legacy_expense_backfill_skipped: 1 legacy receipt(s) left unattributed because their period(s) are finalized: 2026-07"]);
	}
	{
		// A prior-period adjustment: its date is in the finalized month and it is
		// booked to an open one. Both months must be open for a write.
		const w = runWorld({ trucks: [T101], assignments: [[1, SK, JUN1]], locks: [["2026-07"]],
			expenses: [{ id: 1, driver: "Shorn  King", date: "2026-07-12", posted_period: "2026-09" }] }, over);
		t("§2 a prior-period adjustment dated in the finalized month: untouched", [w.row(1), w.health.skippedLockedPeriod], [["", 0], 1]);
	}
	{
		const w = runWorld({ trucks: [T101], assignments: [[1, SK, JUN1]], locks: [["2026-08", "reopened"]],
			expenses: [{ id: 1, driver: "Shorn  King", date: "2026-08-15" }] }, over);
		t("§2 a reopened month is open: stamped", w.row(1), ["101", 5]);
	}
	{
		// period_locks rebuilt without its status column: its SELECT throws, and
		// isLocked() on its own would answer "not locked" for every month.
		const w = runWorld({ trucks: [T101, T410], assignments: [[1, SK, SEP1]],
			expenses: [
				{ id: 1, driver: "Shorn  King", date: OPEN_DAY },
				{ id: 2, driver: "SHORN KING", date: OPEN_DAY },
				{ id: 3, driver: "Pat Newhire", date: OPEN_DAY, truck_unit: "410" },
			] }, over, (db) => db.exec("DROP TABLE period_locks; CREATE TABLE period_locks (period TEXT PRIMARY KEY, finalized_at TEXT)"));
		t("§2 period_locks unreadable: every row untouched, pass 2's included", snapshot(w.db), w.before);
		t("§2 ...every candidate counted as withheld, and the error recorded",
			[w.health.skippedLockedPeriod, w.health.pass1, w.health.pass1Spacing, w.health.pass2, w.health.error],
			[3, 0, 0, 0, "period_locks unreadable — every candidate row was withheld"]);
		t("§2 ...audited as unreadable, not as finalized", w.audits(),
			["legacy_expense_backfill_skipped: 3 legacy receipt(s) left unattributed because period_locks could not be read; lock state unknown for [2026-09]"]);
	}
	return results;
}

// ───────────────────────────────────────────────────────────────── §3 the other-account guard
function guardSection(over) {
	const { results, t } = collector();
	const REAL = [2, SK];
	const LEGACY = [4, "Shorn  King"];
	{
		// A legacy account files under its own spelling; the truck was assigned to
		// the real driver.
		const w = runWorld({ accounts: [REAL, LEGACY], trucks: [T101], assignments: [[1, SK, SEP1]],
			expenses: [{ id: 1, driver: "Shorn  King", date: OPEN_DAY }] }, over);
		t("§3 a legacy account's receipt, the truck assigned to the real driver: untouched", w.row(1), ["", 0]);
		t("§3 ...nothing counted or logged, and no error", [w.health.pass1, w.health.pass1Spacing, w.logs, w.health.error], [0, 0, [], null]);
	}
	{
		// The other way round: the real driver's receipt, a truck assigned under the
		// legacy account's spelling.
		const w = runWorld({ accounts: [REAL, LEGACY], trucks: [T101], assignments: [[1, "Shorn  King", SEP1]],
			expenses: [{ id: 1, driver: SK, date: OPEN_DAY }] }, over);
		t("§3 the real driver's receipt, the truck assigned under the legacy spelling: untouched", w.row(1), ["", 0]);
	}
	{
		// A spelling no account has, beside the account that has the name: the stamp
		// at insert refuses it too (findTruckForDriverStamp()).
		const w = runWorld({ accounts: [REAL], trucks: [T101], assignments: [[1, SK, SEP1]],
			expenses: [{ id: 1, driver: "Shorn  King", date: OPEN_DAY }] }, over);
		t("§3 a spelling no account has, beside the account that has the name: untouched", w.row(1), ["", 0]);
	}
	return results;
}

// ───────────────────────────────────────────────────────────────── §4 step 1 and pass 2 unchanged
function unchangedSection(over) {
	const { results, t } = collector();
	{
		const w = runWorld({ trucks: [T101], assignments: [[1, SK, SEP1]],
			expenses: [{ id: 1, driver: "SHORN KING", date: OPEN_DAY }] }, over);
		t("§4 a case-only variant of the assigned name: stamped by step 1", w.row(1), ["101", 5]);
		t("§4 ...counted in pass1, not in pass1Spacing", [w.health.pass1, w.health.pass1Spacing], [1, 0]);
	}
	{
		// Step 1 never asked the other-account guard, and still does not.
		const w = runWorld({ accounts: [[2, SK], [4, "Shorn  King"]], trucks: [T101], assignments: [[1, "shorn king", SEP1]],
			expenses: [{ id: 1, driver: SK, date: OPEN_DAY }] }, over);
		t("§4 a case-aside match beside an account holding a spacing variant: still stamped", w.row(1), ["101", 5]);
	}
	{
		// A case-aside assignment wins over a spacing variant that started later.
		const w = runWorld({ trucks: [T101, T300], assignments: [[3, "shorn king", AUG1], [1, "Shorn  King", SEP1]],
			expenses: [{ id: 1, driver: SK, date: OPEN_DAY }] }, over);
		t("§4 a case-aside assignment beats a later-starting spacing variant", w.row(1), ["300", 9]);
	}
	{
		// A truck linked to an investor after its receipts were stamped.
		const w = runWorld({ trucks: [T410], expenses: [{ id: 1, driver: "Pat Newhire", date: OPEN_DAY, truck_unit: "410" }] }, over);
		t("§4 pass 2 still refreshes owner_id from the truck", [w.row(1), w.health.pass2], [["410", 11], 1]);
	}
	return results;
}

// ───────────────────────────────────────────────────────────────── §5 only a matched row is written
// Every kind of row at once: a spacing match (1), a case-aside match (2), a
// refused spacing match (3), a finalized month (4), no assignment (5), a pass-2
// refresh (6), and a row the old pass 1 had already rewritten to NULLs (7).
const EVERYTHING = {
	accounts: [[2, SK], [4, "Shorn  King"], [6, "Deshorn  King"]],
	trucks: [T101, T205, T410],
	assignments: [[1, SK, SEP1], [2, "Deshorn King", JUN1]],
	locks: [["2026-07"]],
	expenses: [
		{ id: 1, driver: "Deshorn  King", date: OPEN_DAY },
		{ id: 2, driver: "SHORN KING", date: OPEN_DAY },
		{ id: 3, driver: "Shorn  King", date: OPEN_DAY },
		{ id: 4, driver: "Deshorn  King", date: "2026-07-10" },
		{ id: 5, driver: "Pat Newhire", date: OPEN_DAY },
		{ id: 6, driver: "Pat Newhire", date: OPEN_DAY, truck_unit: "410" },
		{ id: 7, driver: "Pat Newhire", date: OPEN_DAY, truck_unit: null, owner_id: null },
	],
};
function idempotenceSection(over) {
	const { results, t } = collector();
	{
		const w = runWorld({ trucks: [T101], assignments: [[1, SK, SEP1]],
			expenses: [
				{ id: 1, driver: "Pat Newhire", date: OPEN_DAY },
				{ id: 2, driver: "Pat Newhire", date: OPEN_DAY, owner_id: 9 },
				{ id: 3, driver: "Pat Newhire", date: OPEN_DAY, truck_unit: null, owner_id: null },
			] }, over);
		t("§5 unmatched rows keep exactly what they had: ('', 0) stays text and integer, an owner stays, NULLs stay", snapshot(w.db), w.before);
		t("§5 ...nothing counted and nothing logged", [w.health.pass1, w.health.pass2, w.logs], [0, 0, []]);
	}
	{
		const w = runWorld(EVERYTHING, over);
		t("§5 the first boot writes the spacing match, the case-aside match and the pass-2 refresh, and nothing else",
			[w.row(1), w.row(2), w.row(3), w.row(4), w.row(5), w.row(6), w.row(7)],
			[["205", 7], ["101", 5], ["", 0], ["", 0], ["", 0], ["410", 11], [null, null]]);
		t("§5 ...counting them", [w.health.pass1, w.health.pass1Spacing, w.health.pass2, w.health.skippedLockedPeriod, w.health.error], [2, 1, 1, 1, null]);
		const afterFirst = snapshot(w.db);
		const second = w.again();
		t("§5 a second boot over the same data changes nothing", [second.pass1, second.pass1Spacing, second.pass2, snapshot(w.db)], [0, 0, 0, afterFirst]);
		t("§5 ...and logs no backfill line (the finalized month is still reported, as on every boot)",
			w.logs.map((l) => l.replace(/ — .*/, "")), ["warn Expense backfill: ACTION NEEDED"]);
	}
	return results;
}

// ───────────────────────────────────────────────────────────────── §6 boot order
function bootOrderSection() {
	const { results, t } = collector();
	const callAt = SRC.indexOf(`\n${CALL_STMT}\n`);
	// Everything the call graph reads exists by the time the call runs: the
	// tables, the columns the migrations add to expenses (with the defaults an
	// untouched row keeps), and the users columns driverNameHeldByOtherSpelling()
	// reads.
	for (const needle of [
		"CREATE TABLE IF NOT EXISTS users (",
		"CREATE TABLE IF NOT EXISTS expenses (",
		"CREATE TABLE IF NOT EXISTS trucks (",
		"CREATE TABLE IF NOT EXISTS truck_assignments (",
		"CREATE TABLE IF NOT EXISTS period_locks (",
		"CREATE TABLE IF NOT EXISTS audit_trail (",
		"ALTER TABLE expenses ADD COLUMN owner_id INTEGER DEFAULT 0",
		"ALTER TABLE expenses ADD COLUMN truck_unit TEXT DEFAULT ''",
		"ALTER TABLE expenses ADD COLUMN posted_period TEXT DEFAULT ''",
	]) {
		const at = SRC.indexOf(needle);
		t(`§6 above the call: ${needle}`, at > -1 && at < callAt, true);
	}
	const usersAt = SRC.indexOf("CREATE TABLE IF NOT EXISTS users (");
	const usersDdl = SRC.slice(usersAt, SRC.indexOf("\n\t)", usersAt));
	t("§6 ...and users is created with username and driver_name", /\busername TEXT\b/.test(usersDdl) && /\bdriver_name TEXT\b/.test(usersDdl), true);
	// Where the block always ran: right below its health object, above
	// assignDriverToTruck(), and nowhere else.
	t("§6 the call is the statement right below the health object",
		SRC.startsWith(`${CALL_STMT}\n`, SRC.indexOf(HEALTH_DECL) + HEALTH_DECL.length), true);
	t("§6 ...above assignDriverToTruck(), where the block sat", callAt > -1 && callAt < SRC.indexOf("\nfunction assignDriverToTruck("), true);
	t("§6 ...and the backfill is called nowhere else", SRC.split("backfillLegacyExpenseTrucks(").length - 1, 2);
	// The simulation is only as good as the list it declares.
	t("§6 the TDZ simulation declares the file's later bindings (not vacuous)",
		LATE.lexical.size >= 100 && LATE.lexical.has("EXPENSE_PNL_FILTER"), true);
	t("§6 every declaration below the call is one the simulation can read", UNREAD_DECLARATIONS, []);
	return results;
}

// ───────────────────────────────────────────────────────────────── run
section("§1 step 2 — a spacing variant of the assigned driver's name");
record(stepTwoSection());
section("§2 the period lock");
record(lockSection());
section("§3 the other-account guard");
record(guardSection());
section("§4 step 1 and pass 2 unchanged");
record(unchangedSection());
section("§5 only a matched row is written");
record(idempotenceSection());
section("§6 boot order");
record(bootOrderSection());

// ───────────────────────────────────────────────────────────────── §7 mutants
section("§7 mutants");
const FN = GRAPH_SRC.backfillLegacyExpenseTrucks;
const NORMALIZE_RETURN = 'return (s || "").trim().toLowerCase().replace(/\\s+/g, " ");';
// A world §1 stamps through step 2, which calls normalizeDriverName().
const STEP_TWO_WORLD = { trucks: [T101], assignments: [[1, SK, SEP1]], expenses: [{ id: 1, driver: "Shorn  King", date: OPEN_DAY }] };
const MUTANTS = [
	["M1 the other-account guard removed",
		() => guardSection({ backfillLegacyExpenseTrucks: mutate(FN, "\t\t\tif (heldByOtherSpelling.get(r.driver)) continue;\n", "") })],
	["M2 step 1 writes every candidate again (the EXISTS match guard removed)",
		() => idempotenceSection({ backfillLegacyExpenseTrucks: mutate(FN, "\t\t\t  AND EXISTS (SELECT 1 ${caseAsideAssignment})\n", "") })],
	["M3 step 2 run over the finalized months too",
		() => lockSection({ backfillLegacyExpenseTrucks: mutate(FN, "for (const r of p1.open) {", "for (const r of pass1Candidates) {") })],
	["M4 the call graph reads a binding declared below the call (EXPENSE_PNL_FILTER)",
		() => stepTwoSection({ normalizeDriverName: mutate(GRAPH_SRC.normalizeDriverName, NORMALIZE_RETURN, `void EXPENSE_PNL_FILTER; ${NORMALIZE_RETURN}`) })],
];
for (const [label, run] of MUTANTS) {
	let caught;
	try {
		caught = run().filter((r) => !r.ok);
	} catch (e) {
		record([{ ok: false, name: `${label}: the mutant runs (${e.message})`, a: "threw", e: "ran" }]);
		continue;
	}
	record([{ ok: caught.length > 0, name: `${label}: caught`, a: caught.length, e: ">0" }]);
	console.log(`  caught  ${label}: by ${caught.length} check(s), e.g. ${caught[0] ? caught[0].name : "(none)"}`);
}
// M4 is only evidence if what it tripped is the temporal dead zone itself, and
// the same read of a binding declared ABOVE the call (db) must pass: the
// simulation flags the late bindings, not every extra reference.
{
	const tdz = runWorld(STEP_TWO_WORLD, { normalizeDriverName: mutate(GRAPH_SRC.normalizeDriverName, NORMALIZE_RETURN, `void EXPENSE_PNL_FILTER; ${NORMALIZE_RETURN}`) });
	const { results, t } = collector();
	t("§7 M4 trips the real temporal dead zone, and the backfill records it rather than crashing boot",
		[tdz.health.error, tdz.row(1)], ["Cannot access 'EXPENSE_PNL_FILTER' before initialization", ["", 0]]);
	const early = stepTwoSection({ normalizeDriverName: mutate(GRAPH_SRC.normalizeDriverName, NORMALIZE_RETURN, `void db; ${NORMALIZE_RETURN}`) });
	t("§7 control: the same read of a binding declared above the call (db) passes every §1 check",
		early.filter((r) => !r.ok).map((r) => r.name), []);
	record(results);
}

function section(title) { console.log(`\n${title}`); }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
	console.log("Failures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
