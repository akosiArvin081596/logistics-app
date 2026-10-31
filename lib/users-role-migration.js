"use strict";

// The users table's role CHECK: reading it, and the one rebuild that widens it to admit "KPI Viewer".
// SQLite can't alter a CHECK, so the table is rebuilt in the order SQLite documents ("Making Other Kinds
// Of Table Schema Changes"): create the new table, copy, drop the old one, rename the new one. Renaming
// the old table first would repoint the child tables' foreign keys at it.
//
// scripts/migrate-users-kpi-viewer-role.js is the only writer; server.js runs kpiViewerBootCheck() at
// start. scripts/test-users-role-migration.js covers both, with mutants.

const crypto = require("crypto");

const KPI_VIEWER_ROLE = "KPI Viewer";
const MIGRATION_SCRIPT = "scripts/migrate-users-kpi-viewer-role.js";
const TABLE = "users";
const NEW_TABLE = "users_new";
const ACTOR = "system: users role migration";
const AUDIT_ACTION = "migrate_users_role_check";
// 0 applied or nothing to do; 2 refused, nothing written; 3 rolled back, the table as it was;
// 4 committed but an after-fact differs.
const EXIT = Object.freeze({ DONE: 0, REFUSED: 2, ROLLED_BACK: 3, DIFFERS: 4 });
// The steps inside the transaction, in order (a runner's hook may fail any of them).
const STEPS = Object.freeze(["read", "create", "copy", "drop", "rename", "recreate", "sequence", "fkcheck", "verify", "audit", "commit"]);
// What a CREATE can carry that PRAGMA table_info doesn't report, so a rebuild from it would drop.
const UNREPORTED = [
	[/\bCOLLATE\b/i, "a COLLATE clause"],
	[/\bON\s+CONFLICT\b/i, "an ON CONFLICT clause"],
	[/\bREFERENCES\b/i, "a foreign key"],
	[/\bGENERATED\b|\bAS\s*\(/i, "a generated column"],
	[/\bCONSTRAINT\b/i, "a named constraint"],
];

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byJson = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);

class Outcome extends Error {
	constructor(exit, state, reasons) {
		super(reasons.join("; "));
		this.exit = exit;
		this.state = state;
		this.reasons = reasons;
	}
}

// Flag: KPI_VIEWER_ENABLED (default off), on only when the environment sets it to exactly "true".
function kpiViewerEnabled({ env } = process) {
	return !!env && env.KPI_VIEWER_ENABLED === "true";
}

// The role list of the one CHECK(role IN (...)) in a CREATE statement, or null unless there is exactly one
// such CHECK and it lists plain quoted strings.
function checkRoles(sql) {
	if (typeof sql !== "string") return null;
	const heads = [...sql.matchAll(/\bCHECK\s*\(\s*(?:"role"|`role`|\[role\]|role)\s+IN\s*\(/gi)];
	if (heads.length !== 1) return null;
	let i = heads[0].index + heads[0][0].length;
	const skip = () => { while (i < sql.length && /\s/.test(sql[i])) i++; };
	const roles = [];
	for (;;) {
		skip();
		if (sql[i] !== "'") return null;
		let value = "";
		for (i++; ; i++) {
			if (i >= sql.length) return null;
			if (sql[i] !== "'") { value += sql[i]; continue; }
			if (sql[i + 1] === "'") { value += "'"; i++; continue; }
			i++;
			break;
		}
		roles.push(value);
		skip();
		if (sql[i] === ",") { i++; continue; }
		if (sql[i] !== ")") return null;
		i++;
		skip();
		return sql[i] === ")" ? roles : null;
	}
}

function tableSql(db, name) {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
	return row ? row.sql : null;
}

function columnsOf(db, table) {
	return db.prepare("SELECT * FROM pragma_table_info(?) ORDER BY cid").all(table)
		.map((c) => ({ cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
}

// A table's UNIQUE and primary-key indexes by what they cover; names are left out because the new
// table's carry its own name until the rename.
function constraintIndexes(db, table) {
	return db.prepare("SELECT * FROM pragma_index_list(?) WHERE origin IN ('u', 'pk')").all(table).map((ix) => ({
		origin: ix.origin,
		unique: ix.unique,
		partial: ix.partial,
		columns: db.prepare("SELECT name, coll, \"desc\" FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno").all(ix.name),
	})).sort(byJson);
}

// Indexes and triggers on users: DROP TABLE removes them, so the rebuild re-creates those with SQL. The
// UNIQUE auto-index has none; it comes back with the new table and takes the old name at the rename.
function attachedTo(db, table) {
	return db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') ORDER BY type, name").all(table);
}

// Every table with a foreign key to users, with all of its foreign keys (four today).
function childForeignKeys(db) {
	const out = [];
	for (const name of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all()) {
		const keys = db.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(name);
		if (!keys.some((k) => String(k.table).toLowerCase() === TABLE)) continue;
		out.push({
			table: name,
			keys: keys.map((k) => ({ id: k.id, seq: k.seq, table: k.table, from: k.from, to: k.to, on_update: k.on_update, on_delete: k.on_delete, match: k.match }))
				.sort((a, b) => a.id - b.id || a.seq - b.seq),
		});
	}
	return out;
}

// The facts the structural fingerprint covers. Nothing here moves with normal use (sign-ins, the session
// sweep, each start's probe row), so a dry run's fingerprint still holds when the apply runs.
function readStructure(db) {
	const ddl = tableSql(db, TABLE);
	const roles = checkRoles(ddl);
	return {
		ddl,
		columns: ddl ? columnsOf(db, TABLE) : [],
		roles,
		admits: Array.isArray(roles) && roles.includes(KPI_VIEWER_ROLE),
		children: childForeignKeys(db),
		attached: ddl ? attachedTo(db, TABLE) : [],
	};
}

const fingerprintOf = (structure) => sha(JSON.stringify(structure)).slice(0, 16);

function foreignKeyViolations(db) {
	return db.prepare("SELECT * FROM pragma_foreign_key_check()").all()
		.map((v) => ({ table: v.table, rowid: v.rowid, parent: v.parent, fkid: v.fkid }));
}
const violationKey = (v) => JSON.stringify([v.table, v.rowid, v.parent, v.fkid]);

function violationCounts(violations) {
	const counts = new Map();
	for (const v of violations) counts.set(v.table, (counts.get(v.table) || 0) + 1);
	return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([table, count]) => ({ table, count }));
}

// The violations already present, by table and count: the dry run prints it and --apply must name it.
const baselineOf = (counts) => (counts.length ? `fk-${sha(JSON.stringify(counts)).slice(0, 12)}` : "fk-none");

// Violations now present that `baseline` didn't hold, matched by child table, rowid, parent and key.
function addedViolations(db, baseline) {
	const known = new Set(baseline.map(violationKey));
	return foreignKeyViolations(db).filter((v) => !known.has(violationKey(v)));
}

const hasTable = (db, name) => tableSql(db, name) !== null;

// Every column of every row in id order, each value with its storage class (quote()), so a copy that
// changed, retyped or lost a value doesn't match. Identifiers come from PRAGMA table_info, quoted.
function rowsFingerprint(db, columns) {
	const hash = crypto.createHash("sha256").update(JSON.stringify(columns.map((c) => c.name)));
	const sql = `SELECT ${columns.map((c) => `quote(${ident(c.name)})`).join(", ")} FROM ${ident(TABLE)} ORDER BY rowid`;
	for (const row of db.prepare(sql).raw().iterate()) hash.update(`\n${JSON.stringify(row)}`);
	return hash.digest("hex");
}

// The child tables' rows by rowid and their columns that point at users, so a cascade or a lost row
// shows; no other child column (bank details among them) is read.
function childRowsFingerprint(db, children) {
	const hash = crypto.createHash("sha256");
	for (const child of children) {
		const cols = [...new Set(child.keys.filter((k) => String(k.table).toLowerCase() === TABLE).map((k) => k.from))];
		hash.update(`\n#${child.table}`);
		const sql = `SELECT rowid, ${cols.map((c) => `quote(${ident(c)})`).join(", ")} FROM ${ident(child.table)} ORDER BY rowid`;
		for (const row of db.prepare(sql).raw().iterate()) hash.update(`\n${JSON.stringify(row)}`);
	}
	return hash.digest("hex");
}

// Everything the apply compares. `children`: the child tables as read before the rebuild, so a child
// whose foreign key moved away from users is still read.
function readFacts(db, children) {
	const structure = readStructure(db);
	const violations = foreignKeyViolations(db);
	const users = !!structure.ddl;
	const seqRow = hasTable(db, "sqlite_sequence") ? db.prepare("SELECT seq, typeof(seq) AS kind FROM sqlite_sequence WHERE name = ?").get(TABLE) : null;
	return {
		structure,
		violations,
		counts: {
			rows: users ? db.prepare(`SELECT COUNT(*) AS n FROM ${ident(TABLE)}`).get().n : 0,
			highestId: users ? db.prepare(`SELECT MAX(rowid) AS id FROM ${ident(TABLE)}`).get().id : null,
			sequence: seqRow ? seqRow.seq : null,
			sequenceKind: seqRow ? seqRow.kind : null,
			sessions: hasTable(db, "sessions") ? db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n : null,
			violations: violationCounts(violations),
		},
		data: users ? {
			ids: db.prepare(`SELECT rowid FROM ${ident(TABLE)} ORDER BY rowid`).pluck().all(),
			rows: rowsFingerprint(db, structure.columns),
			childRows: childRowsFingerprint(db, children || structure.children),
		} : null,
		audits: hasTable(db, "audit_trail") ? db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = ?").get(AUDIT_ACTION).n : null,
		leftover: hasTable(db, NEW_TABLE),
	};
}

function columnSql(c, unique, roles) {
	const parts = [ident(c.name)];
	if (c.type) parts.push(c.type);
	if (c.pk) parts.push("PRIMARY KEY AUTOINCREMENT");
	if (c.notnull) parts.push("NOT NULL");
	if (c.dflt_value !== null && c.dflt_value !== undefined) parts.push(`DEFAULT ${c.dflt_value}`);
	if (unique.has(c.name)) parts.push("UNIQUE");
	if (c.name.toLowerCase() === "role") parts.push(`CHECK (${ident(c.name)} IN (${roles.map(literal).join(", ")}))`);
	return parts.join(" ");
}

// Whether this script can rebuild the table without dropping anything, and the SQL it would run. Each
// column is reproduced as PRAGMA table_info reports it; a shape it can't reproduce is a problem, so the
// dry run says so and --apply is refused before any write.
function planRebuild(db, structure, { Database = require("better-sqlite3") } = {}) {
	const { ddl, roles } = structure;
	const live = structure.columns;
	if (!ddl) return { problems: ["there is no users table"] };
	const problems = [];
	if (!roles) problems.push("its role CHECK isn't one list of quoted roles");
	const checks = (ddl.match(/\bCHECK\s*\(/gi) || []).length;
	if (checks !== 1) problems.push(`its CREATE has ${checks} CHECK constraints; this script rebuilds exactly one, on role`);
	for (const [re, what] of UNREPORTED) if (re.test(ddl)) problems.push(`its CREATE has ${what}, which PRAGMA table_info doesn't report`);
	if (!/\bAUTOINCREMENT\b/i.test(ddl)) problems.push("its id isn't AUTOINCREMENT");
	const pk = live.filter((c) => c.pk);
	if (pk.length !== 1 || !/^INTEGER$/i.test(pk[0].type)) problems.push("its primary key isn't one INTEGER column");
	if (!live.some((c) => c.name.toLowerCase() === "role")) problems.push("it has no role column");
	if (db.prepare("SELECT * FROM pragma_table_xinfo(?)").all(TABLE).some((c) => c.hidden)) problems.push("it has hidden or generated columns");
	const kind = db.prepare("SELECT wr, strict FROM pragma_table_list(?) WHERE schema = 'main'").get(TABLE);
	if (kind && (kind.wr || kind.strict)) problems.push("it is WITHOUT ROWID or STRICT");
	const indexes = constraintIndexes(db, TABLE);
	if (indexes.some((ix) => ix.origin !== "u" || ix.columns.length !== 1)) problems.push("it has a primary-key index or a UNIQUE over several columns");
	if (hasTable(db, NEW_TABLE)) problems.push(`a table named ${NEW_TABLE} already exists`);
	const elsewhere = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('view', 'trigger') AND tbl_name <> ?").all(TABLE)
		.filter((o) => /\busers\b/i.test(o.sql || ""));
	if (elsewhere.length) problems.push(`${elsewhere.length} view(s) or trigger(s) on other tables name users; this script doesn't rebuild those`);
	if (problems.length) return { problems };

	const target = [...roles, KPI_VIEWER_ROLE];
	const unique = new Set(indexes.map((ix) => ix.columns[0].name));
	const createSql = (name) => `CREATE TABLE ${ident(name)} (\n\t${live.map((c) => columnSql(c, unique, target)).join(",\n\t")}\n)`;
	// The proof before any write: made in a scratch database under the table's own name, the new CREATE
	// has the live table's columns, UNIQUE indexes and kind, and the old role list plus KPI Viewer.
	const scratch = new Database(":memory:");
	try {
		scratch.exec(createSql(TABLE));
		if (!same(columnsOf(scratch, TABLE), structure.columns)) problems.push("the new CREATE's columns don't match PRAGMA table_info");
		if (!same(constraintIndexes(scratch, TABLE), indexes)) problems.push("the new CREATE's UNIQUE indexes don't match the table's");
		if (!same(scratch.prepare("SELECT wr, strict FROM pragma_table_list(?) WHERE schema = 'main'").get(TABLE), kind)) problems.push("the new CREATE's table kind differs");
		if (!same(checkRoles(tableSql(scratch, TABLE)), target)) problems.push("the new CREATE's role list isn't the old one plus KPI Viewer");
	} catch (err) {
		problems.push(`the new CREATE doesn't run: ${err.message}`);
	} finally {
		scratch.close();
	}
	const cols = live.map((c) => ident(c.name)).join(", ");
	return {
		problems,
		target,
		createNewSql: createSql(NEW_TABLE),
		copySql: `INSERT INTO ${ident(NEW_TABLE)} (${cols}) SELECT ${cols} FROM ${ident(TABLE)}`,
		recreate: structure.attached.filter((a) => a.sql).map((a) => a.sql),
	};
}

// What a dry run reports; read-only.
function dryRunReport(db, { Database } = {}) {
	const facts = readFacts(db);
	const { structure, counts } = facts;
	const plan = structure.admits ? null : planRebuild(db, structure, Database ? { Database } : {});
	return {
		structure,
		counts,
		fingerprint: fingerprintOf(structure),
		baseline: baselineOf(counts.violations),
		nothingToDo: structure.admits,
		problems: plan ? plan.problems : [],
		createSql: plan && !plan.problems.length ? plan.createNewSql : null,
	};
}

// Each difference between the facts read before the rebuild (inside its transaction) and `post`. Columns
// are judged by PRAGMA table_info and the CHECK by its role list, never by the CREATE text, which the
// rebuild always changes.
function compareFacts(pre, post, target, db) {
	const out = [];
	if (!same(post.structure.columns, pre.structure.columns)) out.push("the columns (PRAGMA table_info) differ");
	if (!same(post.structure.roles, target)) out.push(`the CHECK's role list is ${JSON.stringify(post.structure.roles)}, not the old list plus KPI Viewer`);
	if (post.counts.rows !== pre.counts.rows) out.push(`rows ${pre.counts.rows} became ${post.counts.rows}`);
	if (!post.data || !same(post.data.ids, pre.data.ids)) out.push("the ids differ");
	if (!post.data || post.data.rows !== pre.data.rows) out.push("a row's values differ (the full-row fingerprint)");
	if (pre.counts.sequence !== null && !(post.counts.sequence >= pre.counts.sequence && post.counts.sequenceKind === pre.counts.sequenceKind)) {
		out.push(`the sequence ${pre.counts.sequence} (${pre.counts.sequenceKind}) became ${post.counts.sequence} (${post.counts.sequenceKind})`);
	}
	if (!same(post.structure.children, pre.structure.children)) out.push("the child tables' foreign keys differ");
	if (!post.data || post.data.childRows !== pre.data.childRows) out.push("the child tables' rows differ");
	if (post.counts.sessions !== pre.counts.sessions) out.push(`sessions ${pre.counts.sessions} became ${post.counts.sessions}`);
	const known = new Set(pre.violations.map(violationKey));
	const added = post.violations.filter((v) => !known.has(violationKey(v)));
	if (added.length) out.push(`${added.length} foreign-key violation(s) not there before`);
	if (!same(post.structure.attached, pre.structure.attached)) out.push("the indexes or triggers on users differ");
	if (post.leftover) out.push(`a ${NEW_TABLE} table is left`);
	const integrity = db.pragma("integrity_check(users)", { simple: true });
	if (integrity !== "ok") out.push(`the users table's integrity check says ${integrity}`);
	return out;
}

function foreignKeysOff(db) {
	db.pragma("foreign_keys = OFF");
	if (db.pragma("foreign_keys", { simple: true }) !== 0) throw new Error("foreign keys could not be turned off");
}

function rollback(db) {
	try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* the check after it reads what is there */ }
}

// AUTOINCREMENT's high-water mark: the rename leaves the copy's (the highest id copied), so the old one is
// put back and an id a deleted account had is never handed out again (audit rows and settings name ids).
// CAST: a bound JS number arrives as a REAL, and seq has no type to turn it back into an integer.
function carrySequence(db, old) {
	if (old === null || old === undefined) return;
	const updated = db.prepare("UPDATE sqlite_sequence SET seq = MAX(CAST(? AS INTEGER), seq) WHERE name = ?").run(old, TABLE).changes;
	if (updated === 0) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))").run(TABLE, old);
}

// The rebuild, on a read-write `db` with the app stopped. Returns { exit, state, reasons, step, pre,
// post, details } and never throws. `expect` and `expectFk` are what a dry run printed. `hooks`
// (beforeStep(name, db), afterCommit(db)) are the runner's way to fail a step; the command line sets none.
function applyRebuild(db, { expect, expectFk, now = () => new Date().toISOString(), Database, hooks = {} } = {}) {
	const result = (exit, state, reasons, extra = {}) => ({ exit, state, reasons, ...extra });
	let before;
	let plan;
	// Before any write: whatever fails here leaves nothing written.
	try {
		before = readFacts(db);
		if (before.structure.admits) return result(EXIT.DONE, "nothing to do", ["the users CHECK already admits KPI Viewer"], { pre: before });
		plan = planRebuild(db, before.structure, Database ? { Database } : {});
		if (plan.problems.length) return result(EXIT.REFUSED, "refused", plan.problems);
		const fingerprint = fingerprintOf(before.structure);
		if (fingerprint !== expect) return result(EXIT.REFUSED, "refused", [`the structural fingerprint is ${fingerprint}, not ${expect}: the table's structure changed since that dry run`]);
		if (before.audits === null) return result(EXIT.REFUSED, "refused", ["there is no audit_trail table to record the change in"]);
		foreignKeysOff(db);
	} catch (err) {
		try { db.pragma("foreign_keys = ON"); } catch { /* nothing was written */ }
		return result(EXIT.REFUSED, "refused", [`before any write: ${err.message}`]);
	}

	let step = "begin";
	let pre;
	let details = "";
	let failure = null;
	const at = (name) => {
		step = name;
		if (typeof hooks.beforeStep === "function") hooks.beforeStep(name, db);
	};
	try {
		db.exec("BEGIN IMMEDIATE");
		at("read");
		pre = readFacts(db, before.structure.children);
		if (pre.structure.admits) throw new Outcome(EXIT.DONE, "nothing to do", ["the users CHECK already admits KPI Viewer"]);
		if (fingerprintOf(pre.structure) !== expect) throw new Outcome(EXIT.REFUSED, "refused", ["the structural fingerprint changed before the transaction began"]);
		const baseline = baselineOf(pre.counts.violations);
		if (baseline !== expectFk) throw new Outcome(EXIT.REFUSED, "refused", [`the foreign-key baseline is ${baseline}, not ${expectFk}: the violations already present changed since that dry run`]);
		at("create");
		db.exec(plan.createNewSql);
		if (!same(columnsOf(db, NEW_TABLE), pre.structure.columns) || !same(constraintIndexes(db, NEW_TABLE), constraintIndexes(db, TABLE))) {
			throw new Error(`${NEW_TABLE} doesn't have the columns and UNIQUE indexes of users`);
		}
		at("copy");
		const copied = db.prepare(plan.copySql).run().changes;
		if (copied !== pre.counts.rows) throw new Error(`copied ${copied} rows, not ${pre.counts.rows}`);
		at("drop");
		db.exec(`DROP TABLE ${ident(TABLE)}`);
		at("rename");
		db.exec(`ALTER TABLE ${ident(NEW_TABLE)} RENAME TO ${ident(TABLE)}`);
		at("recreate");
		for (const sql of plan.recreate) db.exec(sql);
		at("sequence");
		carrySequence(db, pre.counts.sequence);
		at("fkcheck");
		const added = addedViolations(db, pre.violations);
		if (added.length) throw new Error(`the foreign-key check found ${added.length} violation(s) the rebuild would add`);
		at("verify");
		const inside = readFacts(db, pre.structure.children);
		const differences = compareFacts(pre, inside, plan.target, db);
		if (differences.length) throw new Error(`before the commit: ${differences.join("; ")}`);
		at("audit");
		details = `users rebuilt so its role CHECK admits "${KPI_VIEWER_ROLE}": rows ${pre.counts.rows} → ${inside.counts.rows}; `
			+ `highest id ${pre.counts.highestId} → ${inside.counts.highestId}; sequence ${pre.counts.sequence} → ${inside.counts.sequence}`;
		db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, ?, '', ?)")
			.run(now(), ACTOR, AUDIT_ACTION, TABLE, details);
		at("commit");
		db.exec("COMMIT");
	} catch (err) {
		rollback(db);
		failure = err;
	} finally {
		db.pragma("foreign_keys = ON");
	}

	if (failure instanceof Outcome) return result(failure.exit, failure.state, failure.reasons, { pre });
	if (failure) {
		// Rolled back: the table, its rows, the sequence and the sessions must read exactly as before.
		try {
			const base = pre || before;
			const after = readFacts(db, base.structure.children);
			const unchanged = fingerprintOf(after.structure) === fingerprintOf(base.structure) && same(after.counts, base.counts)
				&& same(after.data, base.data) && after.audits === base.audits && !after.leftover;
			if (unchanged) return result(EXIT.ROLLED_BACK, "rolled back", [`at step ${step}: ${failure.message}`], { step, pre: base, post: after });
			return result(EXIT.DIFFERS, "differs after a failed step", [`at step ${step}: ${failure.message}`, "the table doesn't read as it did before"], { step, pre: base, post: after });
		} catch (err) {
			return result(EXIT.DIFFERS, "differs after a failed step", [`at step ${step}: ${failure.message}`, `the check after the rollback failed: ${err.message}`], { step });
		}
	}

	// Committed: the after-facts, read again and checked against the facts read before the rebuild.
	try {
		if (typeof hooks.afterCommit === "function") hooks.afterCommit(db);
		const post = readFacts(db, pre.structure.children);
		const differences = compareFacts(pre, post, plan.target, db);
		if (post.audits !== pre.audits + 1) differences.push(`${post.audits - pre.audits} audit row(s) written, not 1`);
		if (differences.length) return result(EXIT.DIFFERS, "committed but differs", differences, { pre, post, details });
		return result(EXIT.DONE, "applied", [], { pre, post, details });
	} catch (err) {
		return result(EXIT.DIFFERS, "committed but differs", [`the after-check failed to run: ${err.message}`], { pre, details });
	}
}

// The start-up check: with the flag on, does the users CHECK admit the role? One line either way, and
// an error naming the script when it doesn't (or can't be read). With the flag off nothing is read.
function kpiViewerBootCheck(db, { enabled, log = console } = {}) {
	if (enabled !== true) {
		log.log("[kpi-viewer] off (KPI_VIEWER_ENABLED)");
		return false;
	}
	let roles = null;
	try { roles = checkRoles(tableSql(db, TABLE)); } catch { roles = null; }
	if (Array.isArray(roles) && roles.includes(KPI_VIEWER_ROLE)) {
		log.log("[kpi-viewer] on; users CHECK admits KPI Viewer: yes");
		return true;
	}
	log.error(`[kpi-viewer] on; users CHECK admits KPI Viewer: no. The role stays closed until ${MIGRATION_SCRIPT} has run (its dry run first).`);
	return false;
}

module.exports = {
	KPI_VIEWER_ROLE, MIGRATION_SCRIPT, TABLE, NEW_TABLE, ACTOR, AUDIT_ACTION, EXIT, STEPS,
	kpiViewerEnabled, kpiViewerBootCheck, checkRoles, readStructure, readFacts, fingerprintOf, baselineOf,
	planRebuild, dryRunReport, applyRebuild,
};
