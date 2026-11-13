#!/usr/bin/env node
// scripts/payroll-check.js: the before-payroll check, run on the server with no
// login. It lifts the server's own payrollCheck() from this checkout's server.js
// (scripts/lib/ledger-world.js), the function GET /api/admin/payroll-check
// returns, on a read-only handle of app.db, and writes nothing. It runs whatever
// PAYROLL_CHECK_ENABLED says: that switch gates the route only.
//
// Per driver and week of the open months, up to the week ending --week-end:
//   - ledger-paid days on no invoice, each with its reason;
//   - invoice-paid days the books no longer pay (kept as issued);
//   - Personal lines on no invoice, and receipts still Pending;
//   - correction invoices waiting for approval, and percentage drivers'
//     completed loads that no live invoice bills.
// --json prints every amount in whole cents; the text report prints dollars.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/payroll-check.js --week-end=YYYY-MM-DD --db=app.db --sheet-id=<id> [--key=<key file>] [--names] [--json]
//   --week-end=YYYY-MM-DD  required: the Friday ending the last week to check, a
//                          finished week that touches an open month
//   --db=<file>            required: the app directory's app.db, or a copy under
//                          the temp directory
//   --sheet-id=<id>|env    the Job Tracking sheet (env: the SPREADSHEET_ID the
//                          app's settings set, refused when they set none); no default
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --names                name drivers (default: "driver 1", ..., numbered per run)
//   --json                 print the whole answer as JSON (default: a text report)
//   --help                 print this and stop
// Exit codes: 0 done, 1 error, 2 refused (a missing or bad argument, or a week
// the check does not cover).

"use strict";

const fs = require("fs");
const path = require("path");
const { buildLedgerWorld, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const USAGE = fs.readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

const money = (cents) => (Number.isInteger(cents) ? `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}` : "-");
const reasons = (byReason) => Object.entries(byReason || {}).map(([k, n]) => `${k} ${n}`).join("; ") || "none";

function printText(r) {
	const s = r.summary;
	const lines = [];
	lines.push(`Before-payroll check: weeks ${r.rangeStart || "(every week)"} to ${r.weekEnd} (latest closed month: ${r.latestClosedMonth || "none"}). Nothing was written.`);
	lines.push("", `Ledger-paid days on no invoice: ${s.ledgerDays.count} (${money(s.ledgerDays.cents)}). By reason: ${reasons(s.ledgerDays.byReason)}.`);
	for (const d of r.ledgerDays) {
		lines.push(`  ${d.driver}  week ${d.weekStart}  ${d.day}  ${d.added ? "added day" : `load ${d.loadId}`}  ${money(d.cents)}  ${d.invoiceNumber || "(no invoice)"}  owners ${d.scopes.map((x) => x.ownerId).join(",")}  ${d.reason}: ${d.text}`);
	}
	lines.push("", `Invoice-paid days the books no longer pay (kept as issued): ${s.invoiceDays.count} (${money(s.invoiceDays.cents)}). By reason: ${reasons(s.invoiceDays.byReason)}.`);
	for (const d of r.invoiceDays) lines.push(`  ${d.driver}  week ${d.weekStart}  ${d.day}  ${d.invoiceNumber} (${d.status})  ${money(d.cents)}  ${d.reason}: ${d.text}`);
	lines.push("", `Personal lines on no invoice: ${s.personalLines.count} (${money(s.personalLines.cents)}). By reason: ${reasons(s.personalLines.byReason)}.`);
	for (const p of r.personalLines) lines.push(`  ${p.driver}  week ${p.weekStart}  line ${p.lineId} (receipt ${p.expenseId}, ${p.receiptDate || "no date"})  ${money(p.cents)}  ${p.state}  ${p.reason}: ${p.text}`);
	lines.push("", `Receipts still Pending: ${s.pendingReceipts.count} (${money(s.pendingReceipts.cents)}).`);
	for (const p of r.pendingReceipts) lines.push(`  ${p.driver}  week ${p.weekStart}  receipt ${p.expenseId}  ${p.date}  ${p.type}  ${money(p.cents)}`);
	lines.push("", `Correction invoices waiting for approval: ${s.correctionDrafts.count} (${money(s.correctionDrafts.cents)}).`);
	for (const c of r.correctionDrafts) lines.push(`  ${c.driver}  ${c.invoiceNumber} (${c.status}, ${c.kind})  ${c.weekStart} to ${c.weekEnd}  ${c.correctionOf ? `corrects ${c.correctionOf}` : ""}  ${money(c.cents)}`);
	lines.push("", `Percentage drivers' completed loads no invoice bills: ${s.percentageLoads.count} (revenue ${money(s.percentageLoads.paymentCents)}). By reason: ${reasons(s.percentageLoads.byReason)}.`);
	for (const p of r.percentageLoads) lines.push(`  ${p.driver}  load ${p.loadId}  completed ${p.completed || "(no date)"}  revenue ${money(p.paymentCents)}  ${p.reason}: ${p.text}`);
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help === true) {
		console.log(USAGE);
		return;
	}
	const weekEnd = typeof args["week-end"] === "string" ? args["week-end"].trim() : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) refuse("--week-end=YYYY-MM-DD is required: the Friday ending the last week to check");
	if (typeof args.db !== "string" || !args.db.trim()) refuse("--db=<app.db> is required");
	if ((typeof args["values-json"] !== "string" || !args["values-json"]) && (typeof args["sheet-id"] !== "string" || !args["sheet-id"].trim())) {
		refuse("--sheet-id=<id> (or --values-json=<file>) is required; there is no default sheet");
	}
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	try {
		dbFile = envFor({ root: ROOT, dbPath: args.db, envFile }).file;
	} catch (err) {
		refuse(err.message);
	}
	if (!fs.existsSync(dbFile)) refuse(`--db names no file (${args.db})`);
	let sheetData;
	try {
		sheetData = await sheetFor(args, ROOT);
	} catch (err) {
		if (/--sheet-id/.test(err.message)) refuse(err.message);
		throw err;
	}
	const world = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, extraRoots: ["payrollCheck"] });
	try {
		const result = await world.api.payrollCheck({ weekEnd, names: args.names === true });
		if (result.refused) refuse(result.reason);
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
	} finally {
		world.db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
