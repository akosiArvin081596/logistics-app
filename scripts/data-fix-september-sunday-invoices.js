#!/usr/bin/env node
// scripts/data-fix-september-sunday-invoices.js — corrects two unpaid weekly
// invoices in September 2026, a finalized month, on the invoices themselves:
// Sunday 9/13 (INV-SK-2026W37-01) and Sunday 9/27 (INV-SK-2026W39-01) were not
// worked. The client's decision (2026-10-09): no credit on a later invoice; the
// unpaid invoices are corrected through the month's reopen, and the month is
// finalized again.
//
// It runs the server's own code, lifted from this checkout's server.js
// (scripts/lib/server-lift.js), in this order, as one SQLite transaction:
//   1. reopen September: the handler of POST /api/periods/:period/reopen, with
//      the reason below (the owed payout rows are re-linked to live earnings and
//      the frozen Financials items are released, as the route does);
//   2. exclude each Sunday from the driver's pay: the handler of POST
//      /api/admin/excluded-days, action "remove" (the override the investor
//      ledger, Financials and the invoice generator all read);
//   3. correct each invoice in place: the same row and number, the day taken off
//      its stored render snapshot exactly as the generator applies an excluded
//      day (the day leaves the grid and the total), so Total Due, the day count
//      and the PDF's grid follow; receipts, dates and status stay as issued;
//   4. finalize September again: finalizePeriods(), the month-end close itself
//      (every investor reconciled, the closing fingerprint taken before and
//      re-checked inside the freeze, the payout rows stamped, the Financials
//      items frozen, the lock taken);
//   5. compare all of September before and after (septemberState(),
//      compareSeptember()): only the two invoices, the driver's two pay days and
//      the investor's September payout may change. Anything else rolls the whole
//      transaction back and nothing is written.
// After the commit, each invoice's PDF is re-rendered from its corrected
// snapshot by the server's own rerenderInvoicePdfFromStoredData().
//
// Refused or stopped, writing nothing, when: a correction of these days may
// already be on record elsewhere (anything the cancelled October-credit data
// fix wrote, or an adjustment on the driver's invoices from the first corrected
// week on or on the investor's payout rows from September on); September is not
// finalized (or was reopened by someone else); an invoice is paid, processing, rejected, deleted,
// manual, adjusted, or its Sunday line is not the billed day it should be; a
// Sunday already carries an override this script did not write; the frozen
// ledger does not hold the driver's day at the invoice's rate; the investor's
// September payout is not owed (a paid payout is corrected in the open month);
// the Financials settings changed since September closed; the close retries or
// the comparison finds any other change; the checks, made again once the
// database is held, find anything changed; the investor's payout does not come
// to --expect-payout.
//
// Idempotent: a second apply finds the overrides, the corrected invoices and
// September finalized by this script, writes nothing to the database, and
// re-renders the two PDFs from their stored snapshots. Every change is logged
// in audit_trail as a system change (user 0, username this script, role
// "system"); the reopen, override and close write their routes' own audit rows.
//
// --dry-run never opens the database for writing: it copies it into a fresh
// owner-only folder under the temp directory (SQLite's online backup), runs the
// whole correction on the copy (PDFs rendered into that folder), prints what it
// did there, and deletes the folder. An apply first backs the database up next
// to it (app.db.pre-sunday-invoices-<UTC time>, owner-only, integrity-checked).
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/data-fix-september-sunday-invoices.js --db=app.db --sheet-id=<id> --dry-run
//   node scripts/data-fix-september-sunday-invoices.js --db=app.db --sheet-id=<id> --apply --expect-payout=<dollars>
//   --sheet-id=<id>        the Job Tracking sheet, read with the read-only scope;
//                          there is no default (--sheet-id=env takes the .env's)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --db                   app.db in this app directory, or a copy under the temp
//                          directory (scripts/lib/ledger-world.js dbScope())
//   --env-file=<file>      with a copy only: the flags to run with
//   --data-dir=<dir>       with a copy only: the folder holding uploads/ (default:
//                          the app directory)
//   --key=<file>           the service account key (default service-account-key.json)
//   --expect-payout=<$>    required to apply: the investor's September payout the
//                          dry run printed; any other result writes nothing
// Exit codes: 0 done (written, or already applied), 1 error (nothing written to
// the database), 2 refused (nothing written), 3 the database is written but a
// PDF was not re-rendered (run the same --apply again to re-render).
//
// Required as a module (by its test runner) it runs nothing and exports its
// parts.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { parseArgs, sheetFor, envFor, dbScope } = require("./lib/ledger-world");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:data-fix-september-sunday-invoices";
const SYSTEM_USER = Object.freeze({ id: 0, username: ACTOR, role: "system" });
const REF = "SSI-2026-09";
// The October-credit data fix (#444) for the same two Sundays, cancelled by the
// client on 2026-10-09. Anything it wrote means a day may be taken back twice.
const OCTOBER_CREDIT_ACTOR = "script:data-fix-sunday-pay-days";
const OPTIONS = ["db", "sheet-id", "values-json", "env-file", "data-dir", "key", "dry-run", "apply", "expect-payout"];
// The invoice template's week: Saturday to Friday.
const INVOICE_WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The correction, as the client decided it. The driver is not named here (this
// repository is public): it is read from the invoices, which must agree.
const CORRECTION = Object.freeze({
	period: "2026-09",
	reason: "Client-requested correction: Sundays 9/13 and 9/27 were not worked (INV-SK-2026W37-01, INV-SK-2026W39-01)",
	ownerId: 5,
	invoices: Object.freeze([
		Object.freeze({ invoiceNumber: "INV-SK-2026W37-01", day: "2026-09-13", load: "567844619" }),
		Object.freeze({ invoiceNumber: "INV-SK-2026W39-01", day: "2026-09-27", load: "569820951" }),
	]),
});

const REOPEN_HEAD = 'app.post("/api/periods/:period/reopen", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const EXCLUDE_HEAD = 'app.post("/api/admin/excluded-days", requireRole("Super Admin"), async (req, res) => {';
// assertInvoiceFileStillOwn is named although rerenderInvoicePdfFromStoredData
// calls it: in server.js its call follows a comment ending in ".", which
// closure() reads as a property access and so does not follow.
const ROOTS = ["finalizePeriods", "computeFleetLedger", "rerenderInvoicePdfFromStoredData", "assertInvoiceFileStillOwn", "installPeriodLockTriggers", "logAudit", "parseSheet", "deduplicateLoads", "financialsSettings", "closedMonthSettings"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "notifyChange", "getJobTrackingCached", "jtCacheInvalidate", "fetch", "DATA_DIR", "REPLICA"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive"];
// What the lifted code may require: Node's path, fs and crypto, the PDF
// libraries the invoice renderer uses, and the app's own lib/.
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "fs", "pdfkit", "pdf-lib"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);

class Refusal extends Error {}

const usd = (v) => {
	const n = Math.round(Number(v || 0) * 100) / 100;
	return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const cents = (v) => Math.round(Number(v || 0) * 100);
const weekdayOf = (day) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
const shortDay = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

// One invoice's correction: { state, why, row, before, after, renderData }.
//   state "correct": the day is on the invoice as billed; `after` and
//     `renderData` (the corrected snapshot, as stored JSON) say what it becomes.
//   state "done": the day is already off the invoice and this script's audit row
//     for it exists (`applied`).
//   state "skip": anything else, with why. Never guessed.
function invoiceCorrection(row, target, { applied = false } = {}) {
	const skip = (why) => ({ state: "skip", why, row: row || null });
	if (!row) return skip(`${target.invoiceNumber} was not found`);
	if (row.deleted_at) return skip(`${target.invoiceNumber} is deleted`);
	if (Number(row.is_manual)) return skip(`${target.invoiceNumber} is a manual invoice`);
	if (row.paid_at || ["Paid", "Processing"].includes(row.status)) return skip(`${target.invoiceNumber} is ${row.paid_at ? "paid" : row.status}; a paid invoice is corrected in the open month`);
	if (!["Draft", "Submitted", "Approved"].includes(row.status)) return skip(`${target.invoiceNumber} is ${row.status}`);
	if (Number(row.adjustment || 0) !== 0) return skip(`${target.invoiceNumber} carries an adjustment (${usd(row.adjustment)}); the day may have been corrected by hand`);
	if (!(row.week_start <= target.day && target.day <= row.week_end)) return skip(`${target.day} is not in ${target.invoiceNumber}'s week (${row.week_start} to ${row.week_end})`);
	const render = parseJson(row.render_data || "", null);
	if (!render || render.__templateName !== "service_invoice" || !render.days || typeof render.days !== "object") {
		return skip(`${target.invoiceNumber} has no day-rate render snapshot to correct`);
	}
	const weekday = weekdayOf(target.day);
	if (weekday !== "Sunday") return skip(`${target.day} is a ${weekday}, not a Sunday`);
	const rate = Number(row.rate_per_load);
	if (!(rate > 0)) return skip(`${target.invoiceNumber} has no daily rate`);
	const billed = INVOICE_WEEK.filter((d) => render.days[d] && render.days[d].completed);
	const gridCents = INVOICE_WEEK.reduce((s, d) => s + cents(render.days[d] ? render.days[d].total : 0), 0);
	const consistent = billed.length === Number(row.loads_count) && gridCents === cents(row.total_earnings)
		&& cents(render.totalDue) === cents(row.total_earnings) && cents(row.total_earnings) === cents(Number(row.loads_count) * rate)
		&& billed.every((d) => cents(render.days[d].total) === cents(rate));
	if (!consistent) {
		return skip(`${target.invoiceNumber}'s day lines (${billed.length} day(s), ${usd(gridCents / 100)}), Total Due (${usd(render.totalDue)}) and stored total (${row.loads_count} x ${usd(rate)} = ${usd(row.total_earnings)}) do not agree`);
	}
	const line = render.days[weekday];
	const before = { days: billed, loadsCount: Number(row.loads_count), total: Number(row.total_earnings), rate };
	if (!line.completed) {
		if (cents(line.total) !== 0) return skip(`${target.invoiceNumber}'s ${weekday} line is not billed but carries ${usd(line.total)}`);
		return applied ? { state: "done", row, before, after: before } : skip(`${target.invoiceNumber} does not bill ${weekday} ${shortDay(target.day)}, and this script did not take it off`);
	}
	const loads = String(line.loadBol || "").split(",").map((s) => s.trim()).filter(Boolean);
	if (!loads.includes(target.load)) return skip(`${target.invoiceNumber}'s ${weekday} line names load(s) ${loads.join(", ") || "none"}, not ${target.load}`);
	const days = { ...render.days, [weekday]: { loadBol: "", total: 0, completed: false } };
	const total = Math.round((before.total - rate) * 100) / 100;
	const renderData = JSON.stringify({ ...render, days, totalDue: total });
	const after = { days: billed.filter((d) => d !== weekday), loadsCount: before.loadsCount - 1, total, rate };
	return { state: "correct", row, before, after, renderData, weekday, loads };
}

// Everything September is, as compareable values. `invoiceIds` are the invoices
// being corrected (their rows are compared field by field; the others whole).
function septemberState(db, period) {
	const first = `${period}-01`;
	const last = `${period}-31`;
	const all = (sql, ...p) => db.prepare(sql).all(...p);
	const one = (sql, ...p) => db.prepare(sql).get(...p);
	const expensePeriod = "substr(COALESCE(NULLIF(date, ''), created_at), 1, 7)";
	return {
		lock: one("SELECT period, status, finalized_at, finalized_by, reopened_at, reopened_by, reopen_reason FROM period_locks WHERE period = ?", period) || null,
		payouts: all(`SELECT id, owner_id, amount, due_date, status, processed_at, paid_at, notes, adjustment, adjustment_note,
			reopened_at, reopen_reason, finalized_at, finalized_amount, finalized_breakdown, statement_pdf_file_name
			FROM investor_payouts WHERE period = ? ORDER BY owner_id`, period),
		items: all(`SELECT owner_id, kind, adjusts, day, cents, load_id, driver, truck, expense_id, source_id, expense_type, pay_type,
			pickup_state, delivery_state FROM financials_ledger_items WHERE period = ?`, period).map((r) => JSON.stringify(r)).sort(),
		freezes: all("SELECT source, frozen_by, item_count, summary, settings FROM financials_ledger_freezes WHERE period = ? AND released_at = ''", period),
		invoices: all("SELECT * FROM invoices WHERE week_start <= ? AND week_end >= ? ORDER BY id", last, first),
		excluded: all("SELECT driver_name, excluded_date, COALESCE(action, 'remove') AS action, reason, excluded_by FROM excluded_driver_days WHERE substr(excluded_date, 1, 7) = ? ORDER BY driver_name, excluded_date", period),
		// Hashes of what must not move at all.
		unchanged: {
			receipts: sha(all(`SELECT * FROM expenses WHERE ${expensePeriod} = ? OR COALESCE(posted_period, '') = ? ORDER BY id`, period, period)),
			maintenanceFund: sha(all("SELECT * FROM maintenance_fund WHERE strftime('%Y-%m', COALESCE(NULLIF(date, ''), strftime('%Y-%m-%d', created_at))) = ? ORDER BY id", period)),
			complianceFees: sha(all("SELECT * FROM compliance_fees WHERE strftime('%Y-%m', COALESCE(NULLIF(paid_date, ''), NULLIF(due_date, ''), strftime('%Y-%m-%d', created_at))) = ? ORDER BY id", period)),
			otherMonthsPayouts: sha(all("SELECT * FROM investor_payouts WHERE period != ? ORDER BY id", period)),
			otherMonthsItems: sha(all("SELECT * FROM financials_ledger_items WHERE period != ? ORDER BY id", period)),
			otherMonthsFreezes: sha(all("SELECT * FROM financials_ledger_freezes WHERE period != ? ORDER BY freeze_id", period)),
			otherMonthsLocks: sha(all("SELECT * FROM period_locks WHERE period != ? ORDER BY period", period)),
			otherInvoices: sha(all("SELECT * FROM invoices WHERE NOT (week_start <= ? AND week_end >= ?) ORDER BY id", last, first)),
			otherOverrides: sha(all("SELECT id, driver_name, excluded_date, reason, excluded_by, action FROM excluded_driver_days WHERE substr(excluded_date, 1, 7) != ? ORDER BY id", period)),
			trucksAndPay: sha([all("SELECT * FROM trucks ORDER BY id"), all("SELECT * FROM truck_assignments ORDER BY id"), all("SELECT * FROM drivers_directory ORDER BY id"), all("SELECT * FROM investor_config ORDER BY owner_id, key")]),
		},
	};
}

// The figures of an investor's settled breakdown, in cents.
const FIGURES = ["revenue", "driverPay", "fixedCosts", "tripExpenses", "maintFundCost", "complianceCost", "netProfit"];

// What changed in September between `before` and `after`, judged against what
// the correction may change: `corrected` is [{ id, weekday }] (the invoices),
// `removed` the frozen items the overrides take out (JSON strings, as in
// septemberState().items), `ownerId` the investor whose payout follows,
// `overrides` the override rows the run adds. Returns { ok, problems, changes }.
function compareSeptember(before, after, { corrected, removed, ownerId, overrides, reason }) {
	const problems = [];
	const changes = [];
	// Invoices: the same rows; the corrected ones change in loads_count,
	// total_earnings and their snapshot's day line and Total Due only.
	const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
	const bInv = byId(before.invoices);
	const aInv = byId(after.invoices);
	if (bInv.size !== aInv.size || [...bInv.keys()].some((id) => !aInv.has(id))) problems.push("the set of invoices touching September changed");
	for (const [id, b] of bInv) {
		const a = aInv.get(id);
		if (!a) continue;
		const fix = corrected.find((c) => c.id === id);
		if (!fix) {
			if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`invoice ${b.invoice_number} changed`);
			continue;
		}
		for (const k of Object.keys(b)) {
			if (["loads_count", "total_earnings", "render_data"].includes(k)) continue;
			if (String(a[k]) !== String(b[k])) problems.push(`invoice ${b.invoice_number}: ${k} changed`);
		}
		const br = parseJson(b.render_data, {});
		const ar = parseJson(a.render_data, {});
		const strip = (r) => { const c = { ...r, days: { ...r.days } }; delete c.days[fix.weekday]; delete c.totalDue; return JSON.stringify(c); };
		if (strip(br) !== strip(ar)) problems.push(`invoice ${b.invoice_number}: its snapshot changed beyond the ${fix.weekday} line and Total Due`);
		const rate = Number(b.rate_per_load);
		const ok = ar.days && ar.days[fix.weekday] && !ar.days[fix.weekday].completed && cents(ar.days[fix.weekday].total) === 0
			&& Number(a.loads_count) === Number(b.loads_count) - 1
			&& cents(a.total_earnings) === cents(b.total_earnings) - cents(rate) && cents(ar.totalDue) === cents(a.total_earnings);
		if (!ok) problems.push(`invoice ${b.invoice_number}: not corrected as expected`);
		changes.push({ what: "invoice", invoiceNumber: b.invoice_number, status: b.status, before: { days: Number(b.loads_count), total: Number(b.total_earnings) }, after: { days: Number(a.loads_count), total: Number(a.total_earnings) } });
	}
	// Frozen items: exactly the removed ones go; every other is identical.
	const remaining = [...before.items];
	for (const r of removed) {
		const i = remaining.indexOf(r);
		if (i === -1) problems.push(`a removed item was not among September's frozen items: ${r}`);
		else remaining.splice(i, 1);
	}
	if (JSON.stringify(remaining) !== JSON.stringify(after.items)) {
		const a = [...after.items];
		const gone = remaining.filter((x) => { const i = a.indexOf(x); if (i === -1) return true; a.splice(i, 1); return false; });
		problems.push(`September's frozen items differ beyond the two days: ${gone.length} missing, ${a.length} new${gone.length ? `; missing: ${gone.slice(0, 5).join(" | ")}` : ""}${a.length ? `; new: ${a.slice(0, 5).join(" | ")}` : ""}`);
	}
	const removedCents = removed.reduce((s, r) => s + Number(JSON.parse(r).cents), 0);
	changes.push({ what: "items", before: before.items.length, after: after.items.length, removed: removed.map((r) => JSON.parse(r)) });
	// The active freeze: one before and after, the same settings, figures moved
	// by the removed driver pay only.
	if (before.freezes.length !== 1 || after.freezes.length !== 1) problems.push(`September has ${before.freezes.length} active freeze(s) before and ${after.freezes.length} after, not one`);
	else {
		const bs = parseJson(before.freezes[0].summary, {});
		const as = parseJson(after.freezes[0].summary, {});
		for (const k of FIGURES) {
			const want = cents(bs[k]) + (k === "driverPay" ? -removedCents : k === "netProfit" ? removedCents : 0);
			if (cents(as[k]) !== want) problems.push(`September's Financials ${k} is ${usd(as[k])}, expected ${usd(want / 100)}`);
		}
		if (before.freezes[0].settings !== after.freezes[0].settings) problems.push("September's Financials settings changed");
		if (Number(after.freezes[0].item_count) !== Number(before.freezes[0].item_count) - removed.length) problems.push("September's frozen item count is not the old count less the two days");
		changes.push({ what: "financials", before: bs, after: as });
	}
	// Payout rows: the same rows; the investor's moves by the removed driver pay
	// (its driver pay and net profit, and the payout the close computes from
	// them); every other row identical but for the close's new stamp.
	const bPay = new Map(before.payouts.map((r) => [r.owner_id, r]));
	const aPay = new Map(after.payouts.map((r) => [r.owner_id, r]));
	if (bPay.size !== aPay.size || [...bPay.keys()].some((o) => !aPay.has(o))) problems.push("the set of September payout rows changed");
	for (const [owner, b] of bPay) {
		const a = aPay.get(owner);
		if (!a) continue;
		if (!a.finalized_at) problems.push(`owner ${owner}'s September payout is not finalized after the run`);
		for (const k of ["id", "due_date", "status", "processed_at", "paid_at", "notes", "adjustment", "adjustment_note", "reopened_at", "reopen_reason", "statement_pdf_file_name"]) {
			if (String(a[k]) !== String(b[k])) problems.push(`owner ${owner}'s September payout: ${k} changed`);
		}
		const bb = parseJson(b.finalized_breakdown, null);
		const ab = parseJson(a.finalized_breakdown, null);
		if (owner !== ownerId) {
			if (cents(a.amount) !== cents(b.amount) || cents(a.finalized_amount) !== cents(b.finalized_amount) || JSON.stringify(ab) !== JSON.stringify(bb)) {
				problems.push(`owner ${owner}'s September payout changed (${usd(b.amount)} to ${usd(a.amount)})`);
			}
			continue;
		}
		if (!bb || !ab) { problems.push(`owner ${owner}'s September payout has no settled breakdown to compare`); continue; }
		for (const k of FIGURES) {
			const want = cents(bb[k]) + (k === "driverPay" ? -removedCents : k === "netProfit" ? removedCents : 0);
			if (cents(ab[k]) !== want) problems.push(`owner ${owner}'s September ${k} is ${usd(ab[k])}, expected ${usd(want / 100)}`);
		}
		for (const k of ["splitPct", "lossCarriedIn", "lossDeferred"]) if (String(ab[k]) !== String(bb[k])) problems.push(`owner ${owner}'s September ${k} changed`);
		if (cents(a.amount) !== cents(a.finalized_amount)) problems.push(`owner ${owner}'s September payout amount and finalized amount differ`);
		if (cents(a.amount) < cents(b.amount)) problems.push(`owner ${owner}'s September payout went down although driver pay was taken off`);
		// With no loss carried in or deferred, the payout is the month's share: it
		// moves by the removed pay times the split, within the share's rounding to
		// the dollar.
		if (!Number(bb.lossCarriedIn) && !Number(bb.lossDeferred) && !Number(ab.lossCarriedIn) && !Number(ab.lossDeferred)) {
			if (cents(a.amount) !== cents(ab.monthShare) || cents(b.amount) !== cents(bb.monthShare)) problems.push(`owner ${owner}'s September payout is not the month's share`);
			const want = removedCents * Number(ab.splitPct) / 100;
			if (Math.abs(cents(a.amount) - cents(b.amount) - want) > 100) problems.push(`owner ${owner}'s September payout moved by ${usd((cents(a.amount) - cents(b.amount)) / 100)}, not by about ${usd(want / 100)} (${ab.splitPct}% of the removed pay)`);
		}
		changes.push({ what: "payout", ownerId: owner, id: a.id, before: { amount: Number(b.amount), breakdown: bb }, after: { amount: Number(a.amount), breakdown: ab } });
	}
	// Overrides: the run's, and no other.
	const key = (r) => `${r.driver_name}|${r.excluded_date}|${r.action}`;
	const want = [...before.excluded.map(key), ...overrides.map(key)].sort();
	if (JSON.stringify(after.excluded.map(key).sort()) !== JSON.stringify(want)) problems.push("September's driver-day overrides are not the old ones plus the two Sundays");
	// The lock: finalized again, the reopen on record.
	if (!after.lock || after.lock.status !== "locked") problems.push("September is not finalized after the run");
	else if (after.lock.reopen_reason !== reason) problems.push("September's lock does not carry this correction's reopen reason");
	for (const [k, v] of Object.entries(before.unchanged)) if (after.unchanged[k] !== v) problems.push(`${k} changed`);
	return { ok: problems.length === 0, problems, changes };
}

// The driver's pay in September: the frozen driver-pay items naming the driver.
function driverPayIn(items, driver) {
	return items.map((s) => JSON.parse(s)).filter((i) => i.kind === "driver_pay" && i.driver === driver).reduce((s, i) => s + Number(i.cents), 0) / 100;
}

// The lifted server code, on its own handle (see the header).
function buildWorld({ dbFile, sheetData, env, dataDir }) {
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const Database = appRequire("better-sqlite3");
	const db = new Database(dbFile, { fileMustExist: true });
	db.pragma("busy_timeout = 10000");
	const lifted = closure(SRC, { roots: ROOTS, routes: [REOPEN_HEAD, EXCLUDE_HEAD], provided: PROVIDED, denied: DENIED });
	const routes = {};
	const register = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
	const app = { get: register("GET"), post: register("POST"), put: register("PUT"), delete: register("DELETE") };
	const pass = () => (req, res, next) => next && next();
	const scriptProcess = { env: { ...env }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this script makes no network calls"); };
	const body = [
		'"use strict";',
		lifted.text,
		"let _scriptJobTracking = null;",
		"async function getJobTrackingCached() {",
		"\tif (!_scriptJobTracking) {",
		"\t\tconst parsed = parseSheet(__sheetData);",
		"\t\tparsed.data = deduplicateLoads(parsed.data, parsed.headers);",
		"\t\t_scriptJobTracking = parsed;",
		"\t}",
		"\treturn _scriptJobTracking;",
		"}",
		// One sheet snapshot for the whole run; nothing here writes the sheet.
		"function jtCacheInvalidate() {}",
		"return { finalizePeriods, computeFleetLedger, rerenderInvoicePdfFromStoredData, installPeriodLockTriggers, logAudit, financialsSettings, closedMonthSettings };",
	].join("\n");
	const api = new Function("db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "notifyChange", "fetch", "DATA_DIR", "REPLICA", "__sheetData", body)(
		db, liftedRequire, console, scriptProcess, ROOT, app, pass, pass(), () => {}, noFetch, dataDir, null, sheetData,
	);
	const call = async (route, req) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
		await routes[route]({ headers: {}, ip: "", get: () => "", params: {}, body: {}, session: { user: { ...SYSTEM_USER } }, ...req }, res);
		return out;
	};
	return { db, api, call, appRequire };
}

function audit(db, action, entity, entityId, details) {
	db.prepare("INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, ?, ?, ?)")
		.run(new Date().toISOString(), ACTOR, action, entity, String(entityId), details);
}

// This script's audit row for an invoice correction, if it was written.
function invoiceTokenWritten(db, row) {
	return !!db.prepare("SELECT 1 FROM audit_trail WHERE username = ? AND user_id = 0 AND role = 'system' AND action = 'correct_invoice' AND entity = 'invoice' AND entity_id = ? AND details LIKE ? LIMIT 1")
		.get(ACTOR, String(row.id), `%[${REF}]%`);
}

// What the run would do, read from the database as it stands. Throws Refusal.
function plan(db, api) {
	const period = CORRECTION.period;
	const lock = db.prepare("SELECT * FROM period_locks WHERE period = ?").get(period);
	if (!lock) throw new Refusal(`${period} is not finalized`);
	const ours = lock.reopen_reason === CORRECTION.reason;
	if (lock.status !== "locked") throw new Refusal(`${period} is ${lock.status}${ours ? " by this correction but not finalized again" : ""}; this script reopens and finalizes it itself`);
	const finishedBefore = ours && lock.finalized_by === ACTOR;
	const rows = CORRECTION.invoices.map((t) => db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(t.invoiceNumber));
	const fixes = CORRECTION.invoices.map((t, i) => ({ target: t, ...invoiceCorrection(rows[i], t, { applied: !!rows[i] && invoiceTokenWritten(db, rows[i]) }) }));
	const skipped = fixes.filter((f) => f.state === "skip");
	if (skipped.length) throw new Refusal(skipped.map((f) => f.why).join("; "));
	const drivers = [...new Set(fixes.map((f) => String(f.row.driver || "").trim().toLowerCase()))];
	if (drivers.length !== 1 || !drivers[0]) throw new Refusal("the two invoices are not the same driver's");
	const driver = drivers[0];
	const done = fixes.filter((f) => f.state === "done").length;
	const overrides = fixes.map((f) => ({
		driver_name: driver, excluded_date: f.target.day, action: "remove",
		reason: `Client-requested correction: ${weekdayOf(f.target.day)} ${shortDay(f.target.day)} was not worked (${f.target.invoiceNumber}) [${REF}]`,
	}));
	const existing = overrides.map((o) => db.prepare("SELECT driver_name, excluded_date, COALESCE(action, 'remove') AS action, reason, excluded_by FROM excluded_driver_days WHERE lower(trim(driver_name)) = ? AND excluded_date = ?").all(driver, o.excluded_date));
	const oursExisting = existing.map((rs, i) => rs.length === 1 && rs[0].action === "remove" && rs[0].reason === overrides[i].reason && rs[0].excluded_by === ACTOR);
	existing.forEach((rs, i) => {
		if (rs.length && !oursExisting[i]) throw new Refusal(`${overrides[i].excluded_date} already has a driver-day override this script did not write (${rs.map((r) => `${r.action} by ${r.excluded_by || "?"}`).join(", ")})`);
	});
	if (done === fixes.length && oursExisting.every(Boolean) && finishedBefore) return { alreadyApplied: true, fixes, driver };
	if (done || oursExisting.some(Boolean) || finishedBefore) throw new Refusal("part of this correction is on record and part is not; nothing was written. Check the audit trail before going further");
	// An earlier correction of the same days anywhere else would take a day back
	// twice: anything the October-credit data fix wrote, or an adjustment on any
	// of the driver's invoices from the first corrected week on, or on the
	// investor's payout rows from September on (the corrected invoices' own
	// adjustments are refused by invoiceCorrection()).
	const earlier = [];
	const credit = db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE username = ? OR details LIKE ?").get(OCTOBER_CREDIT_ACTOR, "%[SPD-2026%").n;
	if (credit) earlier.push(`${credit} audit row(s) of the October-credit data fix (${OCTOBER_CREDIT_ACTOR})`);
	for (const t of ["invoices", "investor_payouts"]) {
		const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE COALESCE(adjustment_note, '') LIKE ?`).get("%SPD-2026%").n;
		if (n) earlier.push(`${n} ${t} row(s) whose adjustment note names the October-credit data fix`);
	}
	const firstWeek = fixes.map((f) => f.row.week_start).sort()[0];
	for (const r of db.prepare("SELECT invoice_number, adjustment FROM invoices WHERE lower(trim(driver)) = ? AND week_end >= ? AND COALESCE(deleted_at, '') = '' AND COALESCE(adjustment, 0) != 0 ORDER BY week_start").all(driver, firstWeek)) {
		earlier.push(`${r.invoice_number} carries an adjustment of ${usd(r.adjustment)}`);
	}
	for (const r of db.prepare("SELECT period, adjustment FROM investor_payouts WHERE owner_id = ? AND period >= ? AND COALESCE(adjustment, 0) != 0 ORDER BY period").all(CORRECTION.ownerId, period)) {
		earlier.push(`owner ${CORRECTION.ownerId}'s ${r.period} payout carries an adjustment of ${usd(r.adjustment)}`);
	}
	if (earlier.length) throw new Refusal(`a correction of these days may already be on record, so nothing was written: ${earlier.join("; ")}`);
	// Each PDF is re-rendered into the file its row names, which must be its own.
	for (const f of fixes) {
		if (!f.row.pdf_file_name) throw new Refusal(`${f.target.invoiceNumber} names no PDF file`);
		const sharers = db.prepare("SELECT invoice_number FROM invoices WHERE pdf_file_name = ? COLLATE NOCASE AND id != ?").all(f.row.pdf_file_name, f.row.id);
		if (sharers.length) throw new Refusal(`${f.target.invoiceNumber}'s PDF file is also ${sharers.map((r) => r.invoice_number).join(", ")}'s`);
	}
	// The frozen day each override takes out: the driver's driver-pay item that
	// day, at the invoice's rate.
	const items = db.prepare("SELECT * FROM financials_ledger_items WHERE period = ? AND kind = 'driver_pay' AND driver = ?").all(period, driver);
	const removed = fixes.map((f) => {
		const hits = items.filter((i) => i.day === f.target.day);
		if (hits.length !== 1) throw new Refusal(`September's frozen ledger holds ${hits.length} driver-pay item(s) for the driver on ${f.target.day}, not one`);
		if (cents(hits[0].cents / 100) !== cents(f.before.rate)) throw new Refusal(`September's frozen ${f.target.day} is ${usd(hits[0].cents / 100)}, but ${f.target.invoiceNumber} bills ${usd(f.before.rate)}`);
		if (Number(hits[0].owner_id) !== CORRECTION.ownerId) throw new Refusal(`September's frozen ${f.target.day} is owner ${hits[0].owner_id}'s, not owner ${CORRECTION.ownerId}'s`);
		const { id, period: _p, freeze_id: _f, frozen_at: _a, ...content } = hits[0];
		return JSON.stringify(content);
	});
	const payout = db.prepare("SELECT * FROM investor_payouts WHERE owner_id = ? AND period = ?").get(CORRECTION.ownerId, period);
	if (!payout) throw new Refusal(`owner ${CORRECTION.ownerId} has no September payout row`);
	if (payout.status !== "owed" || payout.paid_at) throw new Refusal(`owner ${CORRECTION.ownerId}'s September payout is ${payout.status}; a paid payout is corrected in the open month, not by this script`);
	const freeze = db.prepare("SELECT settings FROM financials_ledger_freezes WHERE period = ? AND released_at = ''").get(period);
	if (!freeze) throw new Refusal("September has no active Financials freeze");
	const closedWith = api.closedMonthSettings().get(period);
	if (JSON.stringify(closedWith) !== JSON.stringify(api.financialsSettings())) throw new Refusal("the Financials settings changed since September closed; finalizing again would freeze it under different settings");
	return { alreadyApplied: false, lock, fixes, driver, overrides, removed, payout };
}

// SQLite's online backup of the database next to it, owner-only,
// self-contained and integrity-checked (scripts/freeze-closed-months.js).
async function backupNextTo(dbPath, db, Database) {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const target = `${dbPath}.pre-sunday-invoices-${stamp}`;
	await copyDatabase(db, target, Database);
	return target;
}

async function copyDatabase(db, target, Database) {
	const src = db.name;
	const size = fs.statSync(src).size + (fs.existsSync(`${src}-wal`) ? fs.statSync(`${src}-wal`).size : 0);
	const s = fs.statfsSync(path.dirname(path.resolve(target)));
	if (s.bavail * s.bsize < size * 2) throw new Refusal(`not enough free disk for a copy of the database (${s.bavail * s.bsize} bytes free, the database is ${size})`);
	let taken = true;
	try { fs.lstatSync(target); } catch (err) { if (err.code === "ENOENT") taken = false; else throw err; }
	if (taken) throw new Refusal(`${target} already exists`);
	await db.backup(target, { progress: () => 0x7fffffff });
	fs.chmodSync(target, 0o600);
	const copy = new Database(target, { fileMustExist: true });
	copy.pragma("journal_mode = DELETE");
	const ok = copy.pragma("integrity_check", { simple: true });
	copy.close();
	if (ok !== "ok") throw new Refusal(`the copy at ${target} failed its integrity check (${ok})`);
	if (fs.existsSync(`${target}-wal`) || fs.existsSync(`${target}-shm`)) throw new Refusal(`the copy at ${target} left -wal/-shm files beside it`);
}

// What a plan was made from: the rows it read. A plan made again inside the
// transaction must match it, or something changed in between.
function planFingerprint(p) {
	return sha([p.lock, p.fixes.map((f) => f.row), p.overrides, p.removed, p.payout]);
}

// Steps 1 to 5 of the header, in one transaction. Returns what changed. Throws
// (and rolls back) on anything unexpected. `expectPayout` (an apply's
// --expect-payout, the dry run's figure) is the investor's September payout the
// run must arrive at, or nothing is written.
async function correct(world, p, { expectPayout = null } = {}) {
	const { db, api, call } = world;
	const period = CORRECTION.period;
	const log = [];
	api.installPeriodLockTriggers(db);
	// The fleet's ELD travel days, read once before the transaction into the
	// same cache the close reads them through (as the server's warm-up does), so
	// the database is held for writing only while the close computes and writes.
	await api.computeFleetLedger();
	const started = Date.now();
	db.exec("BEGIN IMMEDIATE");
	// A write that fails inside lifted code that swallows its error (an audit
	// row) can end the transaction; every later step checks it is still open.
	const open = (step) => { if (!db.inTransaction) throw new Error(`the transaction ended during ${step}; check the database before going further`); };
	let result;
	try {
		// Checked again, and September read, with the database held: nothing can
		// move between the checks, the comparison's "before" and the writes.
		if (planFingerprint(plan(db, api)) !== planFingerprint(p)) throw new Refusal("the invoices, payout or September changed after they were checked; run again");
		const before = septemberState(db, period);
		const auditFrom = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_trail").get().id;
		const historyFrom = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM investor_payout_history").get().id;
		const reopened = await call("POST /api/periods/:period/reopen", { params: { period }, body: { reason: CORRECTION.reason } });
		if (reopened.status !== 200) throw new Refusal(`reopening ${period} answered ${reopened.status}: ${JSON.stringify(reopened.body)}`);
		open("the reopen");
		log.push(`Reopened ${period} with the reason "${CORRECTION.reason}" (${reopened.body.relinkedOwedRows} owed payout row(s) re-linked to live earnings).`);
		for (const o of p.overrides) {
			const r = await call("POST /api/admin/excluded-days", { body: { driverName: o.driver_name, date: o.excluded_date, reason: o.reason, action: "remove" } });
			if (r.status !== 200 || !r.body || !r.body.inserted) throw new Refusal(`excluding ${o.excluded_date} answered ${r.status}: ${JSON.stringify(r.body)}`);
			open(`the override for ${o.excluded_date}`);
			log.push(`Excluded ${weekdayOf(o.excluded_date)} ${o.excluded_date} from the driver's pay (driver-day override #${r.body.row.id}, "remove").`);
		}
		for (const f of p.fixes) {
			const n = db.prepare(`UPDATE invoices SET loads_count = ?, total_earnings = ?, render_data = ?
				WHERE id = ? AND render_data = ? AND total_earnings = ? AND loads_count = ? AND status = ?
					AND COALESCE(paid_at, '') = '' AND COALESCE(adjustment, 0) = 0 AND COALESCE(deleted_at, '') = ''`)
				.run(f.after.loadsCount, f.after.total, f.renderData, f.row.id, f.row.render_data, f.row.total_earnings, f.row.loads_count, f.row.status).changes;
			if (n !== 1) throw new Refusal(`${f.target.invoiceNumber} changed while it was being corrected`);
			audit(db, "correct_invoice", "invoice", f.row.id,
				`${f.row.status === "Approved" ? "POST-APPROVAL correction (status Approved): " : ""}${f.target.invoiceNumber}: ${weekdayOf(f.target.day)} ${f.target.day} removed (not worked; load ${f.target.load}); ` +
				`${f.before.loadsCount} day(s) ${usd(f.before.total)} -> ${f.after.loadsCount} day(s) ${usd(f.after.total)}; regenerated in place, same number. ${CORRECTION.reason} [${REF}]`);
			open(`the correction of ${f.target.invoiceNumber}`);
			log.push(`Corrected ${f.target.invoiceNumber} in place: ${f.before.loadsCount} days ${usd(f.before.total)} -> ${f.after.loadsCount} days ${usd(f.after.total)} (${f.after.days.map((d) => d.slice(0, 3)).join(", ")}).`);
		}
		const closed = await api.finalizePeriods([period], ACTOR);
		if (closed.retry || !closed.periods.includes(period)) throw new Refusal(`finalizing ${period} again did not close it (${closed.reason || "nothing closed"})`);
		audit(db, "period_finalize", "period", period, `Finalized ${period} again after the client-requested correction (${closed.stamped} payout row(s) frozen) [${REF}]`);
		open("the close");
		log.push(`Finalized ${period} again (${closed.stamped} payout row(s) stamped, Financials items frozen, lock taken).`);
		const after = septemberState(db, period);
		const cmp = compareSeptember(before, after, {
			corrected: p.fixes.map((f) => ({ id: f.row.id, weekday: f.weekday })), removed: p.removed, ownerId: CORRECTION.ownerId, overrides: p.overrides, reason: CORRECTION.reason,
		});
		if (!cmp.ok) throw new Refusal(`September changed beyond the correction, so nothing was written:\n  - ${cmp.problems.join("\n  - ")}`);
		const pay = cmp.changes.find((c) => c.what === "payout" && c.ownerId === CORRECTION.ownerId);
		if (expectPayout !== null && cents(pay.after.amount) !== cents(expectPayout)) {
			throw new Refusal(`owner ${CORRECTION.ownerId}'s September payout came to ${usd(pay.after.amount)}, not the ${usd(expectPayout)} --expect-payout names, so nothing was written`);
		}
		audit(db, "data_fix", "period", period,
			`${CORRECTION.reason}: driver pay ${usd(driverPayIn(before.items, p.driver))} -> ${usd(driverPayIn(after.items, p.driver))}; ` +
			`owner ${CORRECTION.ownerId}'s September payout ${usd(pay.before.amount)} -> ${usd(pay.after.amount)} (row ${pay.id}); ` +
			`${p.fixes.map((f) => `${f.target.invoiceNumber} ${usd(f.before.total)} -> ${usd(f.after.total)}`).join("; ")} [${REF}]`);
		const audits = db.prepare("SELECT action, username, role, entity, entity_id FROM audit_trail WHERE id > ? ORDER BY id").all(auditFrom);
		const history = db.prepare("SELECT owner_id, period, kind, old_amount, new_amount FROM investor_payout_history WHERE id > ? ORDER BY id").all(historyFrom);
		if (history.some((h) => h.period !== period)) throw new Refusal("the run recorded a payout change outside September");
		open("the comparison");
		db.exec("COMMIT");
		result = { before, after, cmp, log, audits, history, lockedMs: Date.now() - started };
	} catch (err) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw err;
	}
	return result;
}

// Each corrected invoice's PDF, re-rendered from its stored snapshot by the
// server's own function. Returns the lines to print.
async function renderPdfs(world, fixes) {
	const out = [];
	for (const f of fixes) {
		const row = world.db.prepare("SELECT * FROM invoices WHERE id = ?").get(f.row.id);
		const mode = await world.api.rerenderInvoicePdfFromStoredData(row);
		out.push(`Re-rendered ${f.target.invoiceNumber}'s PDF (${row.pdf_file_name}, ${mode}).`);
	}
	return out;
}

function report(r, p) {
	const lines = [];
	const say = (s) => lines.push(s);
	say("September before and after:");
	for (const c of r.cmp.changes.filter((x) => x.what === "invoice")) {
		say(`- ${c.invoiceNumber} (${c.status}): ${c.before.days} days ${usd(c.before.total)} -> ${c.after.days} days ${usd(c.after.total)}`);
	}
	say(`- The driver's September pay (frozen driver-pay items): ${usd(driverPayIn(r.before.items, p.driver))} -> ${usd(driverPayIn(r.after.items, p.driver))}`);
	const pay = r.cmp.changes.find((c) => c.what === "payout" && c.ownerId === CORRECTION.ownerId);
	say(`- Owner ${CORRECTION.ownerId}'s September payout (row ${pay.id}): ${usd(pay.before.amount)} -> ${usd(pay.after.amount)}; ` +
		`driver pay ${usd(pay.before.breakdown.driverPay)} -> ${usd(pay.after.breakdown.driverPay)}, net profit ${usd(pay.before.breakdown.netProfit)} -> ${usd(pay.after.breakdown.netProfit)}, ` +
		`${pay.after.breakdown.splitPct}% share ${usd(pay.before.breakdown.monthShare)} -> ${usd(pay.after.breakdown.monthShare)}`);
	const items = r.cmp.changes.find((c) => c.what === "items");
	say(`- Frozen Financials items: ${items.before} -> ${items.after}; removed: ${items.removed.map((i) => `${i.kind} ${i.day} ${usd(i.cents / 100)} (load ${i.load_id}, ${i.truck})`).join("; ")}`);
	const fin = r.cmp.changes.find((c) => c.what === "financials");
	if (fin) say(`- September's Financials: revenue ${usd(fin.before.revenue)} -> ${usd(fin.after.revenue)}, driver pay ${usd(fin.before.driverPay)} -> ${usd(fin.after.driverPay)}, net profit ${usd(fin.before.netProfit)} -> ${usd(fin.after.netProfit)}`);
	const others = r.after.payouts.filter((x) => x.owner_id !== CORRECTION.ownerId);
	say(`- Other September payout rows: ${others.length}, unchanged (amount, status, breakdown); each carries the close's new finalized_at.`);
	say(`- Unchanged (compared): the other ${r.before.invoices.length - p.fixes.length} invoice(s) touching September, September's other ${r.before.items.length - items.removed.length} frozen items, September's receipts, maintenance-fund and compliance rows, every other month's payout rows, frozen items, freezes and locks, every invoice outside September, every other driver-day override, trucks, assignments, the drivers directory and the investor settings.`);
	say(`- September's lock: ${r.before.lock.status} (finalized ${r.before.lock.finalized_at} by ${r.before.lock.finalized_by}) -> ${r.after.lock.status} (finalized ${r.after.lock.finalized_at} by ${r.after.lock.finalized_by}; reopened ${r.after.lock.reopened_at} by ${r.after.lock.reopened_by})`);
	say(`Audit rows written: ${r.audits.map((a) => `${a.action} (${a.username}, ${a.role})`).join(", ")}`);
	say(`Payout history rows written: ${r.history.map((h) => `owner ${h.owner_id} ${h.period} ${h.kind} ${usd(h.old_amount)} -> ${usd(h.new_amount)}`).join("; ")}`);
	say(`The database was held for writing for ${r.lockedMs} ms.`);
	return lines.join("\n");
}

function describePlan(p) {
	const lines = [];
	for (const f of p.fixes) {
		lines.push(`- ${f.target.invoiceNumber} (invoice ${f.row.id}): ${f.row.status}, unpaid; week ${f.row.week_start} to ${f.row.week_end}; ` +
			`${f.before.loadsCount} days x ${usd(f.before.rate)} = ${usd(f.before.total)} (${f.before.days.map((d) => d.slice(0, 3)).join(", ")}); ` +
			`${f.weekday} ${shortDay(f.target.day)} billed ${usd(f.before.rate)} for load(s) ${f.loads.join(", ")}.`);
	}
	lines.push(`- Owner ${CORRECTION.ownerId}'s September payout (row ${p.payout.id}): ${p.payout.status}, unpaid, ${usd(p.payout.amount)} (finalized ${p.payout.finalized_at}).`);
	lines.push(`- ${CORRECTION.period}: finalized ${p.lock.finalized_at} by ${p.lock.finalized_by}; the Financials settings it closed with are today's.`);
	return lines.join("\n");
}

async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const unknown = Object.keys(args).filter((k) => !OPTIONS.includes(k));
	if (unknown.length) throw new Refusal(`unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}`);
	const dryRun = args["dry-run"] === true;
	const apply = args.apply === true;
	if (dryRun === apply) throw new Refusal("say --dry-run or --apply (one of them)");
	if (typeof args.db !== "string") throw new Refusal("--db is required");
	if (typeof args["sheet-id"] !== "string" && typeof args["values-json"] !== "string") throw new Refusal("--sheet-id (or --values-json) is required; there is no default sheet");
	let expectPayout = null;
	if (args["expect-payout"] !== undefined) {
		expectPayout = Number(args["expect-payout"]);
		if (typeof args["expect-payout"] !== "string" || !/^\d+(\.\d{1,2})?$/.test(args["expect-payout"]) || !Number.isFinite(expectPayout)) throw new Refusal("--expect-payout=<dollars> takes the dry run's payout, e.g. 5346.00");
	}
	if (apply && expectPayout === null) throw new Refusal("--apply needs --expect-payout=<the investor's September payout the dry run printed>");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let scope;
	try { scope = dbScope(args.db, ROOT); } catch (err) { throw new Refusal(err.message); }
	if (args["data-dir"] !== undefined && (scope.scope !== "copy" || typeof args["data-dir"] !== "string")) throw new Refusal("--data-dir=<dir> is only for a copy of the database under the temp directory");
	const { env, file: dbFile } = (() => { try { return envFor({ root: ROOT, dbPath: args.db, envFile }); } catch (err) { throw new Refusal(err.message); } })();
	const dataDir = typeof args["data-dir"] === "string" ? path.resolve(args["data-dir"]) : ROOT;
	process.umask(0o077);
	const sheetData = await sheetFor(args, ROOT);
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const Database = appRequire("better-sqlite3");
	const pdfBrowser = appRequire("./lib/pdf-browser");
	const say = (s) => console.log(s);
	say(`Data fix ${REF}: ${CORRECTION.reason}. Mode: ${dryRun ? "dry run (on a temporary copy; the database is not written)" : "apply"}.`);
	let tmpDir = null;
	let world = null;
	// An interrupted dry run deletes its copy of the database too.
	const onSignal = (sig) => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); console.error(`Stopped by ${sig}.`); process.exit(130); };
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, onSignal);
	try {
		let target = dbFile;
		let targetDataDir = dataDir;
		if (dryRun) {
			const live = new Database(dbFile, { readonly: true, fileMustExist: true });
			if (!live.readonly) throw new Refusal("the dry run's handle on the database is not read-only");
			tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sunday-invoices-dry-"));
			target = path.join(tmpDir, "app.db");
			try { await copyDatabase(live, target, Database); } finally { live.close(); }
			fs.mkdirSync(path.join(tmpDir, "uploads", "invoices"), { recursive: true });
			targetDataDir = tmpDir;
		}
		world = buildWorld({ dbFile: target, sheetData, env, dataDir: targetDataDir });
		if (dryRun) {
			for (const f of CORRECTION.invoices) {
				const row = world.db.prepare("SELECT pdf_file_name FROM invoices WHERE invoice_number = ?").get(f.invoiceNumber);
				const src = row && row.pdf_file_name ? path.join(dataDir, "uploads", "invoices", row.pdf_file_name) : "";
				if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDataDir, "uploads", "invoices", row.pdf_file_name));
			}
		}
		const p = plan(world.db, world.api);
		if (p.alreadyApplied) {
			say(`Already applied: both overrides, both corrected invoices and September finalized by ${ACTOR} are on record. Nothing was written to the database.`);
			if (apply) (await renderPdfs(world, p.fixes)).forEach((l) => say(l));
			return 0;
		}
		say("Checked:");
		say(describePlan(p));
		if (apply) say(`Backup: ${await backupNextTo(dbFile, world.db, Database)}`);
		const r = await correct(world, p, { expectPayout });
		say(dryRun ? "On the temporary copy (committed there):" : "Applied (committed):");
		r.log.forEach((l, i) => say(`${i + 1}. ${l}`));
		say(report(r, p));
		say(`Owner ${CORRECTION.ownerId}'s September payout after the correction: ${(r.cmp.changes.find((c) => c.what === "payout" && c.ownerId === CORRECTION.ownerId).after.amount).toFixed(2)} (--expect-payout for the apply).`);
		// The database is committed from here; a PDF that fails says so and how to
		// finish, and never reads as "nothing was written".
		try {
			(await renderPdfs(world, p.fixes)).forEach((l) => say(l));
		} catch (err) {
			console.error(`PDFS NOT RE-RENDERED: ${err.message}`);
			console.error(dryRun
				? "On the temporary copy the database step completed; only the PDF step failed."
				: "The database IS written (above). Do not restore the backup: run the same --apply again, which writes nothing more and re-renders the two PDFs.");
			return 3;
		}
		say(dryRun ? "Dry run: nothing was written to the database; the temporary copy is deleted." : "Done.");
		return 0;
	} finally {
		if (world) world.db.close();
		try { await pdfBrowser.shutdownBrowser(); } catch { /* no browser was started */ }
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	main().then((code) => process.exit(code)).catch((err) => {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`ERROR: ${err.stack || err.message}`);
		process.exit(1);
	});
}

module.exports = { CORRECTION, ACTOR, REF, OCTOBER_CREDIT_ACTOR, REOPEN_HEAD, EXCLUDE_HEAD, ROOTS, PROVIDED, DENIED, invoiceCorrection, plan, planFingerprint, septemberState, compareSeptember, driverPayIn, weekdayOf, Refusal };
