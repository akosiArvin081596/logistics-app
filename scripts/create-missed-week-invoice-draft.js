#!/usr/bin/env node
// scripts/create-missed-week-invoice-draft.js — drafts ONE invoice for days of a
// driver-week that has NO weekly invoice, so the driver is paid for them. The
// gap it fills: a load is billed in the week of its completion date
// (invoiceWeekVerdict()), and that week's invoice counts only the window days
// inside it (invoiceWeekPaidDays()). A load worked in one week and completed in
// the next leaves its earlier days on no invoice, and when the earlier week has
// no other load, generating it again bills nothing ("No completed loads").
// scripts/create-correction-invoice-draft.js covers a week that HAS a weekly
// invoice; this script refuses such a week and names that one.
//
// What it writes, in one transaction, when every check passes:
//   - one new invoice in Draft status, through the manual-invoice path of
//     POST /api/invoices/manual: the server's own sanitizeManualInvoiceRows(),
//     manualInvoiceTotals(), generateInvoiceNumber() (an INV-M- number),
//     findInvoicePayee() (the address and phone on file), the
//     "service_invoice_manual" template through renderPolicy(), and
//     commitInvoiceWithPdf() (the row and its PDF written together), all lifted
//     from this checkout's server.js (scripts/lib/server-lift.js). The row is the
//     route's own INSERT (scripts/test-create-missed-week-invoice-draft.js pins it
//     to the route's, column for column);
//       payee        the driver, as his account spells the name;
//       period       the week, from the first day of the earliest day's month when
//                    the week touches a closed month (as the server's
//                    createWorkDayCorrection() does), so the draft touches none;
//       issue date   --date (default: today, APP_TIMEZONE);
//       lines        one per day, dated that day:
//                    "Missed week <Saturday> to <Friday>: <Weekday, Month D, YYYY>, $<rate>";
//       notes        the week, the load(s) behind the days and why no invoice
//                    paid them;
//     and, while the trip work-day rule is set (TRIP_WORK_DAYS_FROM), the route's
//     `days`: paidDays in the snapshot and claimInvoicePaidDays() in the write;
//   - one audit_trail row, a system change (user 0, username
//     "system: missed-week invoice script", role "system", action
//     create_missed_week_invoice) naming the invoice, the driver, the week, the
//     days, the rate and where it came from, and the total.
// It never submits, approves, pays or emails anything and never touches a
// closed month, an override, a payout, a lock or a frozen item.
//
// Which days, and at what rate: the weekly generator's own code, lifted. Each
// day must be one invoiceWeekPaidDays() pays for one of the driver's completed,
// live loads billed in another week (its pay window, the ELD intersection, the
// pre-dispatch and blank-pickup rules and the Super Admin day overrides, all as
// the app's flags have them), or a day a Super Admin added for the driver. A day
// the rules would not pay is refused, with why (no window covers it, the ELD
// shows the truck parked, an override removed it); there is no option to force
// one: a Super Admin adds the day in the app (excluded days, "add") and the run
// then reads it. --loads limits the loads that may justify a day (a load whose
// appointments look mistyped stays out unless named). The rate is the one the
// generator would price the day at today: getDriverPayStructures(),
// truckDailyRateCandidates(), resolveDailyRate() and invoiceDayPricing() (the
// daily-rate rule's rate in effect that day when DRIVER_RATE_ONLY is on); every
// run prints where it came from.
//
// Idempotent, checked first: when a live draft of this script for the driver and
// week (a manual invoice, not deleted, not Rejected, whose lines start
// "Missed week <Saturday> to <Friday>:") names exactly these days at the rate
// they price at now, it prints "already drafted" with its number, status and
// total and writes nothing (exit 0), whatever the date and the month locks say.
// The same days at another rate, or some of the days, refuse.
//
// Refused (exit 2, nothing written) when:
//   - the driver name does not match exactly one Driver account and one
//     drivers_directory row (normalizeDriverName()), or the driver is paid a
//     percentage of revenue (his invoice reads revenue, not days);
//   - the driver has a weekly invoice for the week, any status (the correction
//     script applies), or the generator bills a load in the week, or the trip
//     work-day rule pays a day of it (generate the week in the app);
//   - a day is not one the rules pay (above), or --loads names no such load;
//   - a day is already paid, or may be, by another live invoice of the driver
//     (any status but Rejected, not deleted, any spelling of the name): a
//     paid-days record (invoice_paid_days); a weekly invoice whose day grid bills
//     it, or which covers it with no grid; a manual invoice with a line dated it,
//     paidDays naming it, an undated line (or no line) over a period covering it,
//     or a line or notes naming it (2026-10-15, 10/15, October 15 or Oct 15) when
//     its period ends on or after the week's start; a weekly invoice from the
//     week on whose adjustment note names it;
//   - --date is after today, before the last day, or in a closed month; a day's
//     month is closed (period_locks; an unreadable table counts as closed);
//   - the state read before rendering the PDF changed by the time the database
//     is held (planned again inside the write's transaction);
//   - a write with DRIVER_RATE_ONLY on, on a database the app never ran with it
//     (the write would stamp the rule's start record; the dry run reads it in
//     memory).
// Every run lists the driver's live invoices from the week on (number, status,
// total due, lines or adjustment), the week's other days the same loads would
// pay, and the "related" loads: the driver's other loads whose window touches
// the week, with the days the rule would pay for each and why none is used. A
// day is never drafted unless named in --days (and its load allowed by --loads).
//
// --dry-run opens the database read-only, prints exactly what it would write
// (the invoice row, its lines and totals, its PDF file name and the audit row)
// and writes nothing: no row, no file, no PDF rendered.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/create-missed-week-invoice-draft.js --db=app.db --sheet-id=<id> --driver "<name>" --week-start <Saturday> --days <YYYY-MM-DD,...> [--loads <id,...>] [--date <YYYY-MM-DD>] --dry-run
//   (the same without --dry-run writes)
//   --db <file>           the app directory's own app.db, or a copy under the
//                         temp directory (scripts/lib/ledger-world.js dbScope());
//                         a copy's PDF goes beside it, in uploads/invoices/
//   --sheet-id <id>|env   Job Tracking, read with the read-only scope (env: the
//                         SPREADSHEET_ID the .env sets); or
//   --values-json <file>  a saved values.get of Job Tracking
//   --key <file>          the service-account key (default: the app's)
//   --env-file <file>     with a copy only: the flags to run with, in place of
//                         the app's .env
//   --loads <id,...>      only these loads (Load ID, or its last 4+ characters)
//                         may justify a day
// Exit codes: 0 written, already drafted, or dry run; 1 error (nothing
// written); 2 refused (nothing written).
//
// Required as a module (by its test runner) it runs nothing and exports its
// parts.

"use strict";

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { parseArgs, sheetFor, envFor, openDb } = require("./lib/ledger-world");
const correction = require("./create-correction-invoice-draft");
const driverRateOnly = require("../lib/driver-rate-only");

const { namesDay, monthsBetween, gridBills, isCalendarDay, weekdayOf, longDay, monthLabel, cents, usd, usdShort, parseJson, INSERT_INVOICE, INSERT_AUDIT } = correction;

const ROOT = path.join(__dirname, "..");
const ACTOR = "system: missed-week invoice script";
const SYSTEM_USER = Object.freeze({ id: 0, username: ACTOR, role: "system" });
const AUDIT_ACTION = "create_missed_week_invoice";
const OPTIONS = ["driver", "week-start", "days", "date", "loads", "db", "values-json", "sheet-id", "key", "env-file", "dry-run"];
const TEMPLATE = "service_invoice_manual";
// What the PDF prints under "Prepared by".
const PREPARED_BY = "LogisX missed-week draft (script)";
// A window this long, or a pickup this many days before the load's Assigned
// Date, is named in the output: its appointments may be mistyped.
const SUSPECT_DAYS = 7;

// What the script lifts from server.js, and what it must never reach.
const ROOTS = [
	// The manual-invoice path.
	"sanitizeManualInvoiceRows", "manualInvoiceTotals", "generateInvoiceNumber", "invoicePdfFileName", "commitInvoiceWithPdf",
	"findInvoicePayee", "reservedDriverNameRefusal", "normalizeDriverName", "invoiceTotalDue", "periodWriteLocked", "appTodayKey",
	"renderPolicy", "appTime", "APP_TIMEZONE", "claimInvoicePaidDays", "invoicePaidDayHolders", "invoicePaidDaysTablePresent",
	"TRIP_WORK_DAYS_FROM", "driverAccountsNamed",
	// The weekly generator's days and rate.
	"jobTrackingRowsOf", "invoiceWeekColumns", "invoiceWeekVerdict", "invoiceCompletionDay", "selectInvoiceWeekLoads",
	"driverCompletedLiveLoads", "invoiceWeekPaidDays", "invoiceDayPricing", "liveWeeklyInvoicesForDriverWeek",
	"getDriverPayStructures", "truckDailyRateCandidates", "resolveDailyRate", "driverRateOnlyApplies", "driverDayRater",
	"DRIVER_RATE_ONLY_FROM", "loadKeySet", "getDeletedLoadIds", "normalizeLoadId", "tripDayResolver", "invoiceExtraRuleLoads",
	"invoiceTruckVidReader", "getEldTravelDaysByVehicle", "getAllExcludedDriverDays", "jobTrackingMonthCols", "parseInvoiceDate",
	"fmtLocalDate", "preDispatchPayDayFilter", "INVOICE_BLANK_PICKUP_FALLBACK_FROM",
];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "DATA_DIR", "fetch"];
const DENIED = ["app", "getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive", "notifyChange"];
// What the lifted code may require: Node's path, fs and crypto, and the app's own lib/.
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "fs"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);

class Refusal extends Error {}

const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
// The line prefix that marks this script's drafts for a week.
const missedWeekPrefix = (weekStart, weekEnd) => `Missed week ${weekStart} to ${weekEnd}:`;
const LOAD_TOKEN_RE = /^[A-Za-z0-9#-]{4,40}$/;

// The command line, checked before anything is opened. Returns
// { driver, weekStart, weekEnd, days, date, loads, dryRun, db, valuesJson, sheetId, key, envFile } or throws Refusal.
function readOptions(argv) {
	const args = parseArgs(argv);
	for (const a of argv) {
		if (!a.startsWith("--")) continue;
		const name = a.slice(2).split("=")[0];
		if (!OPTIONS.includes(name)) throw new Refusal(`unknown option --${name}`);
	}
	const text = (k) => (typeof args[k] === "string" ? args[k].trim() : "");
	const driver = text("driver");
	if (!driver || driver.length > 100) throw new Refusal("--driver \"<name>\" is required (at most 100 characters)");
	const weekStart = text("week-start");
	if (!isCalendarDay(weekStart)) throw new Refusal("--week-start <YYYY-MM-DD> is required: the Saturday the billing week starts");
	if (weekdayOf(weekStart) !== "Saturday") throw new Refusal(`--week-start ${weekStart} is a ${weekdayOf(weekStart)}; a billing week runs Saturday to Friday`);
	const weekEnd = addDays(weekStart, 6);
	const days = text("days").split(",").map((s) => s.trim()).filter(Boolean);
	if (!days.length) throw new Refusal("--days <YYYY-MM-DD,...> is required");
	if (days.length > 7) throw new Refusal("--days names more than 7 days; a week has 7");
	for (const d of days) if (!isCalendarDay(d)) throw new Refusal(`--days: ${d} is not a calendar day (YYYY-MM-DD)`);
	if (new Set(days).size !== days.length) throw new Refusal("--days names a day twice");
	for (const d of days) if (d < weekStart || d > weekEnd) throw new Refusal(`${d} is not in the week ${weekStart} to ${weekEnd}`);
	const date = text("date");
	if (args.date !== undefined && !isCalendarDay(date)) throw new Refusal("--date <YYYY-MM-DD>: the issue date, a calendar day");
	let loads = null;
	if (args.loads !== undefined) {
		loads = text("loads").split(",").map((s) => s.trim()).filter(Boolean);
		if (!loads.length || loads.some((l) => !LOAD_TOKEN_RE.test(l))) throw new Refusal("--loads <id,...>: Load IDs or their last 4+ characters (letters, digits, # and -)");
		if (new Set(loads.map((l) => l.toLowerCase())).size !== loads.length) throw new Refusal("--loads names a load twice");
	}
	if (!text("db")) throw new Refusal("--db <file> is required: the app's own app.db, or a copy under the temp directory");
	if (!text("values-json") && !text("sheet-id")) throw new Refusal("--sheet-id <id> (or --values-json <file>) is required; there is no default sheet");
	for (const k of ["key", "env-file"]) if (args[k] !== undefined && !text(k)) throw new Refusal(`--${k} needs a file`);
	if (args["dry-run"] !== undefined && args["dry-run"] !== true) throw new Refusal("--dry-run takes no value");
	return {
		driver, weekStart, weekEnd, days: [...days].sort(), date: date || null, loads, dryRun: args["dry-run"] === true,
		db: text("db"), valuesJson: text("values-json") || null, sheetId: text("sheet-id") || null, key: text("key") || null, envFile: text("env-file") || null,
	};
}

// The server code this script runs, lifted from `root`'s server.js, on `db`,
// reading `env` (the app's .env, or --env-file for a copy) as its process.env.
// `render` replaces renderPolicy() (tests pass a stub; the default is the
// server's own).
function buildWorld({ root = ROOT, db, env = {}, dataDir, render = null, log = console }) {
	const SRC = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const appRequire = createRequire(path.join(root, "server.js"));
	const lifted = closure(SRC, { roots: ROOTS, provided: PROVIDED, denied: DENIED });
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this script makes no network calls"); };
	const scriptProcess = { env: { ...env }, pid: process.pid, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const body = ['"use strict";', lifted.text, `return { ${ROOTS.join(", ")} };`].join("\n");
	const api = new Function("db", "require", "console", "process", "__dirname", "DATA_DIR", "fetch", body)(
		db, liftedRequire, log, scriptProcess, root, dataDir, noFetch,
	);
	if (render) api.renderPolicy = render;
	return { api, liftedNames: lifted.names };
}

// A load's cells as the dry run shows them.
function loadCells(row, cols, headers) {
	const cell = (c) => (c ? String(row[c] || "").trim() : "");
	const assignedCol = (headers || []).find((h) => /assigned.*date|date.*assigned/i.test(h)) || null;
	const completionCol = (headers || []).find((h) => /completion.*date/i.test(h)) || null;
	return {
		loadId: cell(cols.loadIdCol) || `(sheet row ${row._rowIndex})`, status: cell(cols.statusCol), pickup: cell(cols.pickupCol),
		dropoff: cell(cols.dropoffCol), assigned: cell(assignedCol), completion: cell(completionCol),
	};
}

// Everything the run would write, read from the database and the sheet values.
// Synchronous (no await), so it runs again inside the write's transaction.
// Returns { state: "draft", ... } or { state: "already", existing, ... } or throws Refusal.
function plan(db, api, values, opts, { today = null } = {}) {
	const { driver, weekStart, weekEnd, days } = opts;
	const todayKey = today || api.appTodayKey();
	const date = opts.date || todayKey;
	const checks = [];

	// ── who ──────────────────────────────────────────────────────────────────────
	const nameNorm = api.normalizeDriverName(driver);
	if (!nameNorm) throw new Refusal("--driver names no driver");
	const accounts = api.driverAccountsNamed(driver);
	const directory = db.prepare("SELECT id, driver_name, pay_daily FROM drivers_directory ORDER BY id").all()
		.filter((r) => api.normalizeDriverName(r.driver_name) === nameNorm);
	if (accounts.length !== 1) throw new Refusal(`${accounts.length} accounts carry this driver name; the script needs exactly one`);
	if (accounts[0].role !== "Driver") throw new Refusal(`the account carrying this driver name is a ${accounts[0].role} account, not a Driver's`);
	if (directory.length !== 1) throw new Refusal(`${directory.length} drivers directory rows carry this driver name; the script needs exactly one`);
	const payee = String(accounts[0].driver_name).trim();
	const reserved = api.reservedDriverNameRefusal(payee, "payee");
	if (reserved) throw new Refusal(`the driver name can't be a payee: ${reserved.error}`);
	checks.push("driver matched: one Driver account and one drivers directory row");
	const payStruct = api.getDriverPayStructures()[nameNorm] || { payType: "fixed", payPercentage: 0, payDaily: 0 };
	if (payStruct.payType === "percentage") throw new Refusal("this driver is paid a percentage of revenue; his weekly invoice reads revenue, not days, so a day-rate draft does not apply");
	checks.push("fixed daily pay (not a percentage driver)");

	// ── the week, as the generator reads it ─────────────────────────────────────
	const { headers, data } = api.jobTrackingRowsOf((values && values.values) || []);
	if (!headers.length || !data.length) throw new Refusal("Job Tracking is empty");
	const deletedKeys = api.loadKeySet(api.getDeletedLoadIds());
	const week = api.selectInvoiceWeekLoads(data, headers, payee, weekStart, weekEnd, deletedKeys);
	const cols = week.cols;
	if (!cols.driverCol || !cols.dateCol) throw new Refusal("Job Tracking has no driver or completion-date column, so no load can be placed in a week");
	const keyOf = (row) => (cols.loadIdCol && api.normalizeLoadId(row[cols.loadIdCol])) || `_row_${row._rowIndex}`;
	const idOf = (row) => (cols.loadIdCol ? String(row[cols.loadIdCol] || "").trim() : "");
	const tripRule = api.tripDayResolver();
	const weekRule = tripRule || null;

	// The driver's loads billed in another week: completed, live, dated.
	const otherWeek = api.driverCompletedLiveLoads(data, headers, payee, deletedKeys)
		.filter((row) => api.invoiceWeekVerdict(row, cols, "", "", deletedKeys) === "other-week");
	let used = otherWeek;
	if (opts.loads) {
		used = [];
		for (const token of opts.loads) {
			const key = api.normalizeLoadId(token);
			const exact = otherWeek.filter((row) => keyOf(row) === key);
			const hits = exact.length ? exact : otherWeek.filter((row) => key.length >= 4 && keyOf(row).endsWith(key));
			if (hits.length !== 1) throw new Refusal(`--loads ${token} matches ${hits.length} of this driver's completed loads billed in another week; name one`);
			if (!used.includes(hits[0])) used.push(hits[0]);
		}
	}
	const paid = api.invoiceWeekPaidDays({ headers, cols, loads: used, extraRuleLoads: [], weekRule, weekStart, weekEnd, nameNorm });

	// The rate, as generate prices it today.
	const truckRate = api.truckDailyRateCandidates(payee).slice(-1)[0];
	const dailyRate = api.resolveDailyRate(payStruct.payDaily, truckRate, weekEnd.slice(0, 7));
	const { rateOf } = api.invoiceDayPricing({ dailyRate, nameNorm, payDaily: payStruct.payDaily, truckRate, weekRule, dayPayMonth: paid.dayPayMonth });
	const rateFor = (d) => (rateOf ? rateOf(d) : dailyRate);
	const rateSource = (d) => {
		const month = paid.dayPayMonth[d] || d.slice(0, 7);
		if (rateOf && api.driverRateOnlyApplies(month)) {
			const own = api.driverDayRater().ownRateOn(nameNorm, payStruct.payDaily, d);
			return `the daily-rate rule (DRIVER_RATE_ONLY from ${api.DRIVER_RATE_ONLY_FROM}, pays in ${month}): the driver's own rate in effect that day (pay_rate_history, else his directory rate) ${Number(own) > 0 ? usd(own) : "not set, so the $250 default"}`;
		}
		if (Number(payStruct.payDaily) > 0) return `drivers directory daily rate (pay_daily ${usd(payStruct.payDaily)}), resolveDailyRate() as the weekly invoice prices it`;
		if (api.driverRateOnlyApplies(month)) return `the $250 default (no directory rate; the daily-rate rule covers ${month})`;
		if (truckRate === undefined) return "the $250 default (no directory rate and no truck assigned)";
		return `the driver's truck (trucks.driver_pay_daily, $250 when blank) ${usd(truckRate)}, the last truck naming him; no directory rate`;
	};

	// ── idempotent first ────────────────────────────────────────────────────────
	const live = db.prepare("SELECT * FROM invoices WHERE COALESCE(deleted_at, '') = '' AND status != 'Rejected' ORDER BY id")
		.all().filter((r) => api.normalizeDriverName(r.driver) === nameNorm);
	const snapOf = (r) => parseJson(r.render_data || "", {}) || {};
	const linesOf = (r) => (Array.isArray(snapOf(r).lineItems) ? snapOf(r).lineItems : []);
	const prefix = missedWeekPrefix(weekStart, weekEnd);
	const drafts = [];
	for (const r of live.filter((x) => Number(x.is_manual))) {
		const lines = linesOf(r).filter((l) => String((l && l.description) || "").startsWith(prefix));
		if (lines.length) drafts.push({ row: r, lines, days: [...new Set(lines.map((l) => String(l.date || "")))].sort() });
	}
	const listing = live.filter((r) => String(r.week_end || "") >= weekStart).map((r) => ({
		invoiceNumber: r.invoice_number, status: r.status, manual: !!Number(r.is_manual), weekStart: r.week_start, weekEnd: r.week_end,
		totalDue: api.invoiceTotalDue(r), adjustment: Number(r.adjustment) || 0, adjustmentNote: String(r.adjustment_note || ""),
		lines: Number(r.is_manual) ? linesOf(r).map((l) => String((l && l.description) || "")) : [],
	}));
	const exact = drafts.find((c) => c.days.join(",") === days.join(","));
	if (exact) {
		const wrong = exact.lines.filter((l) => cents(l.amount) !== cents(rateFor(String(l.date || ""))));
		if (wrong.length) {
			throw new Refusal(`${exact.row.invoice_number} (${exact.row.status}, total due ${usd(api.invoiceTotalDue(exact.row))}) already drafts these days, ` +
				`${wrong.map((l) => `${l.date} at ${usd(l.amount)}`).join(", ")}, not at today's rate (${wrong.map((l) => usd(rateFor(String(l.date || "")))).join(", ")}); nothing was drafted, a person decides`);
		}
		return { state: "already", existing: exact.row, existingTotal: api.invoiceTotalDue(exact.row), payee, listing };
	}
	const partial = drafts.find((c) => c.days.some((d) => days.includes(d)));
	if (partial) throw new Refusal(`${partial.row.invoice_number} (${partial.row.status}) already drafts the week for ${partial.days.join(", ")}, which overlaps these days; nothing was drafted`);
	checks.push("no draft of this script for the week names any of these days");

	// ── the week has no invoice, and the generator would bill none ──────────────
	const weekly = api.liveWeeklyInvoicesForDriverWeek(payee, weekStart);
	if (weekly.length) {
		throw new Refusal(`the driver has weekly invoice ${weekly.map((r) => `${r.invoice_number} (${r.status})`).join(", ")} for the week of ${weekStart}; ` +
			"for days it missed use scripts/create-correction-invoice-draft.js");
	}
	checks.push("no weekly invoice for the week, in any status");
	if (week.loads.length) {
		throw new Refusal(`the weekly generator bills load ${week.loads.map(idOf).join(", ")} in this week; generate the week's invoice in the app, then correct any day it misses with scripts/create-correction-invoice-draft.js`);
	}
	checks.push("the weekly generator bills no load in this week");
	if (weekRule) {
		const extra = api.invoiceExtraRuleLoads({ data, headers, driverName: payee, billed: [], weekStart, weekEnd, resolver: weekRule, deletedKeys });
		if (extra.length) throw new Refusal(`the trip work-day rule pays this week's days for load ${extra.map((x) => x.loadId).join(", ")}; generate the week's invoice in the app instead`);
		checks.push("the trip work-day rule pays no day of this week");
	} else {
		checks.push("the trip work-day rule is off");
	}

	// ── each day is one the rules pay ───────────────────────────────────────────
	const weekStartMs = Date.parse(`${weekStart}T00:00:00Z`);
	const weekEndMs = Date.parse(`${weekEnd}T00:00:00Z`) + 36 * 3600 * 1000;
	const vidOf = api.invoiceTruckVidReader(headers);
	const eldCache = new Map();
	const eldOf = (row) => {
		const vid = vidOf(row);
		if (!vid) return { vid: null, eld: null };
		if (!eldCache.has(vid)) eldCache.set(vid, api.getEldTravelDaysByVehicle([vid], weekStartMs, weekEndMs)[vid] || null);
		return { vid, eld: eldCache.get(vid) };
	};
	const eldState = (row, d) => {
		const { vid, eld } = eldOf(row);
		if (!vid) return "truck not linked to an ELD";
		if (!eld) return "no ELD data this week";
		if (eld.travel.has(d)) return "moving";
		return eld.coverage.has(d) ? "parked (pings, no movement)" : "no ELD data that day";
	};
	const dayKey = (v) => { const p = v ? api.parseInvoiceDate(v) : null; return p && !isNaN(p) ? api.fmtLocalDate(p) : ""; };
	// The load's window as the cells read: pickup to drop-off (a delivered load's
	// completion date when the drop-off is blank), else its pickup day.
	const rawWindow = (row) => {
		const start = dayKey(cols.pickupCol && row[cols.pickupCol]);
		if (!start) return null;
		const done = /delivered|completed|pod received/i.test(cols.statusCol ? row[cols.statusCol] || "" : "");
		const completionCol = headers.find((h) => /completion.*date|status.*update.*date/i.test(h));
		const end = dayKey(cols.dropoffCol && row[cols.dropoffCol]) || (done && completionCol ? dayKey(row[completionCol]) : "") || start;
		return { start, end: end < start ? start : end };
	};
	const byId = new Map(used.map((row) => [idOf(row), row]));
	const overrides = api.getAllExcludedDriverDays()[nameNorm] || null;
	const perDay = [];
	for (const d of days) {
		if (!paid.activeDaySet.has(d)) {
			let why;
			if (overrides && overrides.remove && overrides.remove.has(d)) why = "a Super Admin removed it for this driver (excluded days)";
			else {
				const covering = used.filter((row) => { const w = rawWindow(row); return w && w.start <= d && d <= w.end; });
				why = covering.length
					? `the pay window of ${covering.map(idOf).join(", ")} covers it, but the rules drop it: ${covering.map((row) => `ELD ${eldState(row, d)}`).join("; ")}`
					: `no ${opts.loads ? "named " : ""}load billed in another week has a pay window covering it`;
			}
			throw new Refusal(`the weekly rules would not pay ${weekdayOf(d)} ${d}: ${why}; nothing was drafted (a Super Admin can add the day in the app, excluded days "add", and run this again)`);
		}
		const loads = paid.dayLoadMap[d] || [];
		perDay.push({
			day: d, rate: rateFor(d), source: rateSource(d), added: !loads.length,
			loads: loads.map((id) => { const row = byId.get(String(id).trim()); return { loadId: id, eld: row ? eldState(row, d) : "unknown" }; }),
		});
	}
	checks.push("each day is one the weekly rules pay (pay window, ELD intersection, overrides)");

	// ── dates and months ────────────────────────────────────────────────────────
	if (date > todayKey) throw new Refusal(`--date ${date} is after today (${todayKey})`);
	if (date < days[days.length - 1]) throw new Refusal(`--date ${date} is before ${days[days.length - 1]}, the last day it pays`);
	if (api.periodWriteLocked(date.slice(0, 7))) throw new Refusal(`${monthLabel(date.slice(0, 7))} is closed (or the month locks can't be read), so the draft can't be issued ${date}`);
	for (const m of [...new Set(days.map((d) => d.slice(0, 7)))]) {
		if (api.periodWriteLocked(m)) throw new Refusal(`${monthLabel(m)} is closed (or the month locks can't be read); its days are not paid on a new draft`);
	}
	const lockedIn = (from, to) => monthsBetween(from, to).filter((m) => api.periodWriteLocked(m));
	let periodStart = weekStart;
	const closedInWeek = lockedIn(weekStart, weekEnd);
	if (closedInWeek.length) {
		const monthStart = `${days[0].slice(0, 7)}-01`;
		periodStart = monthStart > weekStart ? monthStart : weekStart;
		if (lockedIn(periodStart, weekEnd).length) throw new Refusal(`the week of ${weekStart} touches closed ${lockedIn(periodStart, weekEnd).map(monthLabel).join(" and ")}; nothing was drafted`);
	}
	checks.push(`issue date ${date}: not after today, not before the last day, in an open month; each day's month is open; period ${periodStart} to ${weekEnd} touches no closed month`);

	// ── no live invoice pays these days ─────────────────────────────────────────
	const draftIds = new Set(drafts.map((c) => c.row.id));
	if (api.invoicePaidDaysTablePresent()) {
		const holders = api.invoicePaidDayHolders(nameNorm, days);
		for (const d of days) if (holders.has(d)) throw new Refusal(`${d} is already recorded as paid by ${holders.get(d).invoiceNumber || `invoice #${holders.get(d).invoiceId}`} (invoice_paid_days)`);
	}
	for (const r of live) {
		if (draftIds.has(r.id)) continue;
		const snap = snapOf(r);
		if (!Number(r.is_manual)) {
			for (const d of days) {
				if (r.week_start <= d && d <= r.week_end) {
					const bills = gridBills(r, d);
					if (bills === null) throw new Refusal(`${r.invoice_number} (${r.status}) covers ${d} but has no day grid line for it, so the script can't tell whether it pays that day`);
					if (bills) throw new Refusal(`${weekdayOf(d)} ${d} is already billed on ${r.invoice_number} (${r.status})`);
				}
				if (String(r.week_end || "") >= weekStart && cents(r.adjustment) !== 0 && namesDay(r.adjustment_note, d)) {
					throw new Refusal(`${r.invoice_number} (${r.status}) carries an adjustment of ${usd(r.adjustment)} whose note names ${d}; it may already pay that day`);
				}
			}
			continue;
		}
		const lines = linesOf(r);
		const claimed = Array.isArray(snap.paidDays) ? snap.paidDays.map(String) : [];
		for (const d of days) {
			if (claimed.includes(d)) throw new Refusal(`${r.invoice_number} (${r.status}) names ${d} among the days it pays`);
			if (lines.some((l) => String((l && l.date) || "").trim() === d)) throw new Refusal(`${r.invoice_number} (${r.status}) has a line dated ${d}; it may already pay that day`);
			const covers = r.week_start <= d && d <= r.week_end;
			if (covers && (!lines.length || lines.some((l) => !isCalendarDay(String((l && l.date) || "").trim())))) {
				throw new Refusal(`${r.invoice_number} (${r.status}) covers ${d} with ${lines.length ? "an undated line" : "no line"}, so the script can't tell whether it pays that day`);
			}
			if (String(r.week_end || "") >= weekStart) {
				const texts = [...lines.map((l) => String((l && l.description) || "")), String(snap.notes || "")];
				if (texts.some((t) => namesDay(t, d))) throw new Refusal(`${r.invoice_number} (${r.status}) names ${d} in a line or its notes; it may already pay that day`);
			}
		}
	}
	checks.push("no live invoice of the driver pays these days (paid-days records, weekly day grids and adjustment notes, manual lines, days and notes)");

	// ── the draft ───────────────────────────────────────────────────────────────
	const lineItems = perDay.map((p) => ({ date: p.day, description: `${prefix} ${weekdayOf(p.day)}, ${longDay(p.day)}, ${usdShort(p.rate)}`, amount: p.rate }));
	const itemsRes = api.sanitizeManualInvoiceRows(lineItems, "lineItems");
	if (itemsRes.error) throw new Refusal(itemsRes.error);
	const dedRes = api.sanitizeManualInvoiceRows([], "deductions");
	const totals = api.manualInvoiceTotals(itemsRes.items, dedRes.items);
	const sum = perDay.reduce((c, p) => c + cents(p.rate), 0);
	if (cents(totals.totalDue) !== sum) throw new Error(`total ${usd(totals.totalDue)} is not the days' sum ${usd(sum / 100)}`);

	const payerIds = [...new Set(perDay.flatMap((p) => p.loads.map((l) => String(l.loadId).trim())))];
	const completions = payerIds.map((id) => { const row = byId.get(id); return `${id} completed ${row ? api.invoiceCompletionDay(row, cols) : "?"}`; });
	const rates = [...new Set(perDay.map((p) => usdShort(p.rate)))];
	const n = days.length;
	const notes = `No weekly invoice was made for the week of ${longDay(weekStart)} - ${longDay(weekEnd)}. ` +
		(payerIds.length
			? `${n} day${n === 1 ? "" : "s"} worked in it on load${payerIds.length === 1 ? "" : "s"} ${completions.join(", ")}: a load is billed in the week it completes, and that week's invoice pays only its own days. `
			: `${n} day${n === 1 ? "" : "s"} a Super Admin added for the driver. `) +
		`${rates.join(" / ")} a day.` +
		(periodStart !== weekStart ? ` Period from ${longDay(periodStart)} because ${closedInWeek.map(monthLabel).join(" and ")} ${closedInWeek.length === 1 ? "is" : "are"} closed.` : "");
	const invoiceNumber = api.generateInvoiceNumber(payee, periodStart, { prefix: "INV-M-" });
	const onFile = api.findInvoicePayee(payee);
	const paidDays = api.TRIP_WORK_DAYS_FROM ? [...days] : null;
	const renderData = {
		payeeName: payee,
		payeeRole: "Driver",
		payeeAddress: ((onFile && onFile.address) || "").slice(0, 200),
		payeePhone: ((onFile && onFile.phone) || "").slice(0, 40),
		invoiceNumberSuffix: invoiceNumber.replace(/^INV-/, ""),
		issueDate: api.appTime.dateTextInZone(new Date(`${date}T12:00:00Z`), api.APP_TIMEZONE),
		billingPeriodStart: longDay(periodStart),
		billingPeriodEnd: longDay(weekEnd),
		lineItems: itemsRes.items,
		deductions: dedRes.items,
		subtotal: totals.subtotal,
		deductionsTotal: totals.deductionsTotal,
		totalDue: totals.totalDue,
		notes: notes.slice(0, 500),
		preparedBy: PREPARED_BY,
		adjustment: 0,
		adjustmentNote: "",
		...(paidDays ? { paidDays } : {}),
	};
	const row = {
		invoice_number: invoiceNumber,
		driver: payee.toLowerCase(),
		week_start: periodStart,
		week_end: weekEnd,
		loads_count: itemsRes.items.length,
		rate_per_load: 0,
		total_earnings: totals.totalDue,
		expenses_total: totals.deductionsTotal,
		status: "Draft",
		pdf_file_name: api.invoicePdfFileName(invoiceNumber),
		load_ids: "[]",
		expense_ids: "[]",
		render_data: JSON.stringify({ ...renderData, __templateName: TEMPLATE }),
		is_manual: 1,
		created_by: ACTOR,
	};
	const audit = {
		user_id: SYSTEM_USER.id, username: SYSTEM_USER.username, role: SYSTEM_USER.role,
		action: AUDIT_ACTION, entity: "invoice",
		details: `${invoiceNumber} (Draft) for ${payee}: missed week ${weekStart} to ${weekEnd} (no weekly invoice), ` +
			`days ${perDay.map((p) => `${p.day} ${usd(p.rate)}`).join(", ")} = ${usd(totals.totalDue)}; ` +
			`loads ${payerIds.join(", ") || "none (days a Super Admin added)"}; rate: ${[...new Set(perDay.map((p) => p.source))].join(" / ")}; issued ${date}`,
	};
	// The week's other days the same loads (and Super Admin additions) would pay:
	// shown, never drafted unless named in --days.
	const otherDays = [...paid.activeDaySet].filter((d) => !days.includes(d)).sort().map((d) => ({ day: d, loads: paid.dayLoadMap[d] || [] }));
	return {
		state: "draft", payee, nameNorm, perDay, otherDays, renderData, row, audit, paidDays, periodStart, closedInWeek, checks, listing,
		related: relatedLoads({ api, data, headers, cols, nameNorm, weekStart, weekEnd, weekRule, deletedKeys, payerIds, used, keyOf, idOf, rawWindow }),
		suspects: payerIds.map((id) => byId.get(id)).filter(Boolean).map((r) => ({ loadId: idOf(r), note: suspectNote(loadCells(r, cols, headers), rawWindow(r), dayKey) })).filter((s) => s.note),
		flags: {
			TRIP_WORK_DAYS_FROM: api.TRIP_WORK_DAYS_FROM || null, DRIVER_RATE_ONLY_FROM: api.DRIVER_RATE_ONLY_FROM || null,
			INVOICE_BLANK_PICKUP_FALLBACK_FROM: api.INVOICE_BLANK_PICKUP_FALLBACK_FROM || null, preDispatch: !!api.preDispatchPayDayFilter(),
		},
		pay: { payDaily: payStruct.payDaily, truckRate: truckRate === undefined ? null : truckRate, dailyRate },
	};
}

// Why a load's appointments may be mistyped, or "".
function suspectNote(cells, win, dayKey) {
	const out = [];
	if (win && daysBetween(win.start, win.end) + 1 > SUSPECT_DAYS) out.push(`its pay window runs ${daysBetween(win.start, win.end) + 1} days (${win.start} to ${win.end})`);
	const assigned = dayKey(cells.assigned);
	if (win && assigned && daysBetween(win.start, assigned) > SUSPECT_DAYS) out.push(`its Pickup Appointment ${win.start} is ${daysBetween(win.start, assigned)} days before its Assigned Date ${assigned}`);
	return out.length ? `${out.join("; ")}: check its appointments` : "";
}

// The driver's other loads whose window touches the week and that pay none of
// the drafted days: what the rule would pay for each in the week, and why none
// of it is drafted.
function relatedLoads({ api, data, headers, cols, nameNorm, weekStart, weekEnd, weekRule, deletedKeys, payerIds, used, keyOf, idOf, rawWindow }) {
	const dayKey = (v) => { const p = v ? api.parseInvoiceDate(v) : null; return p && !isNaN(p) ? api.fmtLocalDate(p) : ""; };
	const rows = new Map();
	for (const row of data) if (api.normalizeDriverName(row[cols.driverCol]) === nameNorm) rows.set(keyOf(row), row);
	const usedKeys = new Set(used.map(keyOf));
	const out = [];
	for (const row of rows.values()) {
		const id = idOf(row);
		if (payerIds.includes(id)) continue;
		const win = rawWindow(row);
		if (!win || win.end < weekStart || win.start > weekEnd) continue;
		const verdict = api.invoiceWeekVerdict(row, cols, weekStart, weekEnd, deletedKeys);
		const would = api.invoiceWeekPaidDays({ headers, cols, loads: [row], extraRuleLoads: [], weekRule, weekStart, weekEnd, nameNorm });
		const days = Object.keys(would.dayLoadMap).filter((d) => (would.dayLoadMap[d] || []).includes(row[cols.loadIdCol])).sort();
		const why = verdict === "open" ? "not completed"
			: verdict === "undated" ? "completed with no completion date: billed in no week"
				: verdict === "deleted" ? "deleted"
					: verdict === "bill" ? "billed in this week"
						: !usedKeys.has(keyOf(row)) ? "left out by --loads"
							: "pays none of the requested days";
		const cells = loadCells(row, cols, headers);
		out.push({ ...cells, loadId: id || cells.loadId, why, days, completedOn: api.invoiceCompletionDay(row, cols), suspect: suspectNote(cells, win, dayKey) });
	}
	return out;
}

// The route's INSERT (POST /api/invoices/manual) is INSERT_INVOICE; the audit row is INSERT_AUDIT.
// The comparable part of a plan: a re-plan inside the transaction must match it.
const planKey = (p) => JSON.stringify({ row: p.row, audit: p.audit.details, paidDays: p.paidDays });

// Draft the invoice. Returns { state, plan, invoice?, auditId? }.
async function run(db, api, values, opts, { today = null } = {}) {
	// With the daily-rate rule on, pricing reads the rule's start record, which
	// the server stamps when it first runs with the flag; on a database it never
	// ran with, a write would stamp it here. The dry run reads it in memory.
	if (!opts.dryRun && api.DRIVER_RATE_ONLY_FROM && !driverRateOnly.readStart(db)) {
		throw new Refusal("DRIVER_RATE_ONLY is on but the app has never run with it on this database (no start record); start the app first, or run the dry run");
	}
	const first = plan(db, api, values, opts, { today });
	if (first.state === "already" || opts.dryRun) return { state: first.state, plan: first };
	const pdfBuffer = await api.renderPolicy(TEMPLATE, first.renderData);
	let auditId = null;
	const result = api.commitInvoiceWithPdf({
		invoiceNumber: first.row.invoice_number, pdfFileName: first.row.pdf_file_name, pdfBuffer,
		insert: () => {
			let again;
			try { again = plan(db, api, values, opts, { today }); } catch (err) {
				if (err instanceof Refusal) throw new Refusal(`${err.message} (found while this run rendered its PDF; nothing was written)`);
				throw err;
			}
			if (again.state !== "draft" || planKey(again) !== planKey(first)) {
				throw new Refusal(again.state === "already"
					? `${again.existing.invoice_number} was drafted for these days while this run rendered its PDF; nothing was written`
					: "the invoices changed while this run rendered its PDF; nothing was written, run it again");
			}
			const r = first.row;
			const res = db.prepare(INSERT_INVOICE).run(r.invoice_number, r.driver, r.week_start, r.week_end, r.loads_count, r.total_earnings, r.expenses_total, r.pdf_file_name, r.render_data, r.created_by);
			if (first.paidDays) api.claimInvoicePaidDays(Number(res.lastInsertRowid), first.nameNorm, first.paidDays);
			const a = first.audit;
			auditId = db.prepare(INSERT_AUDIT).run(new Date().toISOString(), a.user_id, a.username, a.role, a.action, a.entity, String(res.lastInsertRowid), a.details).lastInsertRowid;
			return res;
		},
	});
	const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(result.lastInsertRowid);
	return { state: "written", plan: first, invoice, auditId };
}

// The run's report, line by line.
function describe(p, opts) {
	const out = [];
	out.push(`Driver: ${p.payee}; week ${opts.weekStart} to ${opts.weekEnd}; days ${opts.days.join(", ")}${opts.loads ? `; --loads ${opts.loads.join(", ")}` : ""}`);
	if (p.state === "draft") {
		const f = p.flags;
		out.push(`Flags as the app has them: TRIP_WORK_DAYS ${f.TRIP_WORK_DAYS_FROM ? `from ${f.TRIP_WORK_DAYS_FROM}` : "off"}, DRIVER_RATE_ONLY ${f.DRIVER_RATE_ONLY_FROM ? `from ${f.DRIVER_RATE_ONLY_FROM}` : "off"}, ` +
			`INVOICE_BLANK_PICKUP_FALLBACK ${f.INVOICE_BLANK_PICKUP_FALLBACK_FROM ? `from ${f.INVOICE_BLANK_PICKUP_FALLBACK_FROM}` : "off"}, pre-dispatch rule ${f.preDispatch ? "on" : "off"}`);
		out.push(`Pay: fixed; drivers directory ${p.pay.payDaily > 0 ? usd(p.pay.payDaily) : "not set"}; truck rate ${p.pay.truckRate == null ? "no truck" : usd(p.pay.truckRate)}; the week's rate ${usd(p.pay.dailyRate)}`);
		out.push("Days:");
		for (const d of p.perDay) {
			const by = d.added ? "a day a Super Admin added (excluded days), no load" : d.loads.map((l) => `load ${l.loadId} (ELD: ${l.eld})`).join(", ");
			out.push(`  ${d.day} ${weekdayOf(d.day)}: paid by the weekly rules for ${by}; rate ${usd(d.rate)}, from ${d.source}`);
		}
		out.push(`Other days of this week the rules would pay for these loads (not drafted; only --days are): ${p.otherDays.length
			? p.otherDays.map((o) => `${o.day} (${o.loads.length ? `load ${o.loads.join(", ")}` : "added by a Super Admin"})`).join(", ") : "none"}`);
		for (const s of p.suspects) out.push(`NOTE: load ${s.loadId}: ${s.note}. To leave it out, name the other load(s) with --loads.`);
		out.push("Checks passed:");
		for (const c of p.checks) out.push(`  - ${c}`);
	}
	out.push(`Live invoices of this driver from ${opts.weekStart} on: ${p.listing.length ? "" : "none"}`);
	for (const m of p.listing) {
		out.push(`  ${m.invoiceNumber} (${m.manual ? "manual" : "weekly"}, ${m.status}, ${m.weekStart} to ${m.weekEnd}, total due ${usd(m.totalDue)})` +
			(m.adjustment ? `, adjustment ${usd(m.adjustment)} "${m.adjustmentNote}"` : "") +
			(m.lines.length ? `: ${m.lines.map((l) => JSON.stringify(l)).join(" | ")}` : ""));
	}
	if (p.state === "already") return out;
	out.push(`Related loads (window touches the week; none of their days is drafted): ${p.related.length ? "" : "none"}`);
	for (const r of p.related) {
		out.push(`  load ${r.loadId}: ${r.status || "no status"}; Pickup ${r.pickup || "-"}, Drop-off ${r.dropoff || "-"}, Assigned ${r.assigned || "-"}, completed ${r.completedOn || "-"}; ` +
			`the rule would pay ${r.days.length ? r.days.join(", ") : "no day"} of this week; not used: ${r.why}${r.suspect ? `; ${r.suspect}` : ""}`);
	}
	const r = p.row;
	const rd = p.renderData;
	out.push(`Invoice row: ${r.invoice_number}, ${r.status}, manual, driver "${r.driver}", period ${r.week_start} to ${r.week_end}, issue date ${rd.issueDate}, ` +
		`${r.loads_count} line(s), total ${usd(r.total_earnings)}, deductions ${usd(r.expenses_total)}, created by "${r.created_by}"`);
	rd.lineItems.forEach((l, i) => out.push(`  line ${i + 1}: ${l.date}  ${l.description}  ${usd(l.amount)}`));
	out.push(`  subtotal ${usd(rd.subtotal)}, deductions ${usd(rd.deductionsTotal)}, total due ${usd(rd.totalDue)}`);
	out.push(`  notes: ${rd.notes}`);
	out.push(`  payee address on file: ${rd.payeeAddress ? "yes" : "none"}, phone on file: ${rd.payeePhone ? "yes" : "none"}`);
	out.push(`  paid days claimed: ${p.paidDays ? p.paidDays.join(", ") : "none (the trip work-day rule is off, as POST /api/invoices/manual does)"}`);
	out.push(`PDF: uploads/invoices/${r.pdf_file_name}`);
	out.push(`Audit row: ${p.audit.action}, ${p.audit.entity} <new id>, by "${p.audit.username}" (${p.audit.role}): ${p.audit.details}`);
	return out;
}

// Returns the exit code. The PDF renderer's shared browser is shut down
// whatever happens, or it would keep the process alive after the write.
async function main() {
	const opts = readOptions(process.argv.slice(2));
	let env;
	let dbFile;
	try {
		({ env, file: dbFile } = envFor({ root: ROOT, dbPath: opts.db, envFile: opts.envFile }));
	} catch (err) {
		throw new Refusal(err.message);
	}
	const args = { "values-json": opts.valuesJson || undefined, "sheet-id": opts.sheetId || undefined, key: opts.key || undefined, "env-file": opts.envFile || undefined, db: opts.db };
	const values = await sheetFor(args, ROOT);
	const dataDir = path.dirname(dbFile) === fs.realpathSync(ROOT) ? ROOT : path.dirname(dbFile);
	const db = openDb({ root: ROOT, dbFile, readonly: opts.dryRun });
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	try {
		if (opts.dryRun && !db.readonly) throw new Error("refusing: the dry run's SQLite handle is not read-only");
		const { api } = buildWorld({ db, env, dataDir, log: { log() {}, info() {}, warn: (...a) => console.error(...a), error: (...a) => console.error(...a) } });
		console.log(`Database: ${dbFile} (${dataDir === ROOT ? "the app's own" : "a copy"}); PDFs: ${path.join(dataDir, "uploads", "invoices")}`);
		const out = await run(db, api, values, opts);
		const p = out.plan;
		if (out.state === "already") {
			for (const line of describe(p, opts)) console.log(line);
			console.log(`already drafted: ${p.existing.invoice_number} (id ${p.existing.id}, ${p.existing.status}, total due ${usd(p.existingTotal)}) pays the week of ${opts.weekStart} for ${opts.days.join(", ")}; nothing written`);
		} else if (opts.dryRun) {
			console.log("DRY RUN: nothing written.");
			for (const line of describe(p, opts)) console.log(line);
		} else {
			for (const line of describe(p, opts)) console.log(line);
			console.log(`WRITTEN: ${out.invoice.invoice_number} (id ${out.invoice.id}, ${out.invoice.status}), total due ${usd(api.invoiceTotalDue(out.invoice))}; audit row ${out.auditId}`);
		}
		return 0;
	} finally {
		db.close();
		try { await appRequire("./lib/pdf-browser").shutdownBrowser(); } catch { /* no browser was started */ }
	}
}

if (require.main === module) {
	main().then((code) => process.exit(code)).catch((err) => {
		if (err instanceof Refusal || (err && err.invoiceWriteRefusal)) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`ERROR: ${err.stack || err.message}`);
		process.exit(1);
	});
}

module.exports = {
	ACTOR, AUDIT_ACTION, PREPARED_BY, ROOTS, PROVIDED, DENIED, TEMPLATE, Refusal,
	readOptions, buildWorld, plan, run, describe, missedWeekPrefix,
};
