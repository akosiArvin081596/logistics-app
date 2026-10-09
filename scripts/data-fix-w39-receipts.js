#!/usr/bin/env node
// scripts/data-fix-w39-receipts.js — puts two approved receipts on the unpaid
// weekly invoice whose week they fall in. Receipts #254 and #255 ($20.50 in all,
// dated 2026-09-28) belong on INV-SK-2026W39-01 (week 2026-09-26 to 2026-10-02),
// which was generated before their dates were corrected and so left them out.
// The client's rule (2026-10-09): an unpaid invoice in a finalized month is
// corrected on the invoice itself, through the month's reopen, and the month is
// finalized again.
//
// It runs the server's own code, lifted from this checkout's server.js
// (scripts/lib/server-lift.js), in this order, as one SQLite transaction:
//   1. reopen September: the handler of POST /api/periods/:period/reopen, with
//      the reason below;
//   2. add the receipts to the invoice in place: the same row and number; its
//      receipt record (expense_ids, expenses_total) becomes what the invoice
//      generator records for the receipts in the week: their ids in date order,
//      and the sum of their amounts. Each receipt must pass the generator's own
//      test (dated in the week, the invoice's driver, EXPENSE_PNL_FILTER) and be
//      Approved and on no other invoice. Total Due, the day lines, the status
//      and the dates stay as issued: the driver's pay is a daily rate, and
//      receipts are a reference on the invoice, not pay;
//   3. finalize September again: finalizePeriods(), the month-end close itself;
//   4. compare all of September before and after (septemberState() of
//      scripts/data-fix-september-sunday-invoices.js): only the invoice's
//      receipt record may change. The receipts were already in September's
//      ledger (they are dated 9/28), so every payout row, frozen item and
//      Financials figure must come out the same; anything else rolls the whole
//      transaction back and nothing is written.
// After the commit, the invoice's PDF is re-rendered from its stored snapshot by
// the server's own rerenderInvoicePdfFromStoredData(). The day-rate template
// prints no receipts, so the document reads the same; the receipts show where
// the app shows them ("Receipts filed", "Expenses (ref)").
//
// Refused or stopped, writing nothing, when: the invoice is paid, processing,
// rejected, deleted or manual, is not a day-rate invoice (an owner-operator
// invoice deducts fuel and maintenance from pay), or its week does not hold the
// receipts; a receipt is not in September's frozen ledger (the payout would
// move); its
// recorded receipts total is not the sum of its receipts; a receipt is not
// Approved, not the driver's, not in the week, not the amount the client named,
// or on any invoice already; September is not finalized (or was reopened by
// someone else); the investor's September payout is not owed; the Financials
// settings changed since September closed; the invoice's PDF file is another
// invoice's too; the checks, made again once the database is held, find
// anything changed; the close retries; the comparison finds any other change;
// the invoice's receipts total does not come to --expect-receipts-total.
//
// Idempotent: a second apply finds the receipts on the invoice with this
// script's audit row and September finalized by it, writes nothing to the
// database, and re-renders the PDF from its stored snapshot. Every change is
// logged in audit_trail as a system change (user 0, username this script, role
// "system"); the reopen route writes its own audit row too.
//
// --dry-run never opens the database for writing: it copies it into a fresh
// owner-only folder under the temp directory (SQLite's online backup), runs the
// whole correction on the copy (the PDF rendered into that folder), prints what
// it did there, and deletes the folder. An apply first backs the database up
// next to it (app.db.pre-w39-receipts-<UTC time>, owner-only, integrity-checked).
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/data-fix-w39-receipts.js --db=app.db --sheet-id=<id> --dry-run
//   node scripts/data-fix-w39-receipts.js --db=app.db --sheet-id=<id> --apply --expect-receipts-total=<dollars>
//   --sheet-id=<id>        the Job Tracking sheet, read with the read-only scope
//                          (the close reads it); there is no default
//                          (--sheet-id=env takes the .env's)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --db                   app.db in this app directory, or a copy under the temp
//                          directory (scripts/lib/ledger-world.js dbScope())
//   --env-file=<file>      with a copy only: the flags to run with
//   --data-dir=<dir>       with a copy only: the folder holding uploads/ (default:
//                          the app directory)
//   --key=<file>           the service account key (default service-account-key.json)
//   --expect-receipts-total=<$>  required to apply: the invoice's receipts total
//                          the dry run printed; any other result writes nothing
// Exit codes: 0 done (written, or already applied), 1 error (nothing written to
// the database), 2 refused (nothing written), 3 the database is written but the
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
const { septemberState } = require("./data-fix-september-sunday-invoices");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:data-fix-w39-receipts";
const SYSTEM_USER = Object.freeze({ id: 0, username: ACTOR, role: "system" });
const REF = "W39R-2026-09";
const OPTIONS = ["db", "sheet-id", "values-json", "env-file", "data-dir", "key", "dry-run", "apply", "expect-receipts-total"];

// The correction, as the client named it. The driver is not named here (this
// repository is public): it is read from the invoice, which the receipts must
// match.
const CORRECTION = Object.freeze({
	period: "2026-09",
	reason: "Client-requested correction: receipts #254 and #255 ($20.50, dated 9/28) belong on INV-SK-2026W39-01",
	ownerId: 5,
	invoiceNumber: "INV-SK-2026W39-01",
	receipts: Object.freeze([
		Object.freeze({ id: 254, amount: 5.25, date: "2026-09-28" }),
		Object.freeze({ id: 255, amount: 15.25, date: "2026-09-28" }),
	]),
});

const REOPEN_HEAD = 'app.post("/api/periods/:period/reopen", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
// assertInvoiceFileStillOwn is named although rerenderInvoicePdfFromStoredData
// calls it: in server.js its call follows a comment ending in ".", which
// closure() reads as a property access and so does not follow.
const ROOTS = ["finalizePeriods", "computeFleetLedger", "rerenderInvoicePdfFromStoredData", "assertInvoiceFileStillOwn", "installPeriodLockTriggers", "logAudit", "parseSheet", "deduplicateLoads", "financialsSettings", "closedMonthSettings", "normalizeDriverName", "EXPENSE_PNL_FILTER"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "app", "requireRole", "refuseCrossOrigin", "notifyChange", "getJobTrackingCached", "jtCacheInvalidate", "fetch", "DATA_DIR", "REPLICA"];
const DENIED = ["getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive"];
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "fs", "pdfkit", "pdf-lib"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);

class Refusal extends Error {}

const usd = (v) => {
	const n = Math.round(Number(v || 0) * 100) / 100;
	return `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const cents = (v) => Math.round(Number(v || 0) * 100);
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const sha = (v) => crypto.createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const idsOf = (row) => {
	const ids = parseJson(row && row.expense_ids ? row.expense_ids : "[]", null);
	return Array.isArray(ids) ? ids.map(Number) : null;
};

// This script's audit row for the invoice, if it was written.
function invoiceTokenWritten(db, row) {
	return !!db.prepare("SELECT 1 FROM audit_trail WHERE username = ? AND user_id = 0 AND role = 'system' AND action = 'correct_invoice' AND entity = 'invoice' AND entity_id = ? AND details LIKE ? LIMIT 1")
		.get(ACTOR, String(row.id), `%[${REF}]%`);
}

// What the run would do, read from the database as it stands. Throws Refusal.
// `api` supplies the lifted closedMonthSettings, financialsSettings,
// normalizeDriverName and EXPENSE_PNL_FILTER.
function plan(db, api) {
	const period = CORRECTION.period;
	const lock = db.prepare("SELECT * FROM period_locks WHERE period = ?").get(period);
	if (!lock) throw new Refusal(`${period} is not finalized`);
	const ours = lock.reopen_reason === CORRECTION.reason;
	if (lock.status !== "locked") throw new Refusal(`${period} is ${lock.status}${ours ? " by this correction but not finalized again" : ""}; this script reopens and finalizes it itself`);
	const finishedBefore = ours && lock.finalized_by === ACTOR;

	const row = db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(CORRECTION.invoiceNumber);
	const name = CORRECTION.invoiceNumber;
	if (!row) throw new Refusal(`${name} was not found`);
	if (row.deleted_at) throw new Refusal(`${name} is deleted`);
	if (Number(row.is_manual)) throw new Refusal(`${name} is a manual invoice`);
	if (row.paid_at || ["Paid", "Processing"].includes(row.status)) throw new Refusal(`${name} is ${row.paid_at ? "paid" : row.status}; a paid invoice is corrected in the open month`);
	if (!["Draft", "Submitted", "Approved"].includes(row.status)) throw new Refusal(`${name} is ${row.status}`);
	const render = parseJson(row.render_data || "", null);
	if (!render || render.__templateName !== "service_invoice") throw new Refusal(`${name} is not a day-rate invoice; receipts on an owner-operator invoice change its pay`);
	const ids = idsOf(row);
	if (!ids) throw new Refusal(`${name}'s receipt list is not readable`);
	const driver = api.normalizeDriverName(row.driver);
	if (!driver) throw new Refusal(`${name} names no driver`);

	// The invoice's recorded total must be its receipts' sum, as the generator
	// records it; otherwise its record is not what this script would extend.
	const amountOf = (id) => { const e = db.prepare("SELECT amount FROM expenses WHERE id = ?").get(id); return e ? Number(e.amount || 0) : null; };
	const missing = ids.filter((id) => amountOf(id) === null);
	if (missing.length) throw new Refusal(`${name} names receipt(s) that do not exist: ${missing.join(", ")}`);
	const targetIds = CORRECTION.receipts.map((r) => r.id);
	const otherIds = ids.filter((id) => !targetIds.includes(id));
	const othersCents = otherIds.reduce((s, id) => s + cents(amountOf(id)), 0);

	// The receipts: each as the client named it, and one the generator would
	// have put on this invoice.
	const eligible = new Set(db.prepare(`SELECT id, driver FROM expenses WHERE date >= ? AND date <= ? AND ${api.EXPENSE_PNL_FILTER}`)
		.all(row.week_start, row.week_end).filter((e) => api.normalizeDriverName(e.driver) === driver).map((e) => e.id));
	const live = db.prepare("SELECT id, invoice_number, expense_ids FROM invoices WHERE COALESCE(deleted_at, '') = ''").all();
	const receipts = CORRECTION.receipts.map((want) => {
		const e = db.prepare("SELECT * FROM expenses WHERE id = ?").get(want.id);
		if (!e) throw new Refusal(`receipt #${want.id} was not found`);
		if (e.status !== "Approved") throw new Refusal(`receipt #${want.id} is ${e.status || "without a status"}, not Approved`);
		if (cents(e.amount) !== cents(want.amount)) throw new Refusal(`receipt #${want.id} is ${usd(e.amount)}, not the ${usd(want.amount)} the client named`);
		if (e.date !== want.date) throw new Refusal(`receipt #${want.id} is dated ${e.date}, not ${want.date}`);
		if (!(row.week_start <= e.date && e.date <= row.week_end)) throw new Refusal(`receipt #${want.id} (${e.date}) is not in ${name}'s week (${row.week_start} to ${row.week_end})`);
		if (api.normalizeDriverName(e.driver) !== driver) throw new Refusal(`receipt #${want.id} is not ${name}'s driver's`);
		if (!eligible.has(e.id)) throw new Refusal(`receipt #${want.id} is not one the invoice generator would put on ${name}`);
		const on = live.filter((r) => (idsOf(r) || []).includes(e.id)).map((r) => r.invoice_number);
		const elsewhere = on.filter((n) => n !== name);
		if (elsewhere.length) throw new Refusal(`receipt #${want.id} is already on ${elsewhere.join(", ")}`);
		return { id: e.id, amount: Number(e.amount), date: e.date, type: e.type, onInvoice: on.includes(name) };
	});
	const onCount = receipts.filter((r) => r.onInvoice).length;
	const applied = invoiceTokenWritten(db, row);
	const recorded = cents(row.expenses_total);
	const receiptsCents = receipts.reduce((s, r) => s + cents(r.amount), 0);
	if (onCount === receipts.length && applied && finishedBefore) {
		if (recorded !== othersCents + receiptsCents) throw new Refusal(`${name} lists the receipts, but its receipts total ${usd(recorded / 100)} is not their sum ${usd((othersCents + receiptsCents) / 100)}`);
		return { alreadyApplied: true, row, receipts };
	}
	if (onCount || applied || finishedBefore) throw new Refusal("part of this correction is on record and part is not; nothing was written. Check the audit trail before going further");
	if (recorded !== othersCents) throw new Refusal(`${name}'s receipts total ${usd(recorded / 100)} is not the sum of its ${ids.length} receipt(s), ${usd(othersCents / 100)}`);

	if (!row.pdf_file_name) throw new Refusal(`${name} names no PDF file`);
	const sharers = db.prepare("SELECT invoice_number FROM invoices WHERE pdf_file_name = ? COLLATE NOCASE AND id != ?").all(row.pdf_file_name, row.id);
	if (sharers.length) throw new Refusal(`${name}'s PDF file is also ${sharers.map((r) => r.invoice_number).join(", ")}'s`);

	const payout = db.prepare("SELECT * FROM investor_payouts WHERE owner_id = ? AND period = ?").get(CORRECTION.ownerId, period);
	if (!payout) throw new Refusal(`owner ${CORRECTION.ownerId} has no September payout row`);
	if (payout.status !== "owed" || payout.paid_at) throw new Refusal(`owner ${CORRECTION.ownerId}'s September payout is ${payout.status}; a paid payout is corrected in the open month, not by this script`);
	const freeze = db.prepare("SELECT settings FROM financials_ledger_freezes WHERE period = ? AND released_at = ''").get(period);
	if (!freeze) throw new Refusal("September has no active Financials freeze");
	const closedWith = api.closedMonthSettings().get(period);
	if (JSON.stringify(closedWith) !== JSON.stringify(api.financialsSettings())) throw new Refusal("the Financials settings changed since September closed; finalizing again would freeze it under different settings");
	// Already in September's ledger: a frozen trip item names each receipt, so the
	// payout cannot move. One that isn't would change it on the close.
	const inLedger = receipts.map((r) => !!db.prepare("SELECT 1 FROM financials_ledger_items WHERE period = ? AND expense_id = ? LIMIT 1").get(period, r.id));
	const outside = receipts.filter((r, i) => !inLedger[i]).map((r) => `#${r.id}`);
	if (outside.length) throw new Refusal(`receipt(s) ${outside.join(", ")} are not in September's frozen ledger, so finalizing again would move the payout; this script corrects the invoice's receipt record only`);

	// The generator records a week's receipts in date order (ORDER BY date):
	// the new ones go in at their date, after any already there that day.
	const dateOf = (id) => db.prepare("SELECT date FROM expenses WHERE id = ?").get(id).date;
	const ranked = [...ids.map((id, i) => ({ id, date: dateOf(id), rank: i })), ...receipts.map((r, i) => ({ id: r.id, date: r.date, rank: ids.length + i }))];
	ranked.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rank - b.rank));
	const after = { ids: ranked.map((x) => x.id), total: (othersCents + receiptsCents) / 100 };
	return { alreadyApplied: false, lock, row, driver, receipts, inLedger, payout, before: { ids, total: recorded / 100 }, after };
}

// What a plan was made from: the rows it read. A plan made again inside the
// transaction must match it, or something changed in between.
function planFingerprint(p) {
	return sha([p.lock, p.row, p.receipts, p.payout, p.after]);
}

// What changed in September between `before` and `after` (septemberState()),
// judged against the correction: only the invoice's expense_ids and
// expenses_total, to `ids` and `total`. Returns { ok, problems, changes }.
function compareSeptember(before, after, { invoiceId, ids, total, reason }) {
	const problems = [];
	const changes = [];
	const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
	const bInv = byId(before.invoices);
	const aInv = byId(after.invoices);
	if (bInv.size !== aInv.size || [...bInv.keys()].some((id) => !aInv.has(id))) problems.push("the set of invoices touching September changed");
	for (const [id, b] of bInv) {
		const a = aInv.get(id);
		if (!a) continue;
		if (id !== invoiceId) {
			if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`invoice ${b.invoice_number} changed`);
			continue;
		}
		for (const k of Object.keys(b)) {
			if (k === "expense_ids" || k === "expenses_total") continue;
			if (String(a[k]) !== String(b[k])) problems.push(`invoice ${b.invoice_number}: ${k} changed`);
		}
		if (a.expense_ids !== JSON.stringify(ids)) problems.push(`invoice ${b.invoice_number}: its receipts are ${a.expense_ids}, not ${JSON.stringify(ids)}`);
		if (cents(a.expenses_total) !== cents(total)) problems.push(`invoice ${b.invoice_number}: its receipts total is ${usd(a.expenses_total)}, not ${usd(total)}`);
		changes.push({ what: "invoice", invoiceNumber: b.invoice_number, status: b.status, before: { ids: b.expense_ids, total: Number(b.expenses_total), due: Number(b.total_earnings) + Number(b.adjustment || 0) }, after: { ids: a.expense_ids, total: Number(a.expenses_total), due: Number(a.total_earnings) + Number(a.adjustment || 0) } });
	}
	if (JSON.stringify(before.items) !== JSON.stringify(after.items)) problems.push(`September's frozen items changed (${before.items.length} -> ${after.items.length})`);
	if (before.freezes.length !== 1 || after.freezes.length !== 1) problems.push(`September has ${before.freezes.length} active freeze(s) before and ${after.freezes.length} after, not one`);
	else {
		for (const k of ["item_count", "summary", "settings"]) if (String(before.freezes[0][k]) !== String(after.freezes[0][k])) problems.push(`September's Financials freeze: ${k} changed`);
		changes.push({ what: "financials", before: parseJson(before.freezes[0].summary, {}), after: parseJson(after.freezes[0].summary, {}) });
	}
	const bPay = new Map(before.payouts.map((r) => [r.owner_id, r]));
	const aPay = new Map(after.payouts.map((r) => [r.owner_id, r]));
	if (bPay.size !== aPay.size || [...bPay.keys()].some((o) => !aPay.has(o))) problems.push("the set of September payout rows changed");
	for (const [owner, b] of bPay) {
		const a = aPay.get(owner);
		if (!a) continue;
		if (!a.finalized_at) problems.push(`owner ${owner}'s September payout is not finalized after the run`);
		for (const k of Object.keys(b)) {
			if (k === "finalized_at") continue;
			if (String(a[k]) !== String(b[k])) problems.push(`owner ${owner}'s September payout: ${k} changed`);
		}
		changes.push({ what: "payout", ownerId: owner, id: a.id, amount: Number(a.amount), finalizedAt: { before: b.finalized_at, after: a.finalized_at } });
	}
	if (JSON.stringify(before.excluded) !== JSON.stringify(after.excluded)) problems.push("September's driver-day overrides changed");
	if (!after.lock || after.lock.status !== "locked") problems.push("September is not finalized after the run");
	else if (after.lock.reopen_reason !== reason) problems.push("September's lock does not carry this correction's reopen reason");
	for (const [k, v] of Object.entries(before.unchanged)) if (after.unchanged[k] !== v) problems.push(`${k} changed`);
	return { ok: problems.length === 0, problems, changes };
}

// The lifted server code, on its own handle (see the header).
function buildWorld({ dbFile, sheetData, env, dataDir }) {
	const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const Database = appRequire("better-sqlite3");
	const db = new Database(dbFile, { fileMustExist: true });
	db.pragma("busy_timeout = 10000");
	const lifted = closure(SRC, { roots: ROOTS, routes: [REOPEN_HEAD], provided: PROVIDED, denied: DENIED });
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
		"return { finalizePeriods, computeFleetLedger, rerenderInvoicePdfFromStoredData, installPeriodLockTriggers, logAudit, financialsSettings, closedMonthSettings, normalizeDriverName, EXPENSE_PNL_FILTER };",
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

// SQLite's online backup of the database next to it, owner-only,
// self-contained and integrity-checked (scripts/freeze-closed-months.js).
async function backupNextTo(dbPath, db, Database) {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const target = `${dbPath}.pre-w39-receipts-${stamp}`;
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

// Steps 1 to 4 of the header, in one transaction. Returns what changed. Throws
// (and rolls back) on anything unexpected. `expectTotal` (an apply's
// --expect-receipts-total, the dry run's figure) is the receipts total the
// invoice must arrive at, or nothing is written.
async function correct(world, p, { expectTotal = null } = {}) {
	const { db, api, call } = world;
	const period = CORRECTION.period;
	const log = [];
	api.installPeriodLockTriggers(db);
	// The fleet's ELD travel days, read once before the transaction into the
	// same cache the close reads them through, so the database is held for
	// writing only while the close computes and writes.
	await api.computeFleetLedger();
	const started = Date.now();
	db.exec("BEGIN IMMEDIATE");
	const open = (step) => { if (!db.inTransaction) throw new Error(`the transaction ended during ${step}; check the database before going further`); };
	let result;
	try {
		if (planFingerprint(plan(db, api)) !== planFingerprint(p)) throw new Refusal("the invoice, the receipts, the payout or September changed after they were checked; run again");
		const before = septemberState(db, period);
		const auditFrom = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_trail").get().id;
		const historyFrom = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM investor_payout_history").get().id;
		const reopened = await call("POST /api/periods/:period/reopen", { params: { period }, body: { reason: CORRECTION.reason } });
		if (reopened.status !== 200) throw new Refusal(`reopening ${period} answered ${reopened.status}: ${JSON.stringify(reopened.body)}`);
		open("the reopen");
		log.push(`Reopened ${period} with the reason "${CORRECTION.reason}" (${reopened.body.relinkedOwedRows} owed payout row(s) re-linked to live earnings).`);
		const r = p.row;
		const n = db.prepare(`UPDATE invoices SET expense_ids = ?, expenses_total = ?
			WHERE id = ? AND expense_ids = ? AND expenses_total = ? AND status = ? AND total_earnings = ? AND render_data = ?
				AND COALESCE(paid_at, '') = '' AND COALESCE(deleted_at, '') = ''`)
			.run(JSON.stringify(p.after.ids), p.after.total, r.id, r.expense_ids, r.expenses_total, r.status, r.total_earnings, r.render_data).changes;
		if (n !== 1) throw new Refusal(`${CORRECTION.invoiceNumber} changed while it was being corrected`);
		const list = p.receipts.map((x) => `#${x.id} ${usd(x.amount)} (${x.date})`).join(", ");
		audit(db, "correct_invoice", "invoice", r.id,
			`${r.status === "Approved" ? "POST-APPROVAL correction (status Approved): " : ""}${CORRECTION.invoiceNumber}: receipts ${list} added; ` +
			`receipts total ${usd(p.before.total)} -> ${usd(p.after.total)} (${p.before.ids.length} -> ${p.after.ids.length} receipts); Total Due ${usd(Number(r.total_earnings) + Number(r.adjustment || 0))} unchanged; regenerated in place, same number. ${CORRECTION.reason} [${REF}]`);
		open(`the correction of ${CORRECTION.invoiceNumber}`);
		log.push(`Added receipts ${list} to ${CORRECTION.invoiceNumber} in place: receipts total ${usd(p.before.total)} -> ${usd(p.after.total)}; Total Due unchanged.`);
		const closed = await api.finalizePeriods([period], ACTOR);
		if (closed.retry || !closed.periods.includes(period)) throw new Refusal(`finalizing ${period} again did not close it (${closed.reason || "nothing closed"})`);
		audit(db, "period_finalize", "period", period, `Finalized ${period} again after the client-requested correction (${closed.stamped} payout row(s) frozen) [${REF}]`);
		open("the close");
		log.push(`Finalized ${period} again (${closed.stamped} payout row(s) stamped, Financials items frozen, lock taken).`);
		const after = septemberState(db, period);
		const cmp = compareSeptember(before, after, { invoiceId: r.id, ids: p.after.ids, total: p.after.total, reason: CORRECTION.reason });
		if (!cmp.ok) throw new Refusal(`September changed beyond the correction, so nothing was written:\n  - ${cmp.problems.join("\n  - ")}`);
		if (expectTotal !== null && cents(p.after.total) !== cents(expectTotal)) {
			throw new Refusal(`${CORRECTION.invoiceNumber}'s receipts total came to ${usd(p.after.total)}, not the ${usd(expectTotal)} --expect-receipts-total names, so nothing was written`);
		}
		const history = db.prepare("SELECT owner_id, period, kind, old_amount, new_amount FROM investor_payout_history WHERE id > ? ORDER BY id").all(historyFrom);
		if (history.some((h) => h.period !== period)) throw new Refusal("the run recorded a payout change outside September");
		if (history.some((h) => cents(h.old_amount) !== cents(h.new_amount))) throw new Refusal("the run recorded a payout amount change; the receipts were already in September's ledger, so none was expected");
		audit(db, "data_fix", "invoice", r.id,
			`${CORRECTION.reason}: ${CORRECTION.invoiceNumber} receipts total ${usd(p.before.total)} -> ${usd(p.after.total)}; Total Due unchanged; September's payouts, Financials and frozen items unchanged [${REF}]`);
		const audits = db.prepare("SELECT action, username, role, entity, entity_id FROM audit_trail WHERE id > ? ORDER BY id").all(auditFrom);
		open("the comparison");
		db.exec("COMMIT");
		result = { before, after, cmp, log, audits, history, lockedMs: Date.now() - started };
	} catch (err) {
		if (db.inTransaction) db.exec("ROLLBACK");
		throw err;
	}
	return result;
}

async function renderPdf(world, p) {
	const row = world.db.prepare("SELECT * FROM invoices WHERE id = ?").get(p.row.id);
	const mode = await world.api.rerenderInvoicePdfFromStoredData(row);
	return `Re-rendered ${CORRECTION.invoiceNumber}'s PDF (${row.pdf_file_name}, ${mode}).`;
}

function report(r, p) {
	const lines = [];
	const say = (s) => lines.push(s);
	say("September before and after:");
	for (const c of r.cmp.changes.filter((x) => x.what === "invoice")) {
		say(`- ${c.invoiceNumber} (${c.status}): receipts ${c.before.ids} ${usd(c.before.total)} -> ${c.after.ids} ${usd(c.after.total)}; Total Due ${usd(c.before.due)} -> ${usd(c.after.due)}`);
	}
	for (const c of r.cmp.changes.filter((x) => x.what === "payout")) {
		say(`- Owner ${c.ownerId}'s September payout (row ${c.id}): ${usd(c.amount)}, unchanged; finalized_at ${c.finalizedAt.before} -> ${c.finalizedAt.after}`);
	}
	const fin = r.cmp.changes.find((c) => c.what === "financials");
	if (fin) say(`- September's Financials: revenue ${usd(fin.after.revenue)}, driver pay ${usd(fin.after.driverPay)}, trip expenses ${usd(fin.after.tripExpenses)}, net profit ${usd(fin.after.netProfit)}; unchanged`);
	say(`- Frozen Financials items: ${r.before.items.length} -> ${r.after.items.length}, identical.`);
	say(`- Unchanged (compared): the other ${r.before.invoices.length - 1} invoice(s) touching September, September's receipts, maintenance-fund and compliance rows, driver-day overrides, every other month's payout rows, frozen items, freezes and locks, every invoice outside September, trucks, assignments, the drivers directory and the investor settings.`);
	say(`- September's lock: ${r.before.lock.status} (finalized ${r.before.lock.finalized_at} by ${r.before.lock.finalized_by}) -> ${r.after.lock.status} (finalized ${r.after.lock.finalized_at} by ${r.after.lock.finalized_by}; reopened ${r.after.lock.reopened_at} by ${r.after.lock.reopened_by})`);
	say(`Audit rows written: ${r.audits.map((a) => `${a.action} (${a.username}, ${a.role})`).join(", ")}`);
	say(`Payout history rows written: ${r.history.map((h) => `owner ${h.owner_id} ${h.period} ${h.kind} ${usd(h.old_amount)} -> ${usd(h.new_amount)}`).join("; ") || "none"}`);
	say(`The database was held for writing for ${r.lockedMs} ms.`);
	return lines.join("\n");
}

function describePlan(p) {
	const r = p.row;
	const lines = [];
	lines.push(`- ${CORRECTION.invoiceNumber} (invoice ${r.id}): ${r.status}, unpaid; week ${r.week_start} to ${r.week_end}; Total Due ${usd(Number(r.total_earnings) + Number(r.adjustment || 0))}; ${p.before.ids.length} receipts, ${usd(p.before.total)}.`);
	p.receipts.forEach((x, i) => lines.push(`- Receipt #${x.id}: ${usd(x.amount)}, ${x.type}, dated ${x.date}, Approved, on no invoice; ${p.inLedger[i] ? "already in September's frozen ledger" : "NOT in September's frozen ledger"}.`));
	lines.push(`- Owner ${CORRECTION.ownerId}'s September payout (row ${p.payout.id}): ${p.payout.status}, unpaid, ${usd(p.payout.amount)}.`);
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
	let expectTotal = null;
	if (args["expect-receipts-total"] !== undefined) {
		expectTotal = Number(args["expect-receipts-total"]);
		if (typeof args["expect-receipts-total"] !== "string" || !/^\d+(\.\d{1,2})?$/.test(args["expect-receipts-total"]) || !Number.isFinite(expectTotal)) throw new Refusal("--expect-receipts-total=<dollars> takes the dry run's receipts total, e.g. 2310.95");
	}
	if (apply && expectTotal === null) throw new Refusal("--apply needs --expect-receipts-total=<the invoice's receipts total the dry run printed>");
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
	const onSignal = (sig) => { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); console.error(`Stopped by ${sig}.`); process.exit(130); };
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, onSignal);
	try {
		let target = dbFile;
		let targetDataDir = dataDir;
		if (dryRun) {
			const live = new Database(dbFile, { readonly: true, fileMustExist: true });
			if (!live.readonly) throw new Refusal("the dry run's handle on the database is not read-only");
			tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "w39-receipts-dry-"));
			target = path.join(tmpDir, "app.db");
			try { await copyDatabase(live, target, Database); } finally { live.close(); }
			fs.mkdirSync(path.join(tmpDir, "uploads", "invoices"), { recursive: true });
			targetDataDir = tmpDir;
		}
		world = buildWorld({ dbFile: target, sheetData, env, dataDir: targetDataDir });
		if (dryRun) {
			const row = world.db.prepare("SELECT pdf_file_name FROM invoices WHERE invoice_number = ?").get(CORRECTION.invoiceNumber);
			const src = row && row.pdf_file_name ? path.join(dataDir, "uploads", "invoices", row.pdf_file_name) : "";
			if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(targetDataDir, "uploads", "invoices", row.pdf_file_name));
		}
		const p = plan(world.db, world.api);
		if (p.alreadyApplied) {
			say(`Already applied: the receipts are on ${CORRECTION.invoiceNumber} with this script's audit row, and September was finalized by ${ACTOR}. Nothing was written to the database.`);
			if (apply) say(await renderPdf(world, p));
			return 0;
		}
		say("Checked:");
		say(describePlan(p));
		if (apply && cents(p.after.total) !== cents(expectTotal)) throw new Refusal(`${CORRECTION.invoiceNumber}'s receipts total would be ${usd(p.after.total)}, not the ${usd(expectTotal)} --expect-receipts-total names; nothing was written`);
		if (apply) say(`Backup: ${await backupNextTo(dbFile, world.db, Database)}`);
		const r = await correct(world, p, { expectTotal });
		say(dryRun ? "On the temporary copy (committed there):" : "Applied (committed):");
		r.log.forEach((l, i) => say(`${i + 1}. ${l}`));
		say(report(r, p));
		say(`${CORRECTION.invoiceNumber}'s receipts total after the correction: ${p.after.total.toFixed(2)} (--expect-receipts-total for the apply).`);
		try {
			say(await renderPdf(world, p));
		} catch (err) {
			console.error(`PDF NOT RE-RENDERED: ${err.message}`);
			console.error(dryRun
				? "On the temporary copy the database step completed; only the PDF step failed."
				: "The database IS written (above). Do not restore the backup: run the same --apply again, which writes nothing more and re-renders the PDF.");
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

module.exports = { CORRECTION, ACTOR, REF, REOPEN_HEAD, ROOTS, PROVIDED, DENIED, plan, planFingerprint, compareSeptember, Refusal };
