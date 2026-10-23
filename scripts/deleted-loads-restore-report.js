#!/usr/bin/env node
// scripts/deleted-loads-restore-report.js — the read-only "what would change"
// list before RESTORE_DELETED_LOADS_ENABLED goes on (the restore plan of
// 2026-10-22, Revision 2, section 8). It lifts the server's own
// restorePlanFor() from this checkout's server.js (scripts/lib/ledger-world.js),
// the function GET /api/admin/deleted-loads/:id/restore-preview answers with, on
// a read-only handle of app.db, and writes nothing.
//
// For every deleted_loads row, oldest first:
//   - its key and the Load ID its sheet row carries;
//   - the months the sheet row books (closed, or past and not yet closed:
//     "pending") and the months its delete record names;
//   - whether a restore would be refused, with the code and the message;
//   - for a restorable one: the row that would come back, its invoice lines
//     (each pay week's invoice and what a person would do), its possible
//     duplicates, and its full payout-ledger difference: every investor-month,
//     company month and fleet month that moves, before and after, payable after
//     loss carry-forward, later open months included.
// The same function as the preview, so the report and the preview cannot
// disagree. Write-free (the plan's M2): the run refuses if the lifted code
// reaches reconcileInvestorPayouts(), which writes payouts.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/deleted-loads-restore-report.js --db=app.db --sheet-id=<id> [--key=service-account-key.json] [--json]
//   --sheet-id=env         the SPREADSHEET_ID the .env sets (refused when none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --now=<ISO instant>    answer as of that instant (a rehearsal or a test);
//                          default: now
//   --json                 print the whole result as JSON (default: a text report
//                          naming owners by id, never drivers or investors)
//   --dry-run              accepted; the run is always read-only
// Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const path = require("path");
const { buildLedgerWorld, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(Number(x) || 0).toFixed(2)}`;
const signed = (x) => `${x > 0 ? "+" : ""}${usd(x)}`;

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function monthText(m) {
	return `${m.month} ${m.closed ? "closed" : m.pending ? "open (past, not yet closed)" : "open"}`;
}

function printText(r) {
	const lines = [];
	lines.push(`Restore deleted loads: what would change, as of ${r.asOf}. Read-only: nothing was written.`);
	lines.push(`${r.summary.rows} deleted row(s); ${r.summary.restorable} restorable, ${r.summary.refused} refused (${Object.entries(r.summary.refusedBy).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}).`);
	for (const l of r.loads) {
		lines.push("");
		lines.push(`#${l.id}  ${l.label} (key ${l.key}): ${l.canRestore ? "RESTORABLE" : `REFUSED ${l.refusal.code}: ${l.refusal.error}`}`);
		lines.push(`  months: ${l.months.map(monthText).join("; ") || "none"}; delete record: ${l.deleteRecordMonths.map((m) => `${m.month} ${m.closed ? "closed" : "open"}`).join("; ") || "none"}`);
		lines.push(`  delete rows: ${l.deleteRecords.map((d) => `#${d.id} (${d.deletedAt || "no time"})`).join(", ")}`);
		if (l.row) {
			lines.push(`  row: sheet row ${l.row.rowIndex}${l.row.rowMoved ? ` (the deleted row was ${l.row.storedRowIndex})` : ""}, status ${l.row.status || "(blank)"}, payment ${l.row.payment || "(blank)"}${l.row.cancelled ? ", Cancelled: stays out of every figure" : ""}`);
		}
		if (!l.canRestore) continue;
		if (l.revenue) lines.push(`  revenue: ${signed(l.revenue.amount)} in ${l.revenue.month}`);
		for (const i of l.invoices) lines.push(`  invoice: ${i.note}`);
		for (const d of l.possibleDuplicates) lines.push(`  possible duplicate: ${d.loadId} (${d.reasons.join("; ")})`);
		if (l.inFlight) lines.push(`  in flight: ${l.inFlight.note}`);
		for (const s of l.ledger.scopes) {
			lines.push(`  ledger owner ${s.ownerId} ${s.month}: revenue ${signed(s.revenue.change)}, driver pay ${signed(s.driverPay.change)}, result ${signed(s.raw.change)}${s.payable ? `, payable ${usd(s.payable.before)} -> ${usd(s.payable.after)}` : ""}`);
		}
		for (const f of l.ledger.fleet) {
			lines.push(`  fleet ${f.month}: revenue ${usd(f.revenue.before)} -> ${usd(f.revenue.after)}, driver pay ${usd(f.driverPay.before)} -> ${usd(f.driverPay.after)}, result ${usd(f.raw.before)} -> ${usd(f.raw.after)}`);
		}
		for (const d of l.ledger.dayOnce.added) lines.push(`  day-once: owner ${d.ownerId} ${d.day} leaves ${d.month} (load ${d.loadId}) for ${d.keptMonth} (load ${d.keptLoadId})`);
		for (const d of l.ledger.dayOnce.removed) lines.push(`  day-once: owner ${d.ownerId} ${d.day} returns to ${d.month} (load ${d.loadId}) from ${d.keptMonth}`);
	}
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db || args.db === true) refuse("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	try {
		envFor({ root: ROOT, dbPath: args.db, envFile });
	} catch (err) {
		refuse(err.message);
	}
	let now = null;
	if (args.now !== undefined) {
		now = typeof args.now === "string" ? Date.parse(args.now) : NaN;
		if (!Number.isFinite(now)) refuse("--now must be an ISO instant, e.g. 2026-11-15T17:00:00Z");
	}
	const sheetData = await sheetFor(args, ROOT);
	const world = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, now, extraRoots: ["restorePlanFor", "restorePreviewBody"] });
	try {
		if (world.liftedNames.includes("reconcileInvestorPayouts")) refuse("the restore preview reaches reconcileInvestorPayouts(), which writes payouts; nothing was run");
		if (typeof world.api.restorePlanFor !== "function") refuse("this checkout's server.js has no restorePlanFor()");
		// One sheet read for every load, as the preview reads one per request.
		const jobTracking = await world.api.getJobTrackingCached();
		const loads = [];
		for (const { id } of world.db.prepare("SELECT id FROM deleted_loads ORDER BY id").all()) {
			const plan = await world.api.restorePlanFor(id, { jobTracking });
			if (plan.unreadable) throw new Error("deleted_loads could not be read");
			if (plan.notFound) continue;
			loads.push(world.api.restorePreviewBody(plan));
		}
		const refusedBy = {};
		for (const l of loads) if (!l.canRestore) refusedBy[l.refusal.code] = (refusedBy[l.refusal.code] || 0) + 1;
		const result = {
			asOf: new Date(now === null ? Date.now() : now).toISOString(),
			summary: { rows: loads.length, restorable: loads.filter((l) => l.canRestore).length, refused: loads.filter((l) => !l.canRestore).length, refusedBy },
			loads,
		};
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
	} finally {
		world.db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
