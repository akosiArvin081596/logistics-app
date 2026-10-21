#!/usr/bin/env node
// scripts/financials-invoice-split-report.js — the read-only "what would change"
// report for money plan C (2026-10-15): the Financials month detail's driver
// table counted each driver invoice in full in every month its week touched, so
// a week spanning two months was counted in both. It now counts each invoice's
// share of each month (server.js financialsInvoiceShares(),
// lib/invoice-month-split.js). This report prints, from one read of the data:
//   - per month and driver: Invoiced, Adjustments, Variance (invoiced minus the
//     books' pay beside it, in whole dollars, as the page shows it) and the
//     invoice count, before and after;
//   - every invoice whose counting changes, with its split: the month of each
//     part (days, loads or calendar days) and the parts counted once in
//     week_end's month (adjustment, returned Personal share, gap);
//   - checks: each invoice's shares add up to its invoiced amount, and the months
//     together count every invoice once.
// Closed months are marked "display only": on their page only these invoice
// columns change; their revenue, driver pay and payouts stay exactly as settled,
// and nothing is written to them (or anywhere).
//
// Read-only: the database is opened read-only (refused if the handle is not) and
// read inside one read transaction; Job Tracking comes from --sheet-id (the
// spreadsheets.readonly scope) or a saved values.get (--values-json). The books
// are this checkout's server.js, lifted (scripts/lib/ledger-world.js), so they
// are what the page computes.
//
// Usage (on the server from the app directory, or on a copy under the temp
// directory):
//   node scripts/financials-invoice-split-report.js --db=app.db --sheet-id=<id> [--json] [--names]
//   node scripts/financials-invoice-split-report.js --db=<copy> --values-json=<file> [--env-file=<file>] [--json] [--names]
//   --names   name drivers (default: initials)
//   --json    print the whole result as JSON (default: a text report)
// Exit codes: 0 done, 1 error or a check failed, 2 refused (a missing argument,
// or a database the ledger world does not open).

"use strict";

process.env.TZ = "UTC"; // production's clock zone, before any date is read

const path = require("path");
const { buildLedgerWorld, openDb, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const split = require("../lib/invoice-month-split");

const ROOT = path.join(__dirname, "..");
const EXTRA_ROOTS = ["financialsInvoiceShares", "normalizeDriverName", "driverNameForTotals"];
const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

class Refusal extends Error {}
const dollars = (cents) => Math.round(cents) / 100;

function lastDayOf(month) {
	const [y, m] = month.split("-").map(Number);
	return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
// Every month from `from` to `to` ("YYYY-MM"), both included.
function monthsBetween(from, to) {
	const out = [];
	let [y, m] = from.split("-").map(Number);
	const [ty, tm] = to.split("-").map(Number);
	while (y < ty || (y === ty && m <= tm)) {
		out.push(`${y}-${String(m).padStart(2, "0")}`);
		m += 1;
		if (m > 12) { m = 1; y += 1; }
	}
	return out;
}

// The table's invoice columns before plan C, for the months an invoice's week
// touched: the invoice in full (earnings, adjustment and returned share) in each.
function oldCounting(r) {
	const out = {};
	if (!DAY_RE.test(r.week_start || "") || !DAY_RE.test(r.week_end || "") || r.week_start > r.week_end) return out;
	const cents = Math.round(r.total_earnings * 100) + Math.round(r.adjustment * 100) + Math.round(r.personal_share_total * 100);
	for (const mk of monthsBetween(r.week_start.slice(0, 7), r.week_end.slice(0, 7))) {
		if (r.week_start <= lastDayOf(mk) && r.week_end >= `${mk}-01`) out[mk] = cents;
	}
	return out;
}

// Driver labels: initials (a second driver with the same initials gets "-2"),
// or the name with --names.
function labeller(names) {
	const given = new Map();
	const used = new Map();
	return (key) => {
		if (names) return key;
		if (given.has(key)) return given.get(key);
		const base = String(key).split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("") || "?";
		const n = (used.get(base) || 0) + 1;
		used.set(base, n);
		const label = n === 1 ? base : `${base}-${n}`;
		given.set(key, label);
		return label;
	};
}

async function computeReport({ api, db, names }) {
	const books = await api.buildFinancialsLedger();
	const label = labeller(names);
	const closed = books.lockedPeriods;
	const rows = db.prepare(
		`SELECT id, invoice_number, driver, week_start, week_end, status,
		        COALESCE(total_earnings,0) AS total_earnings, COALESCE(adjustment,0) AS adjustment, COALESCE(personal_share_total,0) AS personal_share_total
		 FROM invoices WHERE status != 'Rejected' AND deleted_at = '' ORDER BY id`
	).all();
	const shareRows = api.financialsInvoiceShares(books);
	const byId = new Map(shareRows.map((s) => [s.id, s]));

	// The books' pay per month and driver (the column the variance compares with).
	const pay = new Map();
	for (const it of books.items) {
		if (it.kind !== "driver_pay" || !it.driver) continue;
		const k = `${it.month}\t${it.driver}`;
		pay.set(k, (pay.get(k) || 0) + it.cents);
	}

	const oldRows = [];
	for (const r of rows) {
		const driver = api.normalizeDriverName(api.driverNameForTotals(r.driver));
		if (!driver) continue;
		oldRows.push({ id: r.id, driver, counting: oldCounting(r), adjustmentCents: Math.round(r.adjustment * 100), row: r });
	}
	const months = new Set();
	for (const o of oldRows) for (const mk of Object.keys(o.counting)) months.add(mk);
	for (const s of shareRows) for (const mk of s.months) if (MONTH_RE.test(mk)) months.add(mk);

	const monthOut = [];
	for (const mk of [...months].sort()) {
		const oldBy = Object.create(null);
		for (const o of oldRows) {
			if (!Object.prototype.hasOwnProperty.call(o.counting, mk)) continue;
			const e = oldBy[o.driver] || (oldBy[o.driver] = { count: 0, invoicedCents: 0, adjustmentCents: 0 });
			e.count += 1;
			e.invoicedCents += o.counting[mk];
			e.adjustmentCents += o.adjustmentCents;
		}
		const newBy = split.monthInvoiceTotals(shareRows, mk);
		const drivers = [];
		const totals = { old: { invoiced: 0, adjustments: 0, invoiceCount: 0 }, new: { invoiced: 0, adjustments: 0, invoiceCount: 0 } };
		for (const driver of [...new Set([...Object.keys(oldBy), ...Object.keys(newBy)])].sort()) {
			const payCents = pay.get(`${mk}\t${driver}`) || 0;
			const o = oldBy[driver] || null;
			const n = newBy[driver] || null;
			const side = (x, cents) => (x ? { invoiced: dollars(cents), adjustments: dollars(x.adjustmentCents), variance: Math.round((cents - payCents) / 100), invoiceCount: x.count }
				: { invoiced: 0, adjustments: 0, variance: null, invoiceCount: 0 });
			const before = side(o, o ? o.invoicedCents : 0);
			const after = side(n, n ? n.invoicedCents : 0);
			if (n) after.splitInvoices = n.splitCount;
			totals.old.invoiced += o ? o.invoicedCents : 0;
			totals.old.adjustments += o ? o.adjustmentCents : 0;
			totals.old.invoiceCount += o ? o.count : 0;
			totals.new.invoiced += n ? n.invoicedCents : 0;
			totals.new.adjustments += n ? n.adjustmentCents : 0;
			totals.new.invoiceCount += n ? n.count : 0;
			const changed = JSON.stringify([before.invoiced, before.adjustments, before.variance, before.invoiceCount])
				!== JSON.stringify([after.invoiced, after.adjustments, after.variance, after.invoiceCount]);
			drivers.push({ driver: label(driver), pay: dollars(payCents), old: before, new: after, changed });
		}
		for (const side of ["old", "new"]) {
			totals[side].invoiced = dollars(totals[side].invoiced);
			totals[side].adjustments = dollars(totals[side].adjustments);
		}
		const isClosed = closed.has(mk);
		monthOut.push({
			month: mk,
			closed: isClosed,
			frozen: books.frozenPeriods.has(mk),
			note: isClosed ? "display only: only the invoice columns change on this page; revenue, driver pay and payouts stay as settled" : "",
			totals,
			changed: drivers.some((d) => d.changed),
			drivers,
		});
	}

	const invoices = [];
	const problems = [];
	let invoicedCents = 0;
	let countedCents = 0;
	for (const o of oldRows) {
		const s = byId.get(o.id);
		if (!s) { problems.push(`invoice #${o.id} has no split`); continue; }
		const sum = Object.values(s.shares).reduce((a, c) => a + c, 0);
		if (sum !== s.invoicedCents) problems.push(`${s.invoiceNumber}: shares add up to ${dollars(sum)}, its invoiced amount is ${dollars(s.invoicedCents)}`);
		invoicedCents += s.invoicedCents;
		for (const [mk, c] of Object.entries(s.shares)) if (months.has(mk)) countedCents += c;
		const newCounting = s.shares;
		if (JSON.stringify(o.counting) === JSON.stringify(newCounting)) continue;
		const partsByMonth = {};
		for (const p of s.parts) {
			const e = partsByMonth[p.month] || (partsByMonth[p.month] = { days: [], loads: 0, calendarDays: 0, unsplit: {} });
			if (p.kind === "day") e.days.push(p.day);
			else if (p.kind === "load") e.loads += 1;
			else if (p.kind === "calendar") e.calendarDays += p.days;
			else if (p.unsplit) e.unsplit[p.kind] = dollars(p.cents);
		}
		invoices.push({
			invoice: s.invoiceNumber,
			driver: label(o.driver),
			weekStart: s.weekStart,
			weekEnd: s.weekEnd,
			status: s.status,
			invoiced: dollars(s.invoicedCents),
			method: s.method,
			old: Object.fromEntries(Object.entries(o.counting).map(([mk, c]) => [mk, dollars(c)])),
			new: Object.fromEntries(Object.entries(newCounting).map(([mk, c]) => [mk, dollars(c)])),
			closedMonths: [...new Set([...Object.keys(o.counting), ...s.months])].filter((mk) => closed.has(mk)).sort(),
			unsplit: { month: s.unsplit.month, adjustment: dollars(s.unsplit.adjustmentCents), personalShare: dollars(s.unsplit.personalShareCents), gap: dollars(s.unsplit.gapCents) },
			parts: partsByMonth,
		});
	}
	if (countedCents !== invoicedCents) problems.push(`the months together count ${dollars(countedCents)}, the invoices are invoiced at ${dollars(invoicedCents)}`);
	return {
		report: "financials-invoice-split",
		readOnly: true,
		closedMonths: [...closed].sort(),
		invoicesRead: oldRows.length,
		invoiced: dollars(invoicedCents),
		countedOnce: countedCents === invoicedCents,
		months: monthOut,
		invoices,
		problems,
	};
}

function textReport(r) {
	const out = [];
	const money = (x) => `$${Number(x).toFixed(2)}`;
	out.push(`Financials driver table, invoice columns: before vs after the week split (read-only). ${r.invoicesRead} invoices, invoiced ${money(r.invoiced)} (earnings, adjustments and returned Personal shares).`);
	for (const m of r.months) {
		const t = m.totals;
		out.push("");
		out.push(`${m.month}${m.closed ? " (closed; display only)" : ""}: invoiced ${money(t.old.invoiced)} -> ${money(t.new.invoiced)}, adjustments ${money(t.old.adjustments)} -> ${money(t.new.adjustments)}, invoices ${t.old.invoiceCount} -> ${t.new.invoiceCount}${m.changed ? "" : " (unchanged)"}`);
		for (const d of m.drivers.filter((x) => x.changed)) {
			const v = (x) => (x === null ? "none" : String(x));
			out.push(`  ${d.driver}: pay ${money(d.pay)}; invoiced ${money(d.old.invoiced)} -> ${money(d.new.invoiced)}; adj ${money(d.old.adjustments)} -> ${money(d.new.adjustments)}; variance ${v(d.old.variance)} -> ${v(d.new.variance)}; count ${d.old.invoiceCount} -> ${d.new.invoiceCount}`);
		}
	}
	out.push("");
	out.push(`Invoices whose counting changes: ${r.invoices.length}`);
	for (const i of r.invoices) {
		const fmt = (o) => Object.entries(o).map(([mk, x]) => `${mk} ${money(x)}`).join(", ") || "none";
		out.push(`  ${i.invoice} (${i.driver}, ${i.weekStart}..${i.weekEnd}, ${i.status}, invoiced ${money(i.invoiced)}, by ${i.method}): before ${fmt(i.old)}; after ${fmt(i.new)}${i.closedMonths.length ? `; closed: ${i.closedMonths.join(", ")}` : ""}`);
	}
	out.push("");
	out.push(`Counted once across the months: ${r.countedOnce ? "yes" : "NO"}. Problems: ${r.problems.length ? r.problems.join("; ") : "none"}.`);
	return out.join("\n");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (typeof args.db !== "string") throw new Refusal("--db=<app.db> is required");
	if (typeof args["values-json"] !== "string" && typeof args["sheet-id"] !== "string") throw new Refusal("--sheet-id=<id> or --values-json=<file> is required; there is no default sheet");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	try {
		({ file: dbFile } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		throw new Refusal(err.message);
	}
	const db = openDb({ root: ROOT, dbFile, readonly: true });
	try {
		// One snapshot: a read transaction held to the end; the sheet is read
		// inside it.
		db.exec("BEGIN");
		const sheetData = await sheetFor(args, ROOT);
		const world = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, extraRoots: EXTRA_ROOTS, db });
		return await computeReport({ api: world.api, db, names: args.names === true });
	} finally {
		if (db.inTransaction) db.exec("ROLLBACK");
		db.close();
	}
}

if (require.main === module) {
	const json = process.argv.includes("--json");
	main().then((r) => {
		console.log(json ? JSON.stringify(r, null, 2) : textReport(r));
		process.exit(r.problems.length ? 1 : 0);
	}).catch((err) => {
		if (err instanceof Refusal) {
			console.error(`REFUSED: ${err.message}`);
			process.exit(2);
		}
		console.error(`ERROR: ${(err && err.message) || err}`);
		process.exit(1);
	});
}

module.exports = { oldCounting, monthsBetween, labeller };
