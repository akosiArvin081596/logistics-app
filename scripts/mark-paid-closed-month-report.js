#!/usr/bin/env node
// Read-only "what would change" report for MARK_PAID_CLOSED_MONTH_ENABLED: which
// driver invoices touching a closed month could be marked Paid with the flag on,
// which closed-month paid stamps a revert could clear, and a fingerprint of every
// closed month's settled rows.
//
// The flag lets a Super Admin mark an invoice Paid when its week touches a closed
// month: the payment is recorded (status, paid_at, paid_by, an audit row) and no
// closed month's revenue, P&L, payout or investor figure changes. A revert may
// clear only a paid stamp set after every closed month in the week was locked; a
// stamp that existed when a month closed is part of that month's record.
//
// The fingerprint hashes ONLY the closed months' rows of investor_payouts,
// investor_payout_history, financials_ledger_items, financials_ledger_freezes and
// period_locks: open-month rows move with the normal reconcile. Run it before the
// flag goes on and again after the first closed-month Mark Paid: the fingerprint
// must be identical.
//
// The rules are the server's own (invoiceMonthLockBlockers(), invoiceTotalDue(),
// paidStampAfterLocks()), lifted through scripts/lib/ledger-world.js on its
// read-only handle. No sheet is read.
//
//   node scripts/mark-paid-closed-month-report.js --db=app.db [--json] [--names]
//   node scripts/mark-paid-closed-month-report.js --db=<copy> --env-file=<file> [--json]
//
// Drivers are numbered ("driver 1") unless --names. Exit 0; 2 on a refused
// argument.

"use strict";

const crypto = require("crypto");
const path = require("path");
const { buildLedgerWorld, parseArgs } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const FINGERPRINTED = ["investor_payouts", "investor_payout_history", "financials_ledger_items", "financials_ledger_freezes", "period_locks"];
const round2 = (x) => Math.round(x * 100) / 100;

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

// sha256 of one table's closed-month rows (empty when the table is absent).
function closedRowsHash(db, table, periods) {
	const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	const rows = present && periods.length
		? db.prepare(`SELECT * FROM "${table}" WHERE period IN (${periods.map(() => "?").join(", ")}) ORDER BY rowid`).all(...periods)
		: [];
	return { rows: rows.length, sha256: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}

function nextStep(status) {
	if (status === "Approved" || status === "Processing") return "can be marked Paid with the flag on";
	if (status === "Submitted") return "can be marked Paid with the flag on, after approval";
	if (status === "Draft") return "waits for the driver to submit";
	return `status ${status}`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.db || args.db === true) refuse("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let world;
	try {
		world = buildLedgerWorld({
			root: ROOT, dbPath: args.db, readonly: true, sheetData: null, envFile,
			extraRoots: ["invoiceMonthLockBlockers", "invoiceTotalDue", "paidStampAfterLocks", "MARK_PAID_CLOSED_MONTH_ENABLED"],
		});
	} catch (err) {
		refuse(err.message);
	}
	const { api, db } = world;
	try {
		const locks = db.prepare("SELECT period, finalized_at FROM period_locks WHERE status = 'locked' ORDER BY period").all();
		const periods = locks.map((l) => l.period);
		// correction_lines_total is read with the row (invoiceTotalDue() refuses a row
		// without it); a database from before the column has no correction line.
		const hasCorrections = db.prepare("PRAGMA table_info(invoices)").all().some((c) => c.name === "correction_lines_total");
		const invoices = db.prepare(
			`SELECT id, invoice_number, driver, week_start, week_end, status, total_earnings, adjustment, personal_total, personal_share_total,
			        ${hasCorrections ? "correction_lines_total" : "0 AS correction_lines_total"},
			        COALESCE(paid_at, '') AS paid_at
			   FROM invoices WHERE COALESCE(deleted_at, '') = '' ORDER BY week_start, id`
		).all();
		const labels = new Map();
		const who = (name) => {
			if (args.names === true) return name || "";
			if (!labels.has(name)) labels.set(name, `driver ${labels.size + 1}`);
			return labels.get(name);
		};
		const unpaid = [];
		const paid = [];
		const unreadable = [];
		for (const inv of invoices) {
			const lock = api.invoiceMonthLockBlockers(inv);
			if (lock.unreadable) refuse("the period lock table could not be read");
			if (!lock.blockers.length) continue;
			const months = [...new Set(lock.blockers.flatMap((b) => b.periods))].filter(Boolean).sort();
			const row = {
				invoice: inv.invoice_number, driver: who(inv.driver), week: `${inv.week_start}..${inv.week_end}`,
				status: inv.status, totalDue: api.invoiceTotalDue(inv), closedMonths: months,
			};
			if (lock.blockers.some((b) => b.periods.some((p) => !p))) { unreadable.push({ ...row, note: "week date unreadable: still refused" }); continue; }
			if (inv.status === "Paid" && inv.paid_at.trim()) {
				const after = api.paidStampAfterLocks(inv, months);
				paid.push({ ...row, paidAt: inv.paid_at, revert: after ? "allowed with the flag on (stamped after the lock)" : "refused (stamped before the month closed)" });
			} else if (inv.status !== "Rejected") {
				unpaid.push({ ...row, nextStep: nextStep(inv.status) });
			}
		}
		const fingerprint = Object.fromEntries(FINGERPRINTED.map((t) => [t, closedRowsHash(db, t, periods)]));
		const result = {
			flag: api.MARK_PAID_CLOSED_MONTH_ENABLED ? "on" : "off",
			closedMonths: locks.map((l) => ({ period: l.period, lockedAt: l.finalized_at })),
			unpaid, paid, unreadable,
			summary: {
				unpaid: unpaid.length,
				unpaidTotalDue: round2(unpaid.reduce((s, r) => s + r.totalDue, 0)),
				markableNow: unpaid.filter((r) => r.status === "Approved" || r.status === "Processing").length,
				afterApproval: unpaid.filter((r) => r.status === "Submitted").length,
				drafts: unpaid.filter((r) => r.status === "Draft").length,
				paidInClosedMonths: paid.length,
				revertAllowed: paid.filter((r) => r.revert.startsWith("allowed")).length,
			},
			closedMonthFingerprint: fingerprint,
			generatedAt: new Date().toISOString(),
		};
		if (args.json === true) {
			console.log(JSON.stringify(result, null, 1));
			return;
		}
		const lines = [`Mark Paid in closed months: report only, nothing was written. Flag ${result.flag}.`];
		lines.push(`Closed months: ${result.closedMonths.map((c) => `${c.period} (locked ${c.lockedAt || "at an unrecorded time"})`).join(", ") || "none"}`);
		lines.push("", `Unpaid invoices touching a closed month: ${result.summary.unpaid}, $${result.summary.unpaidTotalDue.toFixed(2)} (${result.summary.markableNow} markable once the flag is on, ${result.summary.afterApproval} after approval, ${result.summary.drafts} drafts).`);
		for (const r of unpaid) lines.push(`  ${r.invoice}  ${r.driver}  ${r.week}  ${r.status}  $${r.totalDue.toFixed(2)}  closed: ${r.closedMonths.join(", ")}  -> ${r.nextStep}`);
		lines.push("", `Paid invoices touching a closed month: ${result.summary.paidInClosedMonths} (${result.summary.revertAllowed} revertible with the flag on).`);
		for (const r of paid) lines.push(`  ${r.invoice}  ${r.driver}  ${r.week}  paid ${r.paidAt}  closed: ${r.closedMonths.join(", ")}  revert ${r.revert}`);
		for (const r of unreadable) lines.push(`  ${r.invoice}  ${r.week}  ${r.note}`);
		lines.push("", "Closed-month fingerprint (closed months' rows only; must not change when an invoice is marked Paid):");
		for (const [t, h] of Object.entries(fingerprint)) lines.push(`  ${t}: ${h.rows} row(s)  ${h.sha256}`);
		console.log(lines.join("\n"));
	} finally {
		db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
