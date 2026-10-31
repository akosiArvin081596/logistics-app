#!/usr/bin/env node
// scripts/migrate-users-kpi-viewer-role.js: rebuilds the users table so its role CHECK admits "KPI Viewer"
// (the steps are in lib/users-role-migration.js). Every column, row and id, the id sequence, the child
// tables' foreign keys and every session are kept; one system audit row records the change.
//
// A dry run by default: it opens the database read-only, writes nothing and prints the table's structure
// (the live CREATE, PRAGMA table_info, the child tables' foreign keys, the CHECK's role list), the counts
// (rows, highest id, sequence, sessions, the foreign-key violations already there, by table), the CREATE
// it would run, the structural fingerprint and the foreign-key baseline. The counts move with normal use,
// so the fingerprint leaves them out.
//
// Usage (on the server, from the app directory; --apply with the app stopped and a backup taken):
//   node scripts/migrate-users-kpi-viewer-role.js [--db <file>]
//   node scripts/migrate-users-kpi-viewer-role.js --apply --expect=<fingerprint> --expect-fk=<baseline> [--db <file>]
//   --db  default: the app's own database as scripts/lib/app-database.js resolves it (DATABASE_PATH, else
//         the app's settings, else app.db), refused while LOCAL_REPLICA is set; another file must be a
//         copy outside this repository and outside any app directory. The file opened is printed first;
//         a backup before --apply is of that file.
// --apply is refused, with nothing written, unless KPI_VIEWER_ENABLED is "true" in the settings the app
// runs with (this environment, else the app directory's settings file; it prints on or off, never the
// value), and unless both values match what it reads inside its transaction. A CHECK that already admits
// the role is left alone ("nothing to do").
//
// Exit codes: 0 applied, nothing to do, or a dry run; 2 refused or failed before any write, nothing
// written; 3 rolled back, the table as it was; 4 committed but an after-fact differs. Any other exit
// (1, a crash, a kill) leaves the outcome unknown: handle it like 4. On 4, keep the app stopped and
// restore the backup taken after the stop the WAL way: move <db>-wal and <db>-shm aside, unzip and verify
// the backup, put it in place, then compare a fresh dry run's structure and counts with the one before.
//
// Required as a module (by its runner) it runs nothing and exports main().

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { parseArgs } = require("./lib/ledger-world");
const { resolveDatabase, DatabaseRefusal } = require("./lib/app-database");
const migration = require("../lib/users-role-migration");

const ROOT = path.join(__dirname, "..");
const { EXIT } = migration;
const OPTIONS = ["db", "apply", "dry-run", "expect", "expect-fk", "help"];
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
const BASELINE_RE = /^fk-(?:none|[0-9a-f]{12})$/;
const USAGE = [
	"node scripts/migrate-users-kpi-viewer-role.js [--db <file>]                      (dry run, read-only)",
	"node scripts/migrate-users-kpi-viewer-role.js --apply --expect=<fingerprint> --expect-fk=<baseline> [--db <file>]",
	"Exit: 0 done or dry run; 2 refused, nothing written; 3 rolled back; 4 committed but differs; any other: treat like 4.",
].join("\n");

class Refusal extends Error {}

function readOptions(argv) {
	for (const a of argv) {
		if (!a.startsWith("--")) continue;
		const name = a.slice(2).split("=")[0];
		if (!OPTIONS.includes(name)) throw new Refusal(`unknown option --${name}`);
	}
	const args = parseArgs(argv);
	const flag = (n) => {
		if (args[n] !== undefined && args[n] !== true) throw new Refusal(`--${n} takes no value`);
		return args[n] === true;
	};
	const text = (n) => {
		if (args[n] === undefined) return null;
		if (typeof args[n] !== "string" || !args[n].trim()) throw new Refusal(`--${n} needs a value`);
		return args[n].trim();
	};
	const opts = { apply: flag("apply"), dryRun: flag("dry-run"), help: flag("help"), db: text("db"), expect: text("expect"), expectFk: text("expect-fk") };
	if (opts.apply && opts.dryRun) throw new Refusal("--apply and --dry-run together");
	if (opts.apply) {
		if (!opts.expect || !FINGERPRINT_RE.test(opts.expect)) throw new Refusal("--apply needs --expect=<the structural fingerprint a dry run printed>");
		if (!opts.expectFk || !BASELINE_RE.test(opts.expectFk)) throw new Refusal("--apply needs --expect-fk=<the foreign-key baseline a dry run printed>");
	} else if (opts.expect || opts.expectFk) {
		throw new Refusal("--expect and --expect-fk go with --apply");
	}
	return opts;
}

// The app directory's settings, parsed as dotenv parses them and never loaded into this process.
function appSettings(root) {
	const file = path.join(root, ".env");
	return fs.existsSync(file) ? createRequire(path.join(root, "server.js"))("dotenv").parse(fs.readFileSync(file)) : {};
}

// KPI_VIEWER_ENABLED as the app reads it: a value in the environment wins (dotenv leaves it alone), else
// the settings file's.
function flagOn(env, readSettings) {
	const inEnv = Object.prototype.hasOwnProperty.call(env, "KPI_VIEWER_ENABLED");
	return migration.kpiViewerEnabled({ env: inEnv ? env : readSettings() });
}

function describeStructure(r, log) {
	const s = r.structure;
	log.log("Structure (in the fingerprint):");
	log.log(`  users CREATE (live): ${s.ddl === null ? "(no users table)" : s.ddl.replace(/\s+/g, " ")}`);
	log.log(`  columns (PRAGMA table_info): ${s.columns.length}`);
	for (const c of s.columns) {
		const bits = [c.type || "(no type)", c.pk ? "PRIMARY KEY" : "", c.notnull ? "NOT NULL" : "", c.dflt_value !== null ? `DEFAULT ${c.dflt_value}` : ""].filter(Boolean);
		log.log(`    ${c.cid} ${c.name} ${bits.join(" ")}`);
	}
	log.log(`  role CHECK: ${s.roles ? s.roles.map((x) => `'${x}'`).join(", ") : "(not readable)"}; admits KPI Viewer: ${s.admits ? "yes" : "no"}`);
	log.log(`  child tables' foreign keys to users: ${s.children.length}`);
	for (const child of s.children) {
		for (const k of child.keys) log.log(`    ${child.table}(${k.from}) -> ${k.table}(${k.to === null ? "" : k.to}) ON UPDATE ${k.on_update} ON DELETE ${k.on_delete}`);
	}
	log.log(`  indexes and triggers on users: ${s.attached.map((a) => `${a.type} ${a.name}`).join(", ") || "none"}`);
	const c = r.counts;
	log.log("Counts (information only, not in the fingerprint):");
	log.log(`  rows ${c.rows}; highest id ${c.highestId}; sqlite_sequence ${c.sequence}; sessions ${c.sessions === null ? "(no sessions table)" : c.sessions}`);
	log.log(`  foreign-key violations already there: ${c.violations.map((v) => `${v.table} ${v.count}`).join(", ") || "none"}`);
}

function dryRun(db, { Database, log, file, dbArg }) {
	const r = migration.dryRunReport(db, { Database });
	describeStructure(r, log);
	if (r.nothingToDo) {
		log.log(`Structural fingerprint: ${r.fingerprint}`);
		log.log("NOTHING TO DO: the users CHECK already admits KPI Viewer. Nothing written.");
		return EXIT.DONE;
	}
	if (r.problems.length) {
		log.error(`REFUSED: this script can't rebuild this users table without dropping something: ${r.problems.join("; ")}. Nothing written.`);
		return EXIT.REFUSED;
	}
	log.log("Would create (then copy, drop users, rename, carry the sequence):");
	for (const line of r.createSql.split("\n")) log.log(`  ${line}`);
	log.log(`Structural fingerprint: ${r.fingerprint}`);
	log.log(`Foreign-key baseline: ${r.baseline}`);
	log.log(`DRY RUN: nothing written. To apply, with the app stopped and a backup of ${file} taken after the stop:`);
	log.log(`  node scripts/migrate-users-kpi-viewer-role.js --apply --expect=${r.fingerprint} --expect-fk=${r.baseline}${dbArg}`);
	return EXIT.DONE;
}

function report(r, log, file) {
	const restore = `Keep the app stopped and restore the backup taken after the stop: move ${file}-wal and ${file}-shm aside, `
		+ `unzip and verify the backup, put it in place as ${file}, then compare a fresh dry run's structure and counts with the one taken before the apply.`;
	if (r.exit === EXIT.DONE && r.state === "applied") {
		log.log(`APPLIED: ${r.details}; sessions ${r.post.counts.sessions}; one audit row.`);
		log.log("After-facts: the columns (PRAGMA table_info), the rows, ids and every value, the child tables' foreign keys and rows, and the sessions are as before; the role list is the old one plus KPI Viewer; no new foreign-key violation.");
	} else if (r.exit === EXIT.DONE) {
		log.log("NOTHING TO DO: the users CHECK already admits KPI Viewer. Nothing written.");
	} else if (r.exit === EXIT.REFUSED) {
		log.error(`REFUSED: ${r.reasons.join("; ")}. Nothing written.`);
	} else if (r.exit === EXIT.ROLLED_BACK) {
		log.error(`ROLLED BACK: ${r.reasons.join("; ")}. The table, its rows, the sequence and the sessions read as before (structure ${migration.fingerprintOf(r.post.structure)}).`);
	} else {
		log.error(`COMMITTED BUT DIFFERS (${r.state}): ${r.reasons.join("; ")}. ${restore}`);
	}
}

// Returns the exit code. `env`, `root`, `readSettings`, `log` and `hooks` are for the runner.
function main(argv = process.argv.slice(2), { env = process.env, root = ROOT, readSettings = null, log = console, hooks } = {}) {
	let opts;
	let target;
	let on;
	try {
		opts = readOptions(argv);
		if (opts.help) { log.log(USAGE); return EXIT.DONE; }
		try { target = resolveDatabase(opts.db, root, { env }); } catch (err) {
			if (err instanceof DatabaseRefusal) throw new Refusal(err.message);
			throw err;
		}
		on = flagOn(env, readSettings || (() => appSettings(root)));
		if (opts.apply && !on) throw new Refusal("KPI_VIEWER_ENABLED is off in the settings the app runs with; --apply writes only while it is on");
	} catch (err) {
		log.error(`REFUSED: ${err instanceof Refusal ? err.message : `before any write: ${err.message}`}. Nothing written.`);
		return EXIT.REFUSED;
	}
	let db;
	const Database = createRequire(path.join(root, "server.js"))("better-sqlite3");
	try {
		db = new Database(target.file, { readonly: !opts.apply, fileMustExist: true });
		if (!opts.apply && !db.readonly) throw new Error("the dry run's SQLite handle is not read-only");
		db.pragma("busy_timeout = 10000");
	} catch (err) {
		if (db) db.close();
		log.error(`REFUSED: before any write: ${err.message}. Nothing written.`);
		return EXIT.REFUSED;
	}
	try {
		log.log(`Database: ${target.file} (${target.scope === "app" ? "the app's own" : "a copy"}), opened ${db.readonly ? "read-only" : "read-write"}`);
		log.log(`KPI_VIEWER_ENABLED: ${on ? "on" : "off"}${!opts.apply && !on ? " (an --apply is refused while it is off)" : ""}`);
		if (!opts.apply) {
			try {
				const shown = /^[\w./-]+$/.test(target.file) ? target.file : `'${target.file.replace(/'/g, "'\\''")}'`;
				return dryRun(db, { Database, log, file: target.file, dbArg: opts.db ? ` --db ${shown}` : "" });
			} catch (err) {
				log.error(`REFUSED: the dry run failed: ${err.message}. Nothing written.`);
				return EXIT.REFUSED;
			}
		}
		const r = migration.applyRebuild(db, { expect: opts.expect, expectFk: opts.expectFk, Database, hooks });
		report(r, log, target.file);
		return r.exit;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	let code;
	try {
		code = main();
	} catch (err) {
		console.error(`ERROR: ${err.stack || err.message}. The outcome is unknown: handle this exit like 4.`);
		code = 1;
	}
	process.exit(code);
}

module.exports = { main, readOptions, flagOn, USAGE };
