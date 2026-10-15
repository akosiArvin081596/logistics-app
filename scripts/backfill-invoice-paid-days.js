#!/usr/bin/env node
// scripts/backfill-invoice-paid-days.js — fills invoice_paid_days (the days each
// invoice pays a daily-rate driver, B12) from the live invoices, before
// TRIP_WORK_DAYS_ENABLED takes effect. It runs the server's own
// backfillInvoicePaidDays(), lifted from this checkout's server.js
// (scripts/lib/ledger-world.js), on the app's database:
//   - one row per paid day of every live invoice (not soft-deleted; Rejected
//     included, since a Rejected invoice can be reverted): a weekly invoice's
//     Saturday-Friday day grid, and a manual invoice's paidDays (work-day
//     corrections, manual invoices created with `days`). Other manual invoices
//     name no day and are skipped;
//   - idempotent: a day already recorded for its invoice is skipped, so a second
//     run writes nothing;
//   - a day another live invoice already holds is a conflict: listed, skipped,
//     never overwritten (a person decides);
//   - one audit_trail row, a system change, with the counts (not on a dry run).
// It never touches an invoice, a payout, a lock or a frozen item. The server
// runs the same function at every start while the rule is on.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/backfill-invoice-paid-days.js --db=app.db --dry-run
//   node scripts/backfill-invoice-paid-days.js --db=app.db
//   --db=<file>        the app's own app.db or a copy under the temp directory
//                      (scripts/lib/ledger-world.js dbScope())
//   --env-file=<file>  with a copy only: the settings to read
//   --dry-run          open the database read-only, print the rows it would
//                      write, write nothing
//   --names            name the drivers (default: "driver 1", "driver 2", …)
//   --json             print the result as JSON
// Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { buildLedgerWorld, parseArgs, envFor } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function hasTable(dbFile, name) {
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		return !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
	} finally {
		probe.close();
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db || args.db === true) refuse("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	const dryRun = args["dry-run"] === true;
	let dbFile;
	try {
		dbFile = envFor({ root: ROOT, dbPath: args.db, envFile }).file;
	} catch (err) {
		refuse(err.message);
	}
	for (const t of ["invoices", "invoice_paid_days"]) {
		if (!hasTable(dbFile, t)) refuse(`the database has no ${t} table (it appears once the server with this change has started)`);
	}
	const world = buildLedgerWorld({
		root: ROOT, dbPath: args.db, readonly: dryRun, sheetData: { values: [] }, envFile,
		extraRoots: ["backfillInvoicePaidDays"],
	});
	try {
		const result = world.api.backfillInvoicePaidDays({ write: !dryRun });
		if (!dryRun && result.rows.length) {
			world.api.logAudit({ session: { user: { id: 0, username: "system: paid-days backfill script", role: "system" } } },
				"backfill_invoice_paid_days", "invoice_paid_days", "",
				`recorded ${result.rows.length} paid day(s) from ${new Set(result.rows.map((r) => r.invoiceId)).size} live invoice(s); ${result.conflicts.length} conflict(s) skipped`);
		}
		const labels = new Map();
		const who = (n) => {
			if (args.names === true) return n;
			if (!labels.has(n)) labels.set(n, `driver ${labels.size + 1}`);
			return labels.get(n);
		};
		const out = {
			dryRun,
			rows: result.rows.map((r) => ({ driver: who(r.driverNorm), day: r.day, invoiceNumber: r.invoiceNumber, status: r.status })),
			conflicts: result.conflicts.map((c) => ({ driver: who(c.driverNorm), day: c.day, invoiceNumber: c.invoiceNumber, heldBy: c.heldByNumber })),
		};
		if (args.json === true) {
			console.log(JSON.stringify(out, null, 1));
			return;
		}
		console.log(`invoice_paid_days backfill${dryRun ? " (dry run: nothing written)" : ""}: ${out.rows.length} row(s) ${dryRun ? "to write" : "written"}, ${out.conflicts.length} conflict(s) skipped.`);
		for (const r of out.rows) console.log(`  ${r.day}  ${r.invoiceNumber}  ${r.status}  ${r.driver}`);
		for (const c of out.conflicts) console.log(`  CONFLICT ${c.day}  ${c.invoiceNumber} (already held by ${c.heldBy})  ${c.driver}`);
	} finally {
		world.db.close();
	}
}

try {
	main();
} catch (err) {
	console.error(`ERROR: ${err.stack || err.message}`);
	process.exit(1);
}
