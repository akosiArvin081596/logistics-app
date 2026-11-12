"use strict";

// The users table's start-up role check, which server.js runs once, right after the users CREATE. A probe
// row, inserted and deleted in one transaction, asks whether the role CHECK admits "Super Admin". Only a
// refusal by that CHECK, on a table whose role list leaves "Super Admin" out, starts the rebuild to the
// four roles. Any other failure logs one line and leaves the table as it is, as server.js's other start-up
// migrations do; so does a table this rebuild can't carry exactly.
//
// The rebuild follows the order SQLite documents for a schema change ("Making Other Kinds Of Table Schema
// Changes"): foreign keys off outside the transaction; create the new table, copy, drop the old one,
// rename the new one, re-create the indexes and triggers; foreign_key_check before the commit. It is one
// transaction, so a failure at any step leaves the table, its rows and the child tables as they were.
//
// scripts/test-users-boot-probe.js covers it, with mutants.

const crypto = require("crypto");
const { checkRoles } = require("./users-role-migration");

const TABLE = "users";
const NEW_TABLE = "users_new";
const ROLES = Object.freeze(["Super Admin", "Dispatcher", "Driver", "Investor"]);
const PROBE_ROLE = "Super Admin";
// The probe row. Its INSERT and DELETE commit together (one id per start) or not at all.
const PROBE_INSERT = "INSERT INTO users (username, password_hash, role) VALUES ('__test_sa__', '__test__', 'Super Admin')";
const PROBE_DELETE = "DELETE FROM users WHERE username = '__test_sa__'";
// The columns the rebuild carries: server.js's users CREATE, before its ALTERs add the rest. A table with
// any other set of columns isn't rebuilt, so no column's values are dropped.
const COLUMNS = Object.freeze(["id", "username", "password_hash", "role", "driver_name", "email", "created_at"]);
const CREATE_NEW = `CREATE TABLE ${NEW_TABLE} (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL CHECK(role IN ('Super Admin', 'Dispatcher', 'Driver', 'Investor')),
	driver_name TEXT DEFAULT '',
	email TEXT DEFAULT '',
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;
// "Admin" is the Super Admin role's older name: those rows are copied as "Super Admin".
const ROLE_COPY = "CASE role WHEN 'Admin' THEN 'Super Admin' ELSE role END";
const COPY = `INSERT INTO ${NEW_TABLE} (${COLUMNS.join(", ")}) SELECT ${COLUMNS.map((c) => (c === "role" ? ROLE_COPY : c)).join(", ")} FROM ${TABLE}`;
// The rebuild's steps, in order (a runner's hook may fail any of them, and the probe's three).
const STEPS = Object.freeze(["begin", "read", "create", "copy", "drop", "rename", "recreate", "sequence", "sessions", "fkcheck", "verify", "commit"]);
const PROBE_STEPS = Object.freeze(["probe insert", "probe delete", "probe commit"]);
const LOG = "[users] start-up role check:";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameNames = (a, b) => same([...a].map((n) => String(n).toLowerCase()).sort(), [...b].map((n) => String(n).toLowerCase()).sort());
// The SQLite code of a failure (never its message), so a log line carries no data.
const codeOf = (err) => (err && typeof err.code === "string" && err.code) || (err && err.name) || "error";

function failure(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function tableSql(db, name) {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
	return row ? row.sql : null;
}
const hasTable = (db, name) => tableSql(db, name) !== null;
const columnNames = (db) => db.prepare("SELECT name FROM pragma_table_xinfo(?) ORDER BY cid").pluck().all(TABLE);

function rollback(db) {
	try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* the caller checks inTransaction after */ }
}

// Null when the role CHECK admits the probe row, else the failure. Nothing it writes survives a failure.
function probe(db, at) {
	try {
		db.exec("BEGIN IMMEDIATE");
	} catch (err) {
		return err;
	}
	try {
		at("probe insert");
		db.prepare(PROBE_INSERT).run();
		at("probe delete");
		db.prepare(PROBE_DELETE).run();
		at("probe commit");
		db.exec("COMMIT");
		return null;
	} catch (err) {
		rollback(db);
		return err;
	}
}

// Whether the table's one role CHECK is a list that leaves "Super Admin" out.
function roleListRefuses(db) {
	const roles = checkRoles(tableSql(db, TABLE));
	return Array.isArray(roles) && !roles.includes(PROBE_ROLE);
}

// A refusal by the role CHECK itself: a CHECK failure on a table whose role list leaves "Super Admin" out.
// Another constraint, another CHECK, or a busy or read-only database is not one.
function roleRefused(db, err) {
	if (!err || err.code !== "SQLITE_CONSTRAINT_CHECK") return false;
	try {
		return roleListRefuses(db);
	} catch {
		return false;
	}
}

// Why this rebuild can't carry the table as it is now, or null.
function problemOf(db) {
	const names = columnNames(db);
	if (!sameNames(names, COLUMNS)) return `it has ${names.length} columns, not the ${COLUMNS.length} this rebuild carries`;
	if (hasTable(db, NEW_TABLE)) return `a table named ${NEW_TABLE} exists`;
	return null;
}

// Every row in rowid order, each value with its storage class (quote()). `role` is how the role column is
// read: before the copy, as the copy writes it.
function rowsFingerprint(db, role) {
	const cols = COLUMNS.map((c) => `quote(${c === "role" ? role : c})`).join(", ");
	const hash = crypto.createHash("sha256");
	for (const row of db.prepare(`SELECT ${cols} FROM ${TABLE} ORDER BY rowid`).raw().iterate()) hash.update(`${JSON.stringify(row)}\n`);
	return hash.digest("hex");
}

// Indexes and triggers on users with SQL: DROP TABLE removes them, so they are re-created after the rename.
// The UNIQUE auto-index has none; it comes back with the new table, under its old name.
const attachedTo = (db) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name").all(TABLE);
// Every other schema entry, the child tables' REFERENCES users among them, must read the same after.
const otherSchema = (db) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN (?, ?) ORDER BY type, name").all(TABLE, NEW_TABLE);
const violations = (db) => db.prepare("SELECT * FROM pragma_foreign_key_check()").all().map((v) => JSON.stringify([v.table, v.rowid, v.parent, v.fkid]));

function sequenceOf(db) {
	if (!hasTable(db, "sqlite_sequence")) return null;
	const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(TABLE);
	return row ? row.seq : null;
}

// AUTOINCREMENT's high-water mark: the rename leaves the copy's (the highest id copied), so the old one is
// put back and an id a deleted account had is never handed out again. CAST: a bound number arrives as REAL.
function carrySequence(db, old) {
	if (old === null || old === undefined) return;
	const updated = db.prepare("UPDATE sqlite_sequence SET seq = MAX(CAST(? AS INTEGER), seq) WHERE name = ?").run(old, TABLE).changes;
	if (updated === 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))").run(TABLE, old);
}

// Read again inside the transaction, so a table changed since the probe is never rebuilt.
function readPlan(db) {
	if (!roleListRefuses(db)) throw failure("USERS_TABLE_CHANGED", `the role CHECK no longer leaves "${PROBE_ROLE}" out`);
	const problem = problemOf(db);
	if (problem) throw failure("USERS_TABLE_CHANGED", problem);
	return {
		rows: db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n,
		renamed: db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE role = 'Admin'`).get().n,
		expected: rowsFingerprint(db, ROLE_COPY),
		attached: attachedTo(db),
		others: otherSchema(db),
		violations: new Set(violations(db)),
		sequence: sequenceOf(db),
	};
}

// What differs from the plan after the rename, by name only.
function differences(db, plan) {
	const out = [];
	if (!same(checkRoles(tableSql(db, TABLE)), ROLES)) out.push("roles");
	if (!same(columnNames(db), COLUMNS)) out.push("columns");
	if (db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n !== plan.rows) out.push("row count");
	if (rowsFingerprint(db, "role") !== plan.expected) out.push("rows");
	if (!same(attachedTo(db), plan.attached)) out.push("indexes or triggers");
	if (!same(otherSchema(db), plan.others)) out.push("other schema");
	if (hasTable(db, NEW_TABLE)) out.push(NEW_TABLE);
	if (plan.sequence !== null && !(sequenceOf(db) >= plan.sequence)) out.push("sequence");
	return out;
}

// The rebuild, all or nothing. Returns { state: "rebuilt", rows, renamed } or { state: "rolled back", step,
// code }. Throws only when it can't leave the connection as it found it (a transaction still open, or
// foreign keys not back on), so nothing else runs on it.
function rebuild(db, at) {
	const keysWereOn = db.pragma("foreign_keys", { simple: true }) === 1;
	let step = "foreign keys";
	let plan = null;
	let failed = null;
	let cleared = false;
	const enter = (name) => {
		step = name;
		at(name);
	};
	try {
		// The pragma does nothing inside a transaction, so it is set, and checked, before BEGIN.
		db.pragma("foreign_keys = OFF");
		if (db.pragma("foreign_keys", { simple: true }) !== 0) throw failure("USERS_FOREIGN_KEYS_ON", "foreign keys could not be turned off");
		enter("begin");
		db.exec("BEGIN IMMEDIATE");
		enter("read");
		plan = readPlan(db);
		enter("create");
		db.exec(CREATE_NEW);
		enter("copy");
		const copied = db.prepare(COPY).run().changes;
		if (copied !== plan.rows) throw failure("USERS_COPY_COUNT", `copied ${copied} rows, not ${plan.rows}`);
		enter("drop");
		db.exec(`DROP TABLE ${TABLE}`);
		enter("rename");
		db.exec(`ALTER TABLE ${NEW_TABLE} RENAME TO ${TABLE}`);
		enter("recreate");
		for (const entry of plan.attached) db.exec(entry.sql);
		enter("sequence");
		carrySequence(db, plan.sequence);
		// Sessions hold the role each user signed in with, so everyone signs in again under the new list.
		enter("sessions");
		if (hasTable(db, "sessions")) {
			db.exec("DELETE FROM sessions");
			cleared = true;
		}
		enter("fkcheck");
		const added = violations(db).filter((v) => !plan.violations.has(v)).length;
		if (added) throw failure("USERS_FOREIGN_KEY_CHECK", `${added} foreign-key violation(s) the rebuild would add`);
		enter("verify");
		const differ = differences(db, plan);
		if (differ.length) throw failure("USERS_VERIFY", `differs before the commit: ${differ.join(", ")}`);
		enter("commit");
		db.exec("COMMIT");
	} catch (err) {
		rollback(db);
		failed = err;
	} finally {
		if (keysWereOn && !db.inTransaction) db.pragma("foreign_keys = ON");
	}
	if (db.inTransaction) throw new Error(`${LOG} the rebuild's transaction is still open after a failure at ${step}; stopping`);
	if (keysWereOn && db.pragma("foreign_keys", { simple: true }) !== 1) throw new Error(`${LOG} foreign keys are still off after the rebuild; stopping`);
	if (failed) return { state: "rolled back", step, code: codeOf(failed) };
	return { state: "rebuilt", rows: plan.rows, renamed: plan.renamed, sessionsCleared: cleared };
}

// The start-up check. Returns { state: "admits" } (nothing logged, the probe's one id used), or
// "skipped", "rebuilt" or "rolled back", each with one line in the log. `hooks.beforeStep(name, db)` is a
// runner's way to fail a step; server.js passes none.
function startupRoleCheck(db, { log = console, hooks = {} } = {}) {
	const at = (name) => {
		if (typeof hooks.beforeStep === "function") hooks.beforeStep(name, db);
	};
	if (db.inTransaction) {
		log.error(`${LOG} a transaction is open; nothing checked, users left as it is`);
		return { state: "skipped", code: "IN_TRANSACTION" };
	}
	const err = probe(db, at);
	if (db.inTransaction) throw new Error(`${LOG} the probe's transaction is still open; stopping`);
	if (!err) return { state: "admits" };
	if (!roleRefused(db, err)) {
		log.error(`${LOG} the probe failed (${codeOf(err)}), not on the role CHECK; no rebuild, users left as it is`);
		return { state: "skipped", code: codeOf(err) };
	}
	let problem;
	try {
		problem = problemOf(db);
	} catch (readErr) {
		problem = `it can't be read (${codeOf(readErr)})`;
	}
	if (problem) {
		log.error(`${LOG} the role CHECK leaves "${PROBE_ROLE}" out, but ${problem}; no rebuild, users left as it is`);
		return { state: "skipped", code: "NOT_CARRIED" };
	}
	const result = rebuild(db, at);
	if (result.state === "rebuilt") {
		log.log(`${LOG} the role CHECK left "${PROBE_ROLE}" out; users rebuilt with the four roles in one transaction (${result.rows} rows, ${result.renamed} "Admin" now "${PROBE_ROLE}"${result.sessionsCleared ? "; sessions cleared" : ""})`);
	} else {
		log.error(`${LOG} the rebuild failed at ${result.step} (${result.code}) and was rolled back; users left as it was`);
	}
	return result;
}

module.exports = {
	TABLE, NEW_TABLE, ROLES, COLUMNS, CREATE_NEW, STEPS, PROBE_STEPS, PROBE_INSERT, PROBE_DELETE,
	startupRoleCheck,
};
