#!/usr/bin/env node
// scripts/correct-weekly-invoice.js — re-issues ONE Submitted weekly invoice of
// a daily-rate driver IN PLACE, from a recompute that reads the live Driver Pay
// Overrides: the days a Super Admin removed for the driver (the Driver Pay
// Overrides page, POST /api/admin/excluded-days, "remove") leave the invoice's
// day grid, its total and its PDF. The same row, number, status, submission
// date, adjustment and PDF file name; only render_data's `days` and `totalDue`,
// total_earnings and loads_count change, and only as those overrides imply.
// The overrides are added in the app first (the route runs its own month-lock
// gate and writes its own audit row); this script never writes one.
//
// The recompute is generate's own code (POST /api/invoices/generate,
// generateInvoiceHandler()), lifted from this checkout's server.js
// (scripts/lib/server-lift.js) and composed as the handler composes it:
// selectInvoiceWeekLoads(), getDriverPayStructures(), truckDailyRateCandidates()
// and resolveDailyRate(), invoiceWeekPaidDays() (the ELD intersection, the
// pre-dispatch and blank-pickup rules and the overrides), invoiceDayPricing(),
// weeklyManualInvoiceHolds() (a day a live manual invoice pays is left off) and
// invoiceDayGrid(). scripts/test-correct-weekly-invoice.js pins it equal to the
// handler on fixture weeks.
//
// The guard: the recompute must equal the stored invoice except for the
// removed days.
//   - Every day the stored grid pays and the recompute does not has a live
//     "remove" override for the driver on it, and every live "remove" override
//     of the driver inside the week is on a day the stored invoice pays.
//   - Each removed day moves only its own month (excludedDayPeriods(), as the
//     overrides route's gate reads it), and that month is open.
//   - A removed day's new row is exactly the unpaid row generate writes. Every
//     kept day keeps its completed flag, total, rate and loadBol (as a set); the
//     recompute pays no day the stored invoice does not.
//   - load_ids (as a set) and rate_per_load are equal. The stored totalDue is the
//     stored total_earnings, to the cent; the new total_earnings and totalDue are
//     the stored total less the removed days' amounts, and loads_count drops by
//     the removed days, and the recompute agrees with both.
//   - expense_ids and expenses_total are printed beside the recompute's, never
//     checked: the day grid and its PDF read neither.
// Anything else refuses: another day changing, a rate moving, a load joining or
// leaving.
//
// Refused (exit 2, nothing written) also when: the invoice is not Submitted, is
// deleted, manual, a correction or a percentage driver's (service_invoice_owner_op);
// it carries a Personal line (the ledger, its snapshot, personal_total or
// personal_share_total); its week touches a closed month or the month locks
// can't be read; TRIP_WORK_DAYS is on, or the invoice holds an
// invoice_paid_days row; its week is not one Saturday-Friday billing week; it is
// not the driver-week's one live weekly invoice; a live "add" override for the
// driver is inside the week; its PDF is not on disk, or another invoice names
// the same file; an adjustment was saved under 2 minutes ago (its re-render may
// be in flight); DRIVER_RATE_ONLY is on and the app never ran with it on this
// database (pricing would stamp the rule's start record).
//
// The write (--apply, with the dry run's fingerprint): an owner-only backup of
// the row and the issued PDF beside the database (outside uploads/), checked;
// the corrected PDF rendered from the snapshot with the row's adjustment
// (personalRenderData() with no Personal line, then renderPolicy()), written to
// a temporary file beside the served one; then one immediate transaction that
// reads the row again and plans again to the same fingerprint, checks the
// served file is the one backed up, UPDATEs the row, INSERTs one audit_trail row
// (a system change: user 0, "system: invoice correction script", role system,
// action correct_weekly_invoice, entity invoice <id>, the before and after, each
// override, the PDF hashes, the git commit and the backup) and renames the PDF
// into place last. Any throw removes the temporary file; a COMMIT that fails
// after the rename puts the issued PDF back from the backup. After the commit
// the served file's SHA-256 and the row are checked against what was written.
//
// Idempotent: once this script's audit row exists for the invoice, a run prints
// it and writes nothing (exit 0), whatever the recompute says now.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/correct-weekly-invoice.js --invoice <number> --sheet-id <id>|env [--db app.db]
//     a dry run (the default): prints the overrides it relies on, the stored and
//     new 7-row grid, every changed figure, the periods, the plan time and the
//     fingerprint; the database is opened read-only, nothing is rendered or written
//   ... the same --apply --expect=<fingerprint>
//   --db <file>           the app directory's own app.db (the default), or a copy
//                         under the temp directory (scripts/lib/ledger-world.js
//                         dbScope()); a copy's PDFs are read beside it, in
//                         uploads/invoices/
//   --sheet-id <id>|env   Job Tracking, read with the read-only scope (env: the
//                         SPREADSHEET_ID the .env sets); or
//   --values-json <file>  a saved values.get of Job Tracking
//   --key <file>          the service-account key (default: the app's)
//   --env-file <file>     with a copy only: the flags to run with
// Exit codes: 0 written, already corrected, or dry run; 1 error (nothing
// written); 2 refused (nothing written); 3 written, but the served PDF or the row
// is not what this run wrote (the remedy is printed).
//
// Required as a module (by its test runner) it runs nothing and exports its
// parts.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const { parseArgs, sheetFor, envFor, openDb } = require("./lib/ledger-world");
const { isCalendarDay, weekdayOf, cents, usd, parseJson, INSERT_AUDIT } = require("./create-correction-invoice-draft");
const driverRateOnly = require("../lib/driver-rate-only");

const ROOT = path.join(__dirname, "..");
const ACTOR = "system: invoice correction script";
const AUDIT_ACTION = "correct_weekly_invoice";
const DECISION = "Arvin's decision 2026-10-24";
// An adjustment saved this recently may still be re-rendering its PDF.
const ADJUST_RACE_MS = 2 * 60 * 1000;
const OPTIONS = ["invoice", "db", "values-json", "sheet-id", "key", "env-file", "apply", "expect", "dry-run"];
const GRID_TEMPLATE = "service_invoice";
const INVOICE_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

// What the script lifts from server.js (exactly the names it calls), and what
// it must never reach.
const ROOTS = [
	// generate's compute step
	"normalizeDriverName", "getWeekRange", "jobTrackingRowsOf", "loadKeySet", "getDeletedLoadIds", "selectInvoiceWeekLoads",
	"getDriverPayStructures", "EXPENSE_PNL_FILTER", "truckDailyRateCandidates", "resolveDailyRate", "invoiceWeekPaidDays",
	"invoiceDayPricing", "weeklyManualInvoiceHolds", "invoiceDayGrid", "INVOICE_GRID_DAYS", "invoiceGridDayName",
	"TRIP_WORK_DAYS_FROM", "DRIVER_RATE_ONLY_FROM", "INVOICE_BLANK_PICKUP_FALLBACK_FROM", "preDispatchPayDayFilter", "APP_TIMEZONE",
	// the invoice, its Personal lines, its month and its days
	"personalSnapshotOf", "personalRowsOnInvoice", "invoiceMonthLockBlockers", "invoicePaidDaysTablePresent",
	"liveWeeklyInvoicesForDriverWeek", "invoicePaidDaysOf", "invoiceTotalDue",
	// the overrides and the months they move (excludedDayGate()'s reading)
	"driverNameForTotals", "periodLocksReadable", "periodWriteLocked", "excludedDayPeriods", "parseSheet", "deduplicateLoads",
	"financialsCalc", "tripDayLockCover",
	// the PDF
	"personalRenderData", "renderPolicy",
];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "DATA_DIR", "fetch", "Date"];
const DENIED = ["app", "getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive",
	"notifyChange", "logAudit", "getJobTrackingCached", "jtCacheInvalidate", "commitInvoiceWithPdf"];
// What the lifted code may require: Node's crypto, path and fs, and the app's own lib/.
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "fs"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);
// The environment a world's lifted code reads as process.env.
const WORLD_ENV = Symbol("the world's process.env");

class Refusal extends Error {}
// A run that finds this script's audit row once the database is held.
class AlreadyDone extends Error {
	constructor(found) { super("already corrected"); this.found = found; }
}

const sha256Of = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayText = (day) => `${day} ${weekdayOf(day)}`;
const splitBol = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const sameSet = (a, b) => {
	const A = new Set(a.map(String));
	const B = new Set(b.map(String));
	return A.size === B.size && [...A].every((x) => B.has(x));
};

// The command line, checked before anything is opened. Returns
// { invoice, db, valuesJson, sheetId, key, envFile, apply, expect } or throws Refusal.
function readOptions(argv) {
	const args = parseArgs(argv);
	for (const a of argv) {
		if (!a.startsWith("--")) continue;
		const name = a.slice(2).split("=")[0];
		if (!OPTIONS.includes(name)) throw new Refusal(`unknown option --${name}`);
	}
	const text = (k) => (typeof args[k] === "string" ? args[k].trim() : "");
	const invoice = text("invoice");
	if (!invoice || !INVOICE_NUMBER_RE.test(invoice)) {
		throw new Refusal("--invoice <number> is required: the invoice number as the Invoices screen shows it (letters, digits, '.', '_' and '-')");
	}
	if (args.apply !== undefined && args.apply !== true) throw new Refusal("--apply takes no value; the dry run's fingerprint goes in --expect=<fingerprint>");
	if (args["dry-run"] !== undefined && args["dry-run"] !== true) throw new Refusal("--dry-run takes no value");
	const apply = args.apply === true;
	if (apply && args["dry-run"] === true) throw new Refusal("--dry-run and --apply together: a run is one or the other (a dry run is the default)");
	const expect = text("expect");
	if (apply && !expect) throw new Refusal("--apply needs --expect=<fingerprint>: the fingerprint the dry run printed");
	if (!apply && args.expect !== undefined) throw new Refusal("--expect goes with --apply only (a dry run prints the fingerprint)");
	if (apply && !FINGERPRINT_RE.test(expect)) throw new Refusal("--expect=<fingerprint>: the 16 hex digits the dry run printed");
	const valuesJson = text("values-json");
	const sheetId = text("sheet-id");
	if (!valuesJson && !sheetId) throw new Refusal("--sheet-id <id>|env (or --values-json <file>) is required: the recompute reads Job Tracking, and there is no default sheet");
	if (valuesJson && sheetId) throw new Refusal("name one of --sheet-id and --values-json, not both");
	for (const k of ["db", "key", "env-file"]) if (args[k] !== undefined && !text(k)) throw new Refusal(`--${k} needs a value`);
	return {
		invoice, db: text("db") || null, valuesJson: valuesJson || null, sheetId: sheetId || null, key: text("key") || null,
		envFile: text("env-file") || null, apply, expect: apply ? expect : null,
	};
}

// The server code this script runs, lifted from `root`'s server.js once per
// process, on `db`, reading `env` as its process.env. `render` replaces
// renderPolicy() (tests pass a stub). `now`: epoch ms the lifted code's clock
// reads (null: the real clock).
const LIFTS = new Map();
function liftFor(root) {
	const key = path.resolve(root);
	if (!LIFTS.has(key)) LIFTS.set(key, closure(serverSource({ root }), { roots: ROOTS, provided: PROVIDED, denied: DENIED }));
	return LIFTS.get(key);
}
function buildWorld({ root = ROOT, db, env = {}, dataDir, render = null, log = console, now = null }) {
	const lifted = liftFor(root);
	const appRequire = createRequire(path.join(root, "server.js"));
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this script makes no network calls"); };
	const scriptProcess = { env: { ...env }, pid: process.pid, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	if (now !== null && !Number.isFinite(now)) throw new Error("now must be epoch milliseconds");
	const ClockDate = now === null ? Date : class extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	};
	const body = ['"use strict";', lifted.text, `return { ${ROOTS.join(", ")} };`].join("\n");
	const api = new Function(...PROVIDED, body)(db, liftedRequire, log, scriptProcess, root, dataDir, noFetch, ClockDate);
	if (render) api.renderPolicy = render;
	api[WORLD_ENV] = scriptProcess.env;
	return { api, env: scriptProcess.env, liftedNames: lifted.names, liftedText: lifted.text };
}

// What POST /api/invoices/generate would write for the driver-week now, with
// the trip work-day rule off: generateInvoiceHandler()'s compute step, its
// functions called as it calls them, nothing rendered or written. `driverName`
// is the stored row's driver (every step matches any spelling of it).
function recompute(db, api, values, { driverName, weekEnd }) {
	const nameNorm = api.normalizeDriverName(typeof driverName === "string" ? driverName : "");
	if (!nameNorm) throw new Refusal("the invoice names no driver");
	if (api.TRIP_WORK_DAYS_FROM) throw new Refusal(`TRIP_WORK_DAYS is on (from ${api.TRIP_WORK_DAYS_FROM}); this script recomputes a week only with the rule off`);
	const { weekStart, weekEnd: computedWeekEnd } = api.getWeekRange(weekEnd);
	const rows = (values && values.values) || [];
	if (rows.length < 2) throw new Refusal("Job Tracking is empty (no load rows), so nothing can be recomputed");
	const { headers, data } = api.jobTrackingRowsOf(rows);
	const week = api.selectInvoiceWeekLoads(data, headers, driverName, weekStart, computedWeekEnd, api.loadKeySet(api.getDeletedLoadIds()));
	if (!week.cols.dateCol) throw new Refusal("Job Tracking has no completion-date column, so no load can be placed in a billing week");
	const uniqueLoads = week.loads;
	if (!uniqueLoads.length) throw new Refusal(`the weekly generator bills no load for this driver in the week of ${weekStart} now, so the invoice can't be recomputed`);
	const payStruct = api.getDriverPayStructures()[nameNorm] || { payType: "fixed", payPercentage: 0 };
	if (payStruct.payType === "percentage") throw new Refusal("the driver is paid a percentage of revenue; his weekly invoice reads revenue, not days, so this script does not apply");
	const { loadIdCol } = week.cols;
	const expenses = db.prepare(`SELECT * FROM expenses WHERE date >= ? AND date <= ? AND ${api.EXPENSE_PNL_FILTER} ORDER BY date ASC`)
		.all(weekStart, computedWeekEnd).filter((e) => api.normalizeDriverName(e.driver) === nameNorm);
	const truckRate = api.truckDailyRateCandidates(driverName).slice(-1)[0];
	const dailyRate = api.resolveDailyRate(payStruct.payDaily, truckRate, computedWeekEnd.slice(0, 7));
	const expensesTotal = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
	const loadIds = uniqueLoads.map((l) => (loadIdCol ? l[loadIdCol] : "")).filter(Boolean);
	const expenseIds = expenses.map((e) => e.id);
	const paid = api.invoiceWeekPaidDays({ headers, cols: week.cols, loads: uniqueLoads, extraRuleLoads: [], weekRule: null, weekStart, weekEnd: computedWeekEnd, nameNorm });
	const { activeDaySet, dayLoadMap, dayListed, dayScheduled, dayPayMonth } = paid;
	const { rateOf, totalOf } = api.invoiceDayPricing({ dailyRate, nameNorm, payDaily: payStruct.payDaily, truckRate, weekRule: null, dayPayMonth });
	const holds = api.weeklyManualInvoiceHolds({ driverNorm: nameNorm, days: activeDaySet, weekStart, weekEnd: computedWeekEnd, rateOf: (ds) => (rateOf ? rateOf(ds) : dailyRate) });
	for (const ds of holds.held.keys()) { activeDaySet.delete(ds); delete dayLoadMap[ds]; }
	const totalEarnings = totalOf(activeDaySet);
	const days = api.invoiceDayGrid({ days: activeDaySet, dayLoadMap, dayListed, dayScheduled, rateOf, dailyRate, weekStart });
	const latestPaidDay = [...activeDaySet].sort().pop();
	const ratePerLoad = api.DRIVER_RATE_ONLY_FROM && latestPaidDay ? rateOf(latestPaidDay) : dailyRate;
	return {
		nameNorm, weekStart, weekEnd: computedWeekEnd, days, paidDays: [...activeDaySet].sort(), totalEarnings, loadsCount: activeDaySet.size,
		ratePerLoad, loadIds, expenseIds, expensesTotal, dailyRate, truckRate, payDaily: payStruct.payDaily, held: holds.held,
	};
}

// The live overrides of the driver inside the week, read as
// getAllExcludedDriverDays() reads them (the name trimmed, "add" or else "remove").
function weekOverrides(db, api, nameNorm, weekStart, weekEnd) {
	return db.prepare(`SELECT id, driver_name, excluded_date, reason, excluded_by, strftime('%Y-%m-%dT%H:%M:%SZ', excluded_at) AS excluded_at,
		COALESCE(action, 'remove') AS action FROM excluded_driver_days ORDER BY excluded_date, id`).all()
		.filter((o) => String(api.driverNameForTotals(o.driver_name) || "").trim() === nameNorm)
		.map((o) => ({
			id: o.id, day: String(o.excluded_date || "").trim(), action: o.action === "add" ? "add" : "remove",
			reason: String(o.reason || ""), excludedBy: String(o.excluded_by || ""), excludedAt: String(o.excluded_at || ""),
		}))
		.filter((o) => o.day >= weekStart && o.day <= weekEnd);
}

// Everything the run would write, from the database, the PDF on disk and the
// sheet values. Synchronous (no await), so it runs again inside the write's
// transaction. Returns { state: "plan", ... } or { state: "already", row, audit },
// or throws Refusal.
function plan(db, api, values, opts, { dataDir }) {
	const checks = [];
	const number = opts.invoice;
	const row = db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(number);
	if (!row) throw new Refusal(`no invoice numbered ${number}`);

	// ── idempotent, before anything else ───────────────────────────────────────
	const done = db.prepare("SELECT * FROM audit_trail WHERE action = ? AND entity = 'invoice' AND entity_id = ? ORDER BY id LIMIT 1").get(AUDIT_ACTION, String(row.id));
	if (done) return { state: "already", row, audit: done };

	// ── the invoice ─────────────────────────────────────────────────────────────
	if (String(row.deleted_at || "") !== "") throw new Refusal(`${number} is deleted (${row.deleted_at}); a deleted invoice is not corrected`);
	if (row.status !== "Submitted") {
		throw new Refusal(`${number} is ${row.status === "Draft" ? "a Draft" : row.status}; only a Submitted weekly invoice is corrected by this script` +
			(row.status === "Draft" ? " (a Draft regenerates in place through generate)" : ""));
	}
	if (Number(row.is_manual)) throw new Refusal(`${number} is a manual invoice; only a weekly (generated) invoice is corrected by this script`);
	if (row.correction_of != null || Number(row.is_correction)) throw new Refusal(`${number} is a correction invoice; only a weekly invoice is corrected by this script`);
	const snapshot = api.personalSnapshotOf(row);
	if (!snapshot) throw new Refusal(`${number} has no stored render data, so its day grid can't be compared`);
	if (snapshot.__templateName !== GRID_TEMPLATE) {
		throw new Refusal(`${number} is rendered with ${snapshot.__templateName}` +
			(snapshot.__templateName === "service_invoice_owner_op" ? " (a percentage driver's invoice: its pay reads revenue, not days)" : "") +
			`; only a daily-rate weekly invoice (${GRID_TEMPLATE}) is corrected by this script`);
	}
	checks.push("a live weekly invoice of a daily-rate driver, Submitted (not manual, not a correction)");
	const ws = String(row.week_start || "");
	const we = String(row.week_end || "");
	if (!isCalendarDay(ws) || weekdayOf(ws) !== "Saturday") {
		throw new Refusal(`${number}'s week_start ${ws || "(empty)"} is ${isCalendarDay(ws) ? `a ${weekdayOf(ws)}` : "not a calendar day"}; a weekly invoice's week starts on a Saturday`);
	}
	const range = api.getWeekRange(we);
	if (range.weekStart !== ws || range.weekEnd !== we) {
		throw new Refusal(`${number}'s week ${ws} to ${we} is not one billing week (the week of ${we} runs ${range.weekStart} to ${range.weekEnd})`);
	}
	const names = api.INVOICE_GRID_DAYS;
	const dates = names.map((n, i) => addDays(ws, i));
	const nameOf = (day) => api.invoiceGridDayName(day);
	const grid = snapshot.days;
	if (!grid || typeof grid !== "object" || Array.isArray(grid) || JSON.stringify(Object.keys(grid).sort()) !== JSON.stringify([...names].sort())) {
		throw new Refusal(`${number}'s stored day grid is not the 7 rows Saturday to Friday, so it can't be compared`);
	}
	names.forEach((n, i) => {
		const e = grid[n];
		if (!e || typeof e !== "object") throw new Refusal(`${number}'s stored ${n} row can't be read`);
		if (e.date !== undefined && e.date !== dates[i]) throw new Refusal(`${number}'s stored ${n} row is dated ${e.date}, not ${dates[i]}`);
	});
	checks.push(`one billing week, Saturday ${ws} to Friday ${we}, with its 7-row day grid`);
	const personalRows = api.personalRowsOnInvoice(row.id);
	const snapLines = Array.isArray(snapshot.personalLines) ? snapshot.personalLines : [];
	if (personalRows.length || snapLines.length || cents(row.personal_total) || cents(row.personal_share_total) || cents(snapshot.personalTotal) || cents(snapshot.personalShareTotal)) {
		throw new Refusal(`${number} carries Personal lines (${personalRows.length} on the ledger, ${snapLines.length} in its snapshot, personal_total ${usd(row.personal_total)}, ` +
			`personal_share_total ${usd(row.personal_share_total)}); this script corrects only an invoice without them`);
	}
	checks.push("no Personal line (the ledger, the snapshot and the row's two Personal columns)");
	const lock = api.invoiceMonthLockBlockers(row);
	if (lock.unreadable) throw new Refusal("the month locks can't be read (period_locks), so no month can be confirmed open; nothing is corrected");
	if (lock.blockers.length) {
		throw new Refusal(`${number}'s week touches a closed month (${lock.blockers.map((b) => (b.periods || []).filter(Boolean).join(", ") || b.detail).join("; ")}); a closed month is never changed`);
	}
	checks.push(`the week's months are open (invoiceMonthLockBlockers())`);
	if (api.TRIP_WORK_DAYS_FROM) {
		throw new Refusal(`TRIP_WORK_DAYS is on (from ${api.TRIP_WORK_DAYS_FROM}): the week's days would also come from trip timestamps and their invoice_paid_days claims; this script corrects only with the rule off`);
	}
	if (api.invoicePaidDaysTablePresent()) {
		const held = db.prepare("SELECT COUNT(*) AS n FROM invoice_paid_days WHERE invoice_id = ?").get(row.id).n;
		if (held) throw new Refusal(`${number} holds ${held} invoice_paid_days row(s); with TRIP_WORK_DAYS off it should hold none, so a person decides`);
	}
	checks.push("TRIP_WORK_DAYS off; no invoice_paid_days row for the invoice");
	const nameNorm = api.normalizeDriverName(row.driver || "");
	if (!nameNorm) throw new Refusal(`${number} names no driver`);
	const weekly = api.liveWeeklyInvoicesForDriverWeek(row.driver, ws);
	if (weekly.length !== 1 || weekly[0].id !== row.id) {
		throw new Refusal(`the driver-week has ${weekly.length} live weekly invoices (${weekly.map((r) => `${r.invoice_number} ${r.status}`).join(", ")}); ` +
			"this script corrects one only when it is the week's one live weekly invoice");
	}
	checks.push("the driver-week's one live weekly invoice");

	// ── the stored figures agree with themselves ────────────────────────────────
	const storedPaid = dates.filter((d, i) => grid[names[i]].completed === true);
	if (JSON.stringify(api.invoicePaidDaysOf(row)) !== JSON.stringify(storedPaid)) throw new Refusal(`${number}'s paid days can't be read consistently from its grid`);
	const storedTotalC = cents(row.total_earnings);
	if (cents(snapshot.totalDue) !== storedTotalC) {
		throw new Refusal(`${number}'s render totalDue ${usd(snapshot.totalDue)} is not its total_earnings ${usd(row.total_earnings)}; the stored invoice disagrees with itself, so a person decides`);
	}
	const gridC = storedPaid.reduce((c, d) => c + cents(grid[nameOf(d)].total), 0);
	if (gridC !== storedTotalC) throw new Refusal(`${number}'s day grid comes to ${usd(gridC / 100)}, not its total_earnings ${usd(row.total_earnings)}; a person decides`);
	if (Number(row.loads_count) !== storedPaid.length) throw new Refusal(`${number}'s loads_count ${row.loads_count} is not the ${storedPaid.length} day(s) its grid pays; a person decides`);
	checks.push("the stored invoice agrees with itself: totalDue = total_earnings = its grid's days, loads_count = the days paid");

	// ── the PDF on disk ─────────────────────────────────────────────────────────
	const fileName = String(row.pdf_file_name || "");
	if (!fileName || path.basename(fileName) !== fileName || fileName.startsWith(".")) throw new Refusal(`${number}'s pdf_file_name ${JSON.stringify(fileName)} is not a plain file name`);
	const sharers = db.prepare("SELECT invoice_number FROM invoices WHERE pdf_file_name = ? COLLATE NOCASE AND id != ?").all(fileName, row.id);
	if (sharers.length) {
		throw new Refusal(`${sharers.map((x) => x.invoice_number).join(", ")} also names the PDF file ${fileName}; re-rendering it would change ${sharers.length === 1 ? "that invoice's" : "those invoices'"} document`);
	}
	const pdfPath = path.join(dataDir, "uploads", "invoices", fileName);
	let st;
	try { st = fs.lstatSync(pdfPath); } catch { throw new Refusal(`${number}'s PDF ${pdfPath} is not on disk, so there is nothing to back up and replace`); }
	if (!st.isFile()) throw new Refusal(`${pdfPath} is not a regular file`);
	const servedPdf = { path: pdfPath, sha256: sha256Of(fs.readFileSync(pdfPath)), mode: st.mode & 0o777, uid: st.uid, gid: st.gid };
	checks.push("the issued PDF is on disk and no other invoice names its file");

	// ── the recompute and the overrides ─────────────────────────────────────────
	const r = recompute(db, api, values, { driverName: row.driver, weekEnd: we });
	const overrides = weekOverrides(db, api, nameNorm, ws, we);
	const adds = overrides.filter((o) => o.action === "add");
	if (adds.length) throw new Refusal(`a live "add" override for the driver is inside the week (${adds.map((o) => `${o.day} #${o.id}`).join(", ")}); this script only takes days off, so a person decides`);
	const removes = overrides.filter((o) => o.action === "remove");
	const storedIds = parseJson(row.load_ids || "[]", null);
	if (!Array.isArray(storedIds)) throw new Refusal(`${number}'s load_ids can't be read`);
	if (!sameSet(storedIds, r.loadIds)) {
		throw new Refusal(`the recompute bills other loads than ${number} (load_ids ${JSON.stringify(storedIds)} -> ${JSON.stringify(r.loadIds)}): a load joined or left the week, so a person decides`);
	}
	if (cents(r.ratePerLoad) !== cents(row.rate_per_load)) {
		throw new Refusal(`the recompute's rate_per_load is ${usd(r.ratePerLoad)}, ${number}'s ${usd(row.rate_per_load)}: a rate moved, so a person decides`);
	}
	checks.push("load_ids equal (as a set); rate_per_load equal");
	const newGrid = r.days;
	const newPaid = dates.filter((d, i) => newGrid[names[i]] && newGrid[names[i]].completed === true);
	const added = newPaid.filter((d) => !storedPaid.includes(d));
	if (added.length) throw new Refusal(`the recompute pays ${added.map(dayText).join(", ")}, which ${number} does not; this script only takes days off, so a person decides`);
	const removedDays = storedPaid.filter((d) => !newPaid.includes(d));
	const removeOn = new Map(removes.map((o) => [o.day, o]));
	for (const d of removedDays) {
		if (removeOn.has(d)) continue;
		const holder = r.held.get(d);
		const why = holder ? `a live manual invoice (${holder.invoiceNumber}, ${holder.status}) pays it now` : "the ELD, the sheet or the overrides changed since the invoice was generated";
		throw new Refusal(`${dayText(d)} is paid on ${number} and not in the recompute, but there is no live "remove" override for the driver on it (${why}); only a day a Super Admin removed is taken off, so a person decides`);
	}
	for (const o of removes) {
		if (!storedPaid.includes(o.day)) {
			throw new Refusal(`the live "remove" override on ${dayText(o.day)} (#${o.id}) is on a day ${number} does not pay; every override in the week must be on a day this invoice still pays, so a person decides`);
		}
	}
	if (!removedDays.length) {
		throw new Refusal(`nothing to correct: the recompute pays the same days as ${number}, and the driver has no live "remove" override in the week (add them on the Driver Pay Overrides page first)`);
	}
	checks.push(`each of the ${removedDays.length} day(s) the recompute no longer pays has a live "remove" override, and every such override in the week is on a day the invoice pays; no "add" override in the week`);

	// ── the months each removed day moves ───────────────────────────────────────
	if (!api.periodLocksReadable()) throw new Refusal("the month locks can't be read (period_locks), so no month can be confirmed open; nothing is corrected");
	const jobTracking = api.parseSheet({ values: values.values });
	jobTracking.data = api.deduplicateLoads(jobTracking.data, jobTracking.headers);
	const blankDropoffFrom = api.financialsCalc.loadPayDays.blankFallbackFromEnv(api[WORLD_ENV], "dropoff");
	const tripCover = api.tripDayLockCover(jobTracking.headers);
	const unpaidRow = (name) => api.invoiceDayGrid({ days: new Set(), weekStart: ws, dailyRate: r.dailyRate })[name];
	const removed = [];
	for (const d of removedDays) {
		const own = d.slice(0, 7);
		const periods = api.excludedDayPeriods({ driver: nameNorm, date: d, action: "remove", jobTracking, blankDropoffFrom, tripCover });
		if (periods === null) throw new Refusal(`${dayText(d)}: the months it moves can't be resolved (a load's trip history or ELD could not be read); nothing is corrected`);
		if (periods.length !== 1 || periods[0] !== own) {
			throw new Refusal(`${dayText(d)}: excludedDayPeriods() gives ${periods.join(", ") || "no month"}; a removed day may move only its own month (${own}), so a person decides`);
		}
		if (api.periodWriteLocked(own)) throw new Refusal(`${dayText(d)}: ${own} is closed (or its lock can't be read); a closed month is never changed`);
		const name = nameOf(d);
		if (JSON.stringify(newGrid[name]) !== JSON.stringify(unpaidRow(name))) throw new Refusal(`${dayText(d)}: the recompute's row is not the unpaid row generate writes`);
		removed.push({ day: d, name, override: removeOn.get(d), periods, stored: grid[name], next: newGrid[name] });
	}
	checks.push("each removed day moves only its own month, which is open (excludedDayPeriods(), periodWriteLocked()); its new row is generate's unpaid row");

	// ── the kept days and the totals ────────────────────────────────────────────
	for (const d of newPaid) {
		const a = grid[nameOf(d)];
		const b = newGrid[nameOf(d)];
		const diffs = [];
		if (cents(a.total) !== cents(b.total)) diffs.push(`total ${usd(a.total)} -> ${usd(b.total)}`);
		if (a.rate === undefined || cents(a.rate) !== cents(b.rate)) diffs.push(`rate ${a.rate === undefined ? "not stored" : usd(a.rate)} -> ${usd(b.rate)}`);
		if (!sameSet(splitBol(a.loadBol), splitBol(b.loadBol))) diffs.push(`loads ${a.loadBol || "none"} -> ${b.loadBol || "none"}`);
		if (diffs.length) throw new Refusal(`${dayText(d)}, a day the invoice keeps, changes in the recompute (${diffs.join("; ")}); only the removed days may change, so a person decides`);
	}
	checks.push("every kept day keeps its completed flag, total, rate and loads (as a set)");
	const removedC = removed.reduce((c, x) => c + cents(x.stored.total), 0);
	const newTotalC = storedTotalC - removedC;
	if (cents(r.totalEarnings) !== newTotalC) {
		throw new Refusal(`the recompute's total ${usd(r.totalEarnings)} is not ${number}'s total less the removed days (${usd(storedTotalC / 100)} - ${usd(removedC / 100)} = ${usd(newTotalC / 100)})`);
	}
	if (r.loadsCount !== Number(row.loads_count) - removed.length) {
		throw new Refusal(`the recompute's loads_count ${r.loadsCount} is not ${number}'s ${row.loads_count} less the ${removed.length} removed day(s)`);
	}
	checks.push(`total_earnings and totalDue: ${usd(storedTotalC / 100)} - ${usd(removedC / 100)} = ${usd(newTotalC / 100)}; loads_count ${row.loads_count} - ${removed.length} = ${r.loadsCount}; the recompute agrees`);

	// ── what the apply writes ───────────────────────────────────────────────────
	const next = parseJson(row.render_data, null);
	next.days = newGrid;
	next.totalDue = r.totalEarnings;
	const nextJson = JSON.stringify(next);
	const afterRow = { ...row, render_data: nextJson, total_earnings: r.totalEarnings, loads_count: r.loadsCount };
	const afterDays = api.invoicePaidDaysOf(afterRow);
	if (JSON.stringify(afterDays) !== JSON.stringify(newPaid)) throw new Refusal("the corrected grid does not read back as the kept days");
	const flags = {
		TRIP_WORK_DAYS_FROM: api.TRIP_WORK_DAYS_FROM || null, DRIVER_RATE_ONLY_FROM: api.DRIVER_RATE_ONLY_FROM || null,
		INVOICE_BLANK_PICKUP_FALLBACK_FROM: api.INVOICE_BLANK_PICKUP_FALLBACK_FROM || null, preDispatch: !!api.preDispatchPayDayFilter(), APP_TIMEZONE: api.APP_TIMEZONE,
	};
	const fingerprint = sha256Of(JSON.stringify({
		v: 1, row, pdf: servedPdf.sha256, overrides, periods: removed.map((x) => [x.day, x.periods]), nextJson, total: r.totalEarnings, loadsCount: r.loadsCount, flags,
	})).slice(0, 16);
	return {
		state: "plan", number, row, snapshot, next, nextJson, recompute: r, storedGrid: grid, newGrid, dates, removed, kept: newPaid, overrides, servedPdf, flags, checks, fingerprint,
		before: { days: storedPaid, total: row.total_earnings, loadsCount: Number(row.loads_count), totalDue: snapshot.totalDue, totalDueWithAdjustment: api.invoiceTotalDue(row) },
		after: { days: afterDays, total: r.totalEarnings, loadsCount: r.loadsCount, totalDue: r.totalEarnings, totalDueWithAdjustment: api.invoiceTotalDue(afterRow) },
		expenses: {
			stored: { ids: parseJson(row.expense_ids || "[]", []), total: row.expenses_total },
			now: { ids: r.expenseIds, total: r.expensesTotal },
		},
	};
}

// Refuses while an adjustment saved under ADJUST_RACE_MS ago may still be
// re-rendering the PDF (the adjust route writes outside a transaction).
function adjustRace(row, nowMs, suffix = "") {
	const at = Date.parse(String(row.adjusted_at || ""));
	if (Number.isFinite(at) && nowMs - at < ADJUST_RACE_MS) {
		throw new Refusal(`${row.invoice_number}'s adjustment was saved ${Math.max(0, Math.round((nowMs - at) / 1000))} s ago (adjusted_at ${row.adjusted_at}) and its PDF may still be re-rendering; ` +
			`nothing was written${suffix}. Wait 2 minutes, then run the dry run again and apply with its fingerprint`);
	}
}

// The owner-only backup beside the database (outside uploads/): the row as read
// and the issued PDF, each read back and checked.
function writeBackup(dbFile, p, nowMs) {
	const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const dir = `${dbFile}.pre-invoice-correction-${p.row.id}-${stamp}`;
	fs.mkdirSync(dir, { mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const rowFile = path.join(dir, "invoice-row.json");
	fs.writeFileSync(rowFile, `${JSON.stringify(p.row, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	const pdf = path.join(dir, path.basename(p.servedPdf.path));
	fs.copyFileSync(p.servedPdf.path, pdf, fs.constants.COPYFILE_EXCL);
	fs.chmodSync(pdf, 0o600);
	const pdfSha256 = sha256Of(fs.readFileSync(pdf));
	if (pdfSha256 !== p.servedPdf.sha256) throw new Error(`the backup of the PDF (${pdf}) is not the file the plan read (it changed while it was copied); nothing was written to the database`);
	const back = parseJson(fs.readFileSync(rowFile, "utf8"), null);
	if (!back || back.render_data !== p.row.render_data) throw new Error(`the backup of the row (${rowFile}) does not read back; nothing was written to the database`);
	return { dir, rowFile, pdf, pdfSha256 };
}

// A file renamed into `finalPath` takes the served file's mode, and its owner
// when this process may set one.
function matchServedFile(file, served) {
	fs.chmodSync(file, served.mode);
	if (typeof process.getuid === "function" && process.getuid() === 0) fs.chownSync(file, served.uid, served.gid);
}

// After a COMMIT that failed once the new PDF was in place: the issued PDF goes
// back from the backup, by a temporary file and a rename.
function restoreServed(backup, finalPath, served) {
	const tmp = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${process.pid}.${Date.now()}.restore.tmp`);
	try {
		fs.copyFileSync(backup.pdf, tmp, fs.constants.COPYFILE_EXCL);
		matchServedFile(tmp, served);
		fs.renameSync(tmp, finalPath);
	} catch (err) {
		try { fs.unlinkSync(tmp); } catch { /* renamed into place, or never written */ }
		throw err;
	}
	if (sha256Of(fs.readFileSync(finalPath)) !== backup.pdfSha256) throw new Error("the restored PDF is not the backed-up one");
}

// After the commit: the served file must be the one this run renamed into place
// and the row must hold what it wrote. { ok, servedSha256, rowMatches }.
function verifyServed({ db, id, file, sha256: want, renderData }) {
	let servedSha256 = null;
	try { servedSha256 = sha256Of(fs.readFileSync(file)); } catch { servedSha256 = null; }
	const now = db.prepare("SELECT render_data FROM invoices WHERE id = ?").get(id);
	const rowMatches = !!now && now.render_data === renderData;
	return { ok: servedSha256 === want && rowMatches, servedSha256, rowMatches };
}

// The app checkout's commit: git's HEAD, else the client build's record.
function appCommit() {
	const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 10000 });
	const head = String(r.stdout || "").trim();
	if (r.status === 0 && /^[0-9a-f]{40}$/.test(head)) return head;
	let built = "";
	try { built = fs.readFileSync(path.join(ROOT, "client", "dist", ".build-commit"), "utf8").trim(); } catch { built = ""; }
	return /^[0-9a-f]{40}$/.test(built) ? built : "unknown";
}

// The audit row's details: the before and after, each override, the PDF
// hashes, the commit and the backup.
function auditDetails(p, { newSha256, gitCommit, backupDir }) {
	const removed = p.removed.map((x) => `${x.day} (override #${x.override.id}, ${JSON.stringify(x.override.reason)}, ` +
		`by ${x.override.excludedBy || "(unknown)"} at ${x.override.excludedAt || "(unknown)"}, period ${x.periods.join("+")})`).join("; ");
	return `${p.number} (weekly, Submitted): corrected in place by scripts/correct-weekly-invoice.js from a recompute with the driver's live Driver Pay Overrides (${DECISION}); ` +
		`days ${p.before.days.join(", ")} -> ${p.after.days.join(", ") || "none"}; total ${usd(p.before.total)} -> ${usd(p.after.total)}; ` +
		`loads_count ${p.before.loadsCount} -> ${p.after.loadsCount}; totalDue ${usd(p.before.totalDue)} -> ${usd(p.after.totalDue)}; ` +
		`removed ${removed}; PDF ${p.row.pdf_file_name} sha256 ${p.servedPdf.sha256} -> ${newSha256}; git ${gitCommit}; backup ${backupDir}`;
}

// The run. A dry run returns the plan; --apply writes it, as the header says.
// `clock` and `commit` are the run's clock and git commit (tests pass fixed ones).
// Returns { state: "dry-run" | "already" | "written", plan, planMs, lockMs?, backup?, newSha256?, auditId?, check? }.
async function run(db, api, values, opts, { dataDir, dbFile, clock = () => Date.now(), commit = appCommit } = {}) {
	// With the daily-rate rule on, pricing reads the rule's start record, which
	// the server stamps when it first runs with the flag; on a database it never
	// ran with, a handle that can write would stamp it here.
	if (api.DRIVER_RATE_ONLY_FROM && !driverRateOnly.readStart(db) && (opts.apply || !db.readonly)) {
		throw new Refusal(`DRIVER_RATE_ONLY is on (from ${api.DRIVER_RATE_ONLY_FROM}) but the app has never run with it on this database (no start record), so pricing would stamp the rule's start record here; ` +
			"start the app first, or run the dry run on a read-only handle (the command line's dry run is one)");
	}
	const t0 = Date.now();
	const first = plan(db, api, values, opts, { dataDir });
	const planMs = Date.now() - t0;
	if (first.state === "already") return { state: "already", plan: first };
	if (!opts.apply) return { state: "dry-run", plan: first, planMs };
	if (opts.expect !== first.fingerprint) {
		throw new Refusal(`--expect=${opts.expect} is not this run's fingerprint (${first.fingerprint}): the invoice, its overrides, its PDF or the recompute changed since that dry run, ` +
			"or the dry run was another invoice's; nothing was written. Run the dry run again and check it");
	}
	adjustRace(first.row, clock());
	const gitCommit = commit();
	const backup = writeBackup(dbFile, first, clock());
	const { templateName, data } = api.personalRenderData(first.next, first.row, []);
	const pdf = await api.renderPolicy(templateName, data);
	if (!Buffer.isBuffer(pdf) || !pdf.length) throw new Error("the renderer returned no PDF; nothing was written");
	const newSha256 = sha256Of(pdf);
	const finalPath = first.servedPdf.path;
	const tmpPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	let renamed = false;
	let lockMs = null;
	let auditId = null;
	try {
		fs.writeFileSync(tmpPath, pdf, { flag: "wx", mode: 0o600 });
		matchServedFile(tmpPath, first.servedPdf);
		db.transaction(() => {
			const held = Date.now();
			let again;
			try {
				again = plan(db, api, values, opts, { dataDir });
			} catch (err) {
				if (err instanceof Refusal) throw new Refusal(`${err.message} (found once the database was held, after the PDF was rendered; nothing was written)`);
				throw err;
			}
			if (again.state === "already") throw new AlreadyDone(again);
			if (again.fingerprint !== opts.expect) {
				throw new Refusal(`${first.number} changed while this run rendered its PDF (its fingerprint is now ${again.fingerprint}); nothing was written. Run the dry run again`);
			}
			if (again.servedPdf.sha256 !== backup.pdfSha256) throw new Refusal(`the served PDF is no longer the one backed up in ${backup.dir}; nothing was written`);
			adjustRace(again.row, clock(), " (found once the database was held)");
			const details = auditDetails(first, { newSha256, gitCommit, backupDir: backup.dir });
			const upd = db.prepare("UPDATE invoices SET render_data = ?, total_earnings = ?, loads_count = ? WHERE id = ? AND render_data = ? AND status = 'Submitted' AND COALESCE(deleted_at, '') = ''")
				.run(first.nextJson, first.after.total, first.after.loadsCount, first.row.id, first.row.render_data);
			if (upd.changes !== 1) throw new Refusal(`${first.number} changed as it was written; nothing was written`);
			auditId = Number(db.prepare(INSERT_AUDIT).run(new Date(clock()).toISOString(), 0, ACTOR, "system", AUDIT_ACTION, "invoice", String(first.row.id), details).lastInsertRowid);
			fs.renameSync(tmpPath, finalPath);
			renamed = true;
			lockMs = Date.now() - held;
		}).immediate();
	} catch (err) {
		try { fs.unlinkSync(tmpPath); } catch { /* renamed into place, or never written */ }
		if (err instanceof AlreadyDone) return { state: "already", plan: err.found, backup };
		if (renamed) {
			let restored = "put back from the backup";
			try { restoreServed(backup, finalPath, first.servedPdf); } catch (e) { restored = `NOT put back (${e.message}): copy ${backup.pdf} over ${finalPath}`; }
			throw new Error(`the write failed after the corrected PDF was renamed into place (${err.message}); the database is unchanged and the issued PDF was ${restored}`);
		}
		throw err;
	}
	const check = verifyServed({ db, id: first.row.id, file: finalPath, sha256: newSha256, renderData: first.nextJson });
	return { state: "written", plan: first, planMs, lockMs, backup, newSha256, auditId, check };
}

// The run's report, line by line.
function describe(out) {
	const p = out.plan;
	if (out.state === "already") {
		return [
			`already corrected: audit row #${p.audit.id} (${p.audit.timestamp}, ${p.audit.username}) for ${p.row.invoice_number} (id ${p.row.id}, ${p.row.status}); nothing written`,
			`  ${p.audit.details}`,
		];
	}
	const lines = [];
	const r = p.recompute;
	const f = p.flags;
	if (out.state === "dry-run") lines.push("DRY RUN: nothing written.");
	lines.push(`Invoice ${p.number} (id ${p.row.id}): weekly, Submitted${p.row.submitted_at ? ` (submitted ${p.row.submitted_at})` : ""}, driver "${p.row.driver}", week ${p.row.week_start} to ${p.row.week_end}`);
	lines.push(`Flags as this run reads them: TRIP_WORK_DAYS ${f.TRIP_WORK_DAYS_FROM ? `from ${f.TRIP_WORK_DAYS_FROM}` : "off"}, DRIVER_RATE_ONLY ${f.DRIVER_RATE_ONLY_FROM ? `from ${f.DRIVER_RATE_ONLY_FROM}` : "off"}, ` +
		`INVOICE_BLANK_PICKUP_FALLBACK ${f.INVOICE_BLANK_PICKUP_FALLBACK_FROM ? `from ${f.INVOICE_BLANK_PICKUP_FALLBACK_FROM}` : "off"}, pre-dispatch rule ${f.preDispatch ? "on" : "off"}; ` +
		`APP_TIMEZONE ${f.APP_TIMEZONE}; process TZ ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
	lines.push(`Pay: fixed daily rate; the week's rate ${usd(r.dailyRate)} (drivers directory ${Number(r.payDaily) > 0 ? usd(r.payDaily) : "not set"}, truck ${r.truckRate === undefined ? "none" : usd(r.truckRate)})`);
	lines.push("Overrides this correction relies on (the driver's live \"remove\" rows in the week):");
	for (const x of p.removed) {
		const o = x.override;
		lines.push(`  ${dayText(x.day)}: override #${o.id}, by ${o.excludedBy || "(unknown)"} at ${o.excludedAt || "(unknown)"}, reason ${JSON.stringify(o.reason)}`);
	}
	lines.push("Periods each removed day moves (excludedDayPeriods(), as the overrides route's gate reads them):");
	for (const x of p.removed) lines.push(`  ${x.day}: ${x.periods.join(", ")} (open)`);
	lines.push("Day grid, stored -> new:");
	const cell = (e) => (e && e.completed ? `${usd(e.total)}  ${e.loadBol || "no load"}` : `${usd(0)}  not paid`);
	const newCell = (e) => (e && e.completed
		? `${usd(e.total)}  ${e.loadBol || "no load"} (lists ${(e.listed || []).join(", ") || "none"})${(e.scheduled || []).length ? ` (scheduled: ${e.scheduled.join(", ")})` : ""}`
		: `${usd(0)}  not paid`);
	p.dates.forEach((d) => {
		const name = weekdayOf(d);
		const a = p.storedGrid[name];
		const b = p.newGrid[name];
		const tag = p.removed.some((x) => x.day === d) ? "removed" : b && b.completed ? "kept" : "not paid";
		lines.push(`  ${name.padEnd(9)}  ${d}  ${cell(a)}  ->  ${newCell(b)}  (${tag})`);
	});
	lines.push("Changed figures:");
	lines.push(`  days paid: ${p.before.days.length} -> ${p.after.days.length}`);
	lines.push(`  total_earnings: ${usd(p.before.total)} -> ${usd(p.after.total)}`);
	lines.push(`  loads_count: ${p.before.loadsCount} -> ${p.after.loadsCount}`);
	lines.push(`  render totalDue: ${usd(p.before.totalDue)} -> ${usd(p.after.totalDue)}`);
	lines.push(`  total due with the adjustment (${usd(p.row.adjustment)}): ${usd(p.before.totalDueWithAdjustment)} -> ${usd(p.after.totalDueWithAdjustment)}`);
	let ids = [];
	try { ids = JSON.parse(p.row.load_ids || "[]"); } catch { ids = []; }
	lines.push(`Unchanged: the number, status Submitted, rate_per_load ${usd(p.row.rate_per_load)}, load_ids (${ids.length}: ${ids.join(", ")}), adjustment ${usd(p.row.adjustment)}, ` +
		"the submission and signature dates, the PDF file name");
	const e = p.expenses;
	const sameExpenses = sameSet(e.stored.ids, e.now.ids) && cents(e.stored.total) === cents(e.now.total);
	lines.push(`Expenses (printed, not checked; kept as stored): stored ${e.stored.ids.length} receipt(s), ${usd(e.stored.total)}; the recompute finds ${e.now.ids.length}, ${usd(e.now.total)}` +
		(sameExpenses ? " (the same)" : ` (DIFFERENT: stored ${JSON.stringify(e.stored.ids)}, now ${JSON.stringify(e.now.ids)})`));
	lines.push("Checks passed:");
	for (const c of p.checks) lines.push(`  - ${c}`);
	if (out.state === "dry-run") {
		lines.push(`The apply writes: a backup of the row and the PDF in <the database>.pre-invoice-correction-${p.row.id}-<UTC time>/ (owner-only); the PDF ${p.servedPdf.path} ` +
			`(sha256 ${p.servedPdf.sha256} now), re-rendered from the corrected data with the row's adjustment; the row's render_data, total_earnings and loads_count; ` +
			`one audit_trail row (${AUDIT_ACTION}, invoice ${p.row.id}, by "${ACTOR}", role system)`);
		lines.push(`Plan time: ${out.planMs} ms (the apply plans again inside its write transaction, holding SQLite's write lock about this long)`);
		lines.push(`Fingerprint: ${p.fingerprint}`);
		lines.push(`To apply: add --apply --expect=${p.fingerprint} to this command line`);
		return lines;
	}
	lines.push(`WRITTEN: ${p.number} (id ${p.row.id}) corrected in place: total ${usd(p.before.total)} -> ${usd(p.after.total)}, ${p.after.days.length} day(s); audit row #${out.auditId}`);
	lines.push(`Backup: ${out.backup.dir}`);
	lines.push(`PDF: ${p.servedPdf.path} sha256 ${p.servedPdf.sha256} -> ${out.newSha256}`);
	lines.push(`Write lock held: ${out.lockMs} ms (plan time ${out.planMs} ms)`);
	if (out.check.ok) {
		lines.push("Post-commit check: the served PDF and the row are this run's");
	} else {
		lines.push(`POST-COMMIT CHECK FAILED: the served PDF's sha256 is ${out.check.servedSha256 || "unreadable"} (this run wrote ${out.newSha256}); the row ${out.check.rowMatches ? "holds" : "does NOT hold"} the corrected data.`);
		lines.push("  Remedy: something re-rendered the PDF at the same moment (an adjustment). Re-save the invoice's adjustment, same amount and note, on the Invoices screen:");
		lines.push("  the adjust route re-renders the PDF from the row's corrected data. Then check the PDF against the row.");
	}
	return lines;
}

// Returns the exit code. The PDF renderer's shared browser is shut down
// whatever happens, or it would keep the process alive after the write.
async function main() {
	const opts = readOptions(process.argv.slice(2));
	const dbPath = opts.db || path.join(ROOT, "app.db");
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath, envFile: opts.envFile }));
	} catch (err) {
		throw new Refusal(err.message);
	}
	const values = await sheetFor({ "values-json": opts.valuesJson || undefined, "sheet-id": opts.sheetId || undefined, key: opts.key || undefined, "env-file": opts.envFile || undefined, db: dbPath }, ROOT);
	const dataDir = path.dirname(dbFile) === fs.realpathSync(ROOT) ? ROOT : path.dirname(dbFile);
	const db = openDb({ root: ROOT, dbFile, readonly: !opts.apply });
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	try {
		if (!opts.apply && !db.readonly) throw new Error("refusing: the dry run's SQLite handle is not read-only");
		const { api } = buildWorld({ db, env, dataDir, log: { log() {}, info() {}, warn: (...a) => console.error(...a), error: (...a) => console.error(...a) } });
		console.log(`Database: ${dbFile} (${dataDir === ROOT ? "the app's own" : "a copy"}); PDFs: ${path.join(dataDir, "uploads", "invoices")}`);
		const out = await run(db, api, values, opts, { dataDir, dbFile });
		for (const line of describe(out)) console.log(line);
		return out.state === "written" && !out.check.ok ? 3 : 0;
	} finally {
		db.close();
		try { await appRequire("./lib/pdf-browser").shutdownBrowser(); } catch { /* no browser was started */ }
	}
}

if (require.main === module) {
	main().then((code) => process.exit(code)).catch((err) => {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`ERROR: ${err.stack || err.message}`);
		process.exit(1);
	});
}

module.exports = {
	ACTOR, AUDIT_ACTION, ADJUST_RACE_MS, ROOTS, PROVIDED, DENIED, Refusal,
	readOptions, buildWorld, recompute, plan, run, describe, verifyServed,
};
