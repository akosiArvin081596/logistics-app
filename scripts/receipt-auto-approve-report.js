#!/usr/bin/env node
// scripts/receipt-auto-approve-report.js — what receipts auto-approve did or would do,
// read-only. Receipt ids, dates, truck units and reason codes only: never a name.
//
//   default       the pass's own record (receipt_auto_reviews): would approve X of Y
//                 judged, every held receipt with its reasons, agreement with what
//                 people did, receipts decided before the pass could judge, S3 (a
//                 would-approve a person rejected or undid), reads, and the proof that
//                 no money moved (per owner and open month, receipts not Rejected)
//   --free-rules  rules 1-10 only, for every fuel receipt filed since --since, whatever
//                 its status: no Gemini call and no write. Rejected receipts are judged
//                 from the matcher's in-memory match that includes them. This is the
//                 "what would change" report before shadow goes on.
//
// Usage: node scripts/receipt-auto-approve-report.js [--db=<path>] [--since=YYYY-MM-DD] [--free-rules] [--json]
//   --db  a copy outside the repository; without it, the app's own database
//         (scripts/lib/app-database.js resolveDatabase(), refused in replica mode)
// The database is opened read-only (checked); on a WAL database SQLite's read-only
// open may create empty -wal and -shm files, and the database file is never written.
// Exit codes: 0 done, 1 error, 2 refused.

"use strict";

const path = require("path");
const { parseArgs, openDb } = require("./lib/ledger-world");
const { resolveDatabase, DatabaseRefusal } = require("./lib/app-database");
const { liftServer, passDeps } = require("./lib/receipt-auto-approve-lift");
const passLib = require("../lib/receipt-auto-approve-pass");

const ROOT = path.join(__dirname, "..");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function hasTable(db, name) {
	return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function buildReport(db, { since, freeRules }) {
	const S = liftServer(db, { root: ROOT, env: {} });
	const pass = passLib.create({ ...passDeps(db, S), config: passLib.readConfig({}) });
	const proof = passLib.moneyProof(db, {
		periodExpr: S.EXPENSE_PERIOD_EXPR,
		pnlFilter: S.EXPENSE_PNL_FILTER,
		openMonth: (p) => !S.expenseRowPeriodLocked({ posted_period: p, date: `${p}-01`, created_at: "" }) && !S.isPastGrace(p, S.settlementGraceDays()),
	});
	if (freeRules) {
		const inMemory = S.matchFuelEventsToReceipts({ persist: false, writeReceipts: false, includeRejected: true }).matched;
		return { kind: "free-rules", since, ...pass.freeRules({ since, inMemory }), moneyProof: proof };
	}
	if (!hasTable(db, "receipt_auto_reviews")) return { kind: "record", since, note: "no review table: the pass has never run on this database", moneyProof: proof };
	return { kind: "record", since, ...passLib.summary(db, { detail: true, since }), moneyProof: proof };
}

function print(r) {
	const out = [];
	if (r.kind === "free-rules") {
		out.push(`Rules 1-10 on fuel receipts filed since ${r.since || "the start"} (no read, no write):`);
		out.push(`  judged ${r.judged}: pass rules 1-10 ${r.verdicts.read || 0}, held ${r.verdicts.hold || 0}, waiting for a fill ${r.verdicts.wait || 0}`);
		out.push(`  not judged: ${Object.entries(r.notJudged).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
		out.push(`  holds by reason: ${Object.entries(r.reasons).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
		for (const x of r.receipts) out.push(`  #${x.id} ${x.date} ${x.truckUnit || "-"} ${x.status || "Pending"}: ${x.verdict}${x.reasons.length ? ` (${x.reasons.join(", ")})` : ""}`);
	} else if (r.note) {
		out.push(r.note);
	} else {
		const c = r.counts;
		out.push(`Receipts judged since ${r.since || "the start"}: ${c.judged}`);
		out.push(`  would approve ${c.approve} of ${c.judged}; held ${c.hold}; waiting ${c.wait}; approved by the pass ${c.applied}; undone ${c.undone}`);
		out.push(`  S3 (a would-approve that a person rejected or undid): ${c.s3}`);
		out.push(`  decided before the pass could judge: ${c.decidedBefore}; Rejected when judged: ${c.rejectedJudged}`);
		out.push(`  agreement, would-approve: approved ${c.agreement.approve.Approved}, rejected ${c.agreement.approve.Rejected}, undone ${c.agreement.approve.undone}, still Pending ${c.agreement.approve.Pending}`);
		out.push(`  agreement, held: approved by a person ${c.agreement.hold.Approved}, rejected (catches) ${c.agreement.hold.Rejected}, still Pending ${c.agreement.hold.Pending}`);
		out.push(`  not applied: ${Object.entries(c.notApplied).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}; reads kept ${c.reads}`);
		out.push(`  holds by reason: ${Object.entries(c.reasons).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
		for (const x of r.receipts) {
			out.push(`  #${x.id} ${x.date} ${x.truckUnit || "-"} now ${x.status || "?"}: ${x.verdict}${x.reasons.length ? ` (${x.reasons.join(", ")})` : ""}`
				+ `${x.decidedBefore ? " [decided before]" : ""}${x.appliedAt ? " [applied]" : ""}${x.notApplied ? ` [not applied: ${x.notApplied}]` : ""}${x.undoneAt ? " [undone]" : ""}`);
		}
	}
	out.push("Receipts not Rejected, per owner and open month (approval moves none of it):");
	for (const m of r.moneyProof) out.push(`  owner ${m.owner_id} ${m.period}: ${m.n} receipt(s), $${Number(m.total).toFixed(2)}`);
	return out.join("\n");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const since = args.since && args.since !== true ? String(args.since) : "";
	if (since && !DAY_RE.test(since)) refuse("--since takes YYYY-MM-DD");
	let target;
	try {
		target = resolveDatabase(args.db && args.db !== true ? String(args.db) : null, ROOT);
	} catch (e) {
		if (e instanceof DatabaseRefusal) refuse(e.message);
		throw e;
	}
	const db = openDb({ root: ROOT, dbFile: target.file, readonly: true });
	try {
		const report = buildReport(db, { since, freeRules: !!args["free-rules"] });
		console.log(args.json ? JSON.stringify(report, null, 2) : print(report));
	} finally {
		db.close();
	}
}

if (require.main === module) {
	try {
		main();
	} catch (e) {
		console.error(`ERROR: ${e && e.message}`);
		process.exit(1);
	}
}

module.exports = { buildReport, print };
