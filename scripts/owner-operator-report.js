#!/usr/bin/env node
// scripts/owner-operator-report.js — the read-only counts to run on production data
// before each owner-operator switch-on: the new tables and columns, applications that
// already read "Owner Operator", the percentage pay type and template, numbering
// collisions, and fingerprints that must not move across a deploy. Counts, statuses
// and hashes only: never a name, a VIN, a plate or one person's amount.
//
//   node scripts/owner-operator-report.js --db=<app.db> [--json]
//
// --db is required: there is no default database. It is the app directory's own
// app.db or a copy under the temp directory (scripts/lib/ledger-world.js dbScope()),
// opened read-only. Flag states come from the app's "[owner-operator]" start-up
// line, never from the settings file. Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseArgs, openDb, dbScope } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const ownerOperator = require("../lib/owner-operator");

const ROOT = path.join(__dirname, "..");
const DENIED = ["db", "app", "io", "server", "sheets", "getSheets", "getDrive", "sendEmail", "transporter", "fetch"];

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// The server's own total due and pay basis, lifted from this checkout's server.js.
function serverRules() {
	const lifted = closure(serverSource({ root: ROOT }), { roots: ["invoiceTotalDue", "invoicePayBasis"], provided: [], denied: DENIED });
	return new Function(`"use strict";\n${lifted.text}\nreturn { invoiceTotalDue, invoicePayBasis };`)();
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

function buildReport(db, scope) {
	const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
	const columns = (t) => (tableExists(t) ? new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name)) : new Set());
	const count = (sql, ...params) => db.prepare(sql).get(...params).n;
	const rules = serverRules();

	const tables = {};
	for (const t of ownerOperator.OO_TABLES) {
		const present = tableExists(t);
		tables[t] = { present, rows: present ? count(`SELECT COUNT(*) AS n FROM "${t}"`) : 0 };
	}
	const expenseCols = columns("expenses");
	const expenseColumns = {
		filed_by_role: { present: expenseCols.has("filed_by_role"), stamped: expenseCols.has("filed_by_role") ? count("SELECT COUNT(*) AS n FROM expenses WHERE COALESCE(filed_by_role, '') <> ''") : 0 },
		filed_by_user_id: { present: expenseCols.has("filed_by_user_id"), stamped: expenseCols.has("filed_by_user_id") ? count("SELECT COUNT(*) AS n FROM expenses WHERE filed_by_user_id IS NOT NULL") : 0 },
	};

	// Applications already reading "Owner Operator": accepted ones are company drivers and stay so.
	const applications = { live: {}, deleted: 0 };
	const appCols = columns("job_applications");
	if (appCols.has("position")) {
		const deletedSql = appCols.has("deleted_at") ? "deleted_at" : "NULL";
		const statusSql = appCols.has("status") ? "status" : "''";
		const live = {};
		for (const row of db.prepare(`SELECT position, ${statusSql} AS status, ${deletedSql} AS deleted_at FROM job_applications`).all()) {
			if (!ownerOperator.ooIsOwnerOperatorPosition(row.position)) continue;
			if (row.deleted_at) { applications.deleted++; continue; }
			const status = String(row.status || "(none)");
			live[status] = (live[status] || 0) + 1;
		}
		for (const status of Object.keys(live).sort()) applications.live[status] = live[status];
	}

	const percentageDrivers = columns("drivers_directory").has("pay_type") ? count("SELECT COUNT(*) AS n FROM drivers_directory WHERE pay_type = 'percentage'") : null;

	// Every live invoice's total due, read as the server reads it; a column an older
	// database lacks reads as nothing on it.
	const percentageInvoices = { live: 0, deleted: 0 };
	const liveInvoices = { count: 0, totalDueCents: 0, sha256: sha256("") };
	let invoicesNumberedS = 0;
	const invCols = columns("invoices");
	if (invCols.size) {
		const col = (name, fallback) => (invCols.has(name) ? name : `${fallback} AS ${name}`);
		const select = ["id", col("status", "''"), col("total_earnings", "0"), col("adjustment", "0"), col("personal_total", "0"), col("personal_share_total", "0"),
			col("correction_lines_total", "0"), col("is_manual", "0"), col("render_data", "'{}'"), col("deleted_at", "''")].join(", ");
		const lines = [];
		for (const row of db.prepare(`SELECT ${select} FROM invoices ORDER BY id`).all()) {
			const deleted = !!row.deleted_at;
			if (rules.invoicePayBasis(row) === "percentage") percentageInvoices[deleted ? "deleted" : "live"]++;
			if (deleted) continue;
			const cents = Math.round(rules.invoiceTotalDue(row) * 100);
			liveInvoices.count++;
			liveInvoices.totalDueCents += cents;
			lines.push(`${row.id}:${row.status}:${cents}`);
		}
		liveInvoices.sha256 = sha256(lines.join("\n"));
		invoicesNumberedS = invCols.has("invoice_number") ? count("SELECT COUNT(*) AS n FROM invoices WHERE invoice_number LIKE ?", "INV-S-%") : 0;
	}
	const trucksNumberedOO = columns("trucks").has("unit_number") ? count("SELECT COUNT(*) AS n FROM trucks WHERE unit_number LIKE ?", "OO-%") : 0;

	// The closed months' frozen books: they never change, so this hash never moves.
	const periods = tableExists("period_locks") ? db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period) : [];
	const frozen = (table, order) => {
		if (!periods.length || !tableExists(table)) return [];
		return db.prepare(`SELECT * FROM "${table}" WHERE period IN (${periods.map(() => "?").join(", ")}) ORDER BY ${order}`).all(...periods);
	};
	const items = frozen("financials_ledger_items", "id");
	const freezes = frozen("financials_ledger_freezes", "freeze_id");
	const closedMonths = { periods: periods.length, items: items.length, freezes: freezes.length, sha256: sha256(JSON.stringify({ periods, items, freezes })) };

	return {
		database: scope,
		tables,
		expenseColumns,
		applications,
		percentageDrivers,
		percentageInvoices,
		collisions: { invoicesNumberedS, trucksNumberedOO },
		fingerprints: { liveInvoices, closedMonths },
		flags: "read the \"[owner-operator]\" start-up line in the app's log; this report never reads the settings file",
	};
}

function text(r) {
	const table = (name, t) => `   ${name} ${t.present ? `present, ${t.rows} row(s)` : "absent"}`;
	const column = (name, c, word) => `${name}: ${c.present ? `present, ${c.stamped} ${word}` : "absent"}`;
	const live = Object.entries(r.applications.live).map(([s, n]) => `${s} ${n}`).join(", ") || "none";
	const fp = r.fingerprints;
	return [
		"Owner-operators: what is in place before a switch-on (read-only; counts, statuses and hashes only)",
		`database: ${r.database === "app" ? "the app's own" : "a copy"}`,
		"",
		"1. The new tables:",
		...Object.entries(r.tables).map(([name, t]) => table(name, t)),
		`   ${column("expenses.filed_by_role", r.expenseColumns.filed_by_role, "stamped")}; ${column("expenses.filed_by_user_id", r.expenseColumns.filed_by_user_id, "set")}`,
		`2. Applications whose position reads "Owner Operator": live by status: ${live} (an accepted one is a company driver and stays so); deleted: ${r.applications.deleted}`,
		`3. Drivers on the percentage pay type (drivers_directory.pay_type 'percentage'): ${r.percentageDrivers === null ? "no pay_type column" : r.percentageDrivers}`,
		`4. Invoices on the percentage template: ${r.percentageInvoices.live} live, ${r.percentageInvoices.deleted} deleted`,
		`5. Numbering collisions (expect 0): invoices numbered INV-S-: ${r.collisions.invoicesNumberedS}; trucks numbered OO-: ${r.collisions.trucksNumberedOO}`,
		"6. Fingerprints (the same before and after a deploy):",
		`   live invoices: ${fp.liveInvoices.count}, total due ${usd(fp.liveInvoices.totalDueCents)}, sha256 ${fp.liveInvoices.sha256}`,
		`   closed months' frozen books: ${fp.closedMonths.periods} month(s), ${fp.closedMonths.items} item(s), ${fp.closedMonths.freezes} freeze(s), sha256 ${fp.closedMonths.sha256}`,
		`7. Flag states: ${r.flags}`,
	].join("\n");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.db !== "string" || !args.db.trim()) refuse("--db=<path to app.db> is required; there is no default database");
	let scope;
	try {
		scope = dbScope(args.db.trim(), ROOT);
	} catch (err) {
		refuse(err.message);
	}
	if (!fs.existsSync(scope.file)) refuse(`${args.db.trim()} does not exist`);
	const db = openDb({ root: ROOT, dbFile: scope.file, readonly: true });
	try {
		const report = buildReport(db, scope.scope);
		console.log(args.json === true ? JSON.stringify(report, null, 2) : text(report));
	} finally {
		db.close();
	}
}

try {
	main();
} catch (err) {
	console.error(`ERROR: ${err.message}`);
	process.exit(1);
}
