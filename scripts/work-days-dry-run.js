#!/usr/bin/env node
// scripts/work-days-dry-run.js — what the trip work-day rule (B12;
// TRIP_WORK_DAYS_ENABLED and TRIP_WORK_DAYS_FROM, lib/trip-work-days.js) would
// change, run on the server with no login before the flag goes on. It lifts
// the server's own workDaysDryRun() from this checkout's server.js
// (scripts/lib/ledger-world.js), the function GET /api/admin/work-days/dry-run
// returns, on a read-only handle of app.db, and writes nothing.
//
// It compares the rule off (today) with the rule on from --from, every other
// setting as the app's .env has it, and reports:
//   - perDay: each driver-day the payout ledger pays differently, with its
//     scope (owner id; 0 is the company), the load, the trip timestamp behind
//     the day and its flags (lateTap, noAtShipper, multiActor, ...);
//   - driverMonths: per scope, driver and month, days and driver pay changed;
//   - investorMonths: per investor and month, the payable now and with the rule
//     (the loss carried forward included), and driver pay;
//   - perInvoice: each live weekly invoice whose week touches --from..--to, the
//     days it pays, the days the rule pays that week, the $ of the days it would
//     add, and the days the rule would not pay (kept: an issued invoice is never
//     reduced);
//   - lateDays: days of earlier weeks the rule pays that no invoice holds yet
//     (from the late days' floor on, they go on that week's invoice while it is
//     not approved, else on a correction invoice for that week);
//   - refusedDays: days of --from..--to worked by the trip timestamps that no
//     invoice will carry, with the reason and amount (before the floor: paid by
//     the ledger, on no invoice; a load settling before FROM; a closed month; a
//     manual invoice or an adjustment that may already pay it);
//   - backfillRows / backfillConflicts: what scripts/backfill-invoice-paid-days.js
//     would write first;
//   - closedMonthsUnchanged and monthsBeforeFromUnchanged: every closed month,
//     and every month before FROM, identical with and without the rule. If not,
//     the run exits 1 after printing.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/work-days-dry-run.js --from=YYYY-MM [--to=YYYY-MM] --db=app.db --sheet-id=<id> [--key=service-account-key.json] [--names] [--json]
//   --from=YYYY-MM         the TRIP_WORK_DAYS_FROM to try. Refused unless it is
//                          after the latest closed month
//   --to=YYYY-MM           the last month the lists cover (default --from)
//   --floor=YYYY-MM-DD     a day in the week the first rule invoice is expected
//                          for (the switch-on week); default this business
//                          week. Ignored once the rule has invoiced (the stored
//                          floor applies)
//   --sheet-id=env         the SPREADSHEET_ID the .env sets (refused when none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --names                name drivers and investors (default: "driver 1", …,
//                          numbered per run, and investors by owner id)
//   --json                 print the whole result as JSON (default: a text report)
//   --dry-run              accepted; the run is always read-only
// Exit codes: 0 done, 1 error or a closed month would change, 2 refused.

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { buildLedgerWorld, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const tripWorkDays = require("../lib/trip-work-days");
const ledgerDayOnce = require("../lib/ledger-day-once");

const ROOT = path.join(__dirname, "..");
const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function latestClosedOf(dbFile) {
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'period_locks'").get()) {
			refuse("the database has no period_locks table, so its closed months cannot be told");
		}
		return ledgerDayOnce.latestClosedMonth(probe);
	} finally {
		probe.close();
	}
}

function printText(r) {
	const s = r.summary;
	const lines = [];
	lines.push(`Trip work-day dry run: TRIP_WORK_DAYS_FROM=${r.from}, lists ${r.from} to ${r.to} (latest closed month: ${r.latestClosedMonth || "none"}; late days' floor ${r.lateDaysFloor}). Nothing was written.`);
	lines.push(`Ledger driver-days: +${s.daysAdded} / -${s.daysRemoved}; driver pay ${usd(s.driverPayChange)}; investor payable ${usd(s.investorPayableChange)}.`);
	lines.push(`Invoices whose week the rule pays differently: ${s.invoicesChanged} (days the rule adds: ${usd(s.invoiceAmountAdded)}; ${s.invoiceDaysDroppedKept} day(s) it would not pay stay as issued).`);
	lines.push(`Late days: ${s.lateDays} (${usd(s.lateDaysAmount)}; overlapping the invoices' added days). Refused days: ${s.refusedDays} (${usd(s.refusedAmount)}).`);
	lines.push(`Backfill: ${s.backfillRows} row(s), ${s.backfillConflicts} conflict(s).`);
	lines.push("", "Driver-days (scope, driver, month, day, change, load, trip start, flags):");
	for (const d of r.perDay) lines.push(`  owner ${d.ownerId}  ${d.driver}  ${d.month}  ${d.day}  ${d.change} ${usd(d.amount)}  ${d.added ? "added day" : `load ${d.loadId}`}  ${d.tripStartStatus ? `${d.tripStartStatus} ${d.tripStart}` : "(no trip)"}  ${d.flags.join(",")}`);
	lines.push("", "Driver pay by scope, driver and month:");
	for (const m of r.driverMonths) lines.push(`  owner ${m.ownerId}  ${m.driver}  ${m.month}  ${m.daysChange > 0 ? "+" : ""}${m.daysChange} day(s)  ${usd(m.driverPayChange)}`);
	lines.push("", "Investor payable by month:");
	for (const i of r.investorMonths) lines.push(`  owner ${i.ownerId}${i.investor ? ` (${i.investor})` : ""}  ${i.period}  ${usd(i.current)} -> ${usd(i.withRule)}  (${usd(i.delta)}; driver pay ${usd(i.driverPayChange)})`);
	lines.push("", "Invoices (number, status, week, days the rule adds, $; days it would not pay, kept; once the rule is on):");
	for (const i of r.perInvoice) lines.push(`  ${i.invoiceNumber}  ${i.status}  ${i.weekStart}  ${i.driver}  +[${i.addedDays.join(", ")}] ${usd(i.amountAdded)}  kept [${i.droppedDays.join(", ")}]  ${i.afterSwitchOn}`);
	lines.push("", "Late days (driver, week, day, loads, $, invoice):");
	for (const d of r.lateDays) lines.push(`  ${d.driver}  ${d.weekStart}  ${d.day}  ${d.loadIds.join(", ")}  ${usd(d.amount)}  ${d.invoice || "(no invoice for that week)"}`);
	lines.push("", "Refused days (driver, day, load, $, reason):");
	for (const d of r.refusedDays) lines.push(`  ${d.driver}  ${d.day}  ${d.loadId}  ${usd(d.amount)}  ${d.reason}`);
	lines.push("", "Backfill rows (day, invoice, status, driver):");
	for (const b of r.backfillRows) lines.push(`  ${b.day}  ${b.invoiceNumber}  ${b.status}  ${b.driver}`);
	for (const c of r.backfillConflicts) lines.push(`  CONFLICT ${c.day}  ${c.invoiceNumber} (held by ${c.heldBy})  ${c.driver}`);
	lines.push("", `Closed months unchanged: ${r.closedMonthsUnchanged ? "yes" : "NO"}. Months before FROM unchanged: ${r.monthsBeforeFromUnchanged ? "yes" : "NO"}.`);
	for (const p of r.problems) lines.push(`PROBLEM: owner ${p.ownerId}: ${p.issue}`);
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const from = typeof args.from === "string" ? args.from.trim() : "";
	const to = typeof args.to === "string" ? args.to.trim() : "";
	if (!tripWorkDays.FROM_MONTH_RE.test(from)) refuse("--from=YYYY-MM is required: the TRIP_WORK_DAYS_FROM to try");
	if (to && (!tripWorkDays.FROM_MONTH_RE.test(to) || to < from)) refuse("--to must be a month (YYYY-MM) on or after --from");
	if (!args.db || args.db === true) refuse("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	try {
		dbFile = envFor({ root: ROOT, dbPath: args.db, envFile }).file;
	} catch (err) {
		refuse(err.message);
	}
	const latestClosed = latestClosedOf(dbFile);
	if (latestClosed && from <= latestClosed) {
		refuse(`--from=${from} is at or before ${latestClosed}, the latest closed month. The rule may only start in an open month: closed months are final as recorded.`);
	}
	const sheetData = await sheetFor(args, ROOT);
	const world = buildLedgerWorld({
		root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile,
		// The baseline is the rule off; the run passes FROM itself.
		envOverrides: { TRIP_WORK_DAYS_ENABLED: "false" },
		extraRoots: ["workDaysDryRun"],
	});
	try {
		const floor = typeof args.floor === "string" ? args.floor.trim() : "";
		const result = await world.api.workDaysDryRun({ from, to, floor, names: args.names === true });
		if (result.refused) refuse(result.reason);
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
		if (!result.closedMonthsUnchanged || !result.monthsBeforeFromUnchanged) process.exitCode = 1;
	} finally {
		world.db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
