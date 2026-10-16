#!/usr/bin/env node
// scripts/create-correction-invoice-draft.js — drafts ONE correction invoice for
// days a weekly driver invoice did not bill, dated in an open month, so the
// driver is paid for them without changing the original invoice or anything in
// a closed month (the client's rule: closed months are never reopened).
//
// What it writes, in one transaction, when every check passes:
//   - one new invoice in Draft status, through the manual-invoice path of
//     POST /api/invoices/manual: the server's own sanitizeManualInvoiceRows(),
//     manualInvoiceTotals(), generateInvoiceNumber() (an INV-M- number),
//     findInvoicePayee() (the address and phone on file), the
//     "service_invoice_manual" template through renderPolicy(), and
//     commitInvoiceWithPdf() (the row and its PDF written together), all lifted
//     from this checkout's server.js (scripts/lib/server-lift.js). The row is the
//     route's own INSERT; scripts/test-create-correction-invoice-draft.js pins it
//     to the route's, column for column;
//       payee        the original invoice's driver;
//       period       --date to --date: the correction counts in --date's month
//                    (an invoice whose week touches a closed month can't be
//                    marked paid, and counts in that month's driver table);
//       issue date   --date;
//       lines        one per day, dated that day:
//                    "Correction for <original>: <Weekday, Month D, YYYY>, $<rate>";
//       notes        the original invoice, its billing week, and why the
//                    correction is dated in the open month;
//   - one audit_trail row, a system change (user 0, username
//     "system: correction-invoice script", role "system", action
//     create_correction_invoice) naming the new invoice, the original invoice's
//     number and id, the days, the rate and the total.
// It never submits, approves, pays or emails anything, never edits the original
// invoice, and never writes to a closed month: no override, payout, lock or
// frozen item is touched. A manual invoice feeds no pay-day math, so no P&L
// line moves.
//
// Idempotent, checked first: when a live correction for the original (a manual
// invoice of the driver, not deleted, not Rejected, whose lines start
// "Correction for <original>:") already names exactly these days, it prints
// "already drafted" with its number, status and total and writes nothing
// (exit 0), whatever the date and the month locks say now. That correction at
// another daily rate is refused.
//
// Refused (exit 2, nothing written) when:
//   - the original is missing, deleted, rejected, a manual invoice, has no daily
//     day grid to read, or carries an adjustment (the days may already be
//     corrected);
//   - a day is outside the original's week, or the original bills it;
//   - a day is already billed on another live invoice of the driver (any status
//     but Rejected, not deleted, the driver's name in any spelling): a weekly
//     invoice whose day grid bills it; a manual invoice with a line dated
//     exactly that day; or a manual invoice whose line or notes name the
//     original invoice and that day (written as 2026-01-05, 1/5, 1/5/2026,
//     January 5 or Jan 5), or name the original with no date the script can
//     read. Or the script can't tell: a weekly invoice covering the day with no
//     day grid, or a manual one covering the day with an undated line;
//   - a correction for the original names some of the days but not exactly
//     these (partly drafted);
//   - --date is not a calendar day, is after today (APP_TIMEZONE), is before the
//     original's week, or falls in a closed month (period_locks; an unreadable
//     table counts as closed);
//   - the state read before rendering the PDF changed by the time the database
//     is held (checked again inside the write's transaction).
// Every run (the dry run, the write, "already drafted") lists the driver's live
// manual invoices whose period ends on or after the original's week start: their
// number, status, total due and line descriptions, for a person to check.
//
// --dry-run opens the database read-only, prints exactly what it would write
// (the invoice row, its lines and totals, its PDF file name and the audit row)
// and writes nothing: no row, no file, no PDF rendered.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/create-correction-invoice-draft.js --invoice <number> --days <YYYY-MM-DD,...> --rate <dollars> --date <YYYY-MM-DD> --dry-run
//   node scripts/create-correction-invoice-draft.js --invoice <number> --days <YYYY-MM-DD,...> --rate <dollars> --date <YYYY-MM-DD>
//   --db <file>        default: the app's own database (DATABASE_PATH, from the
//                      environment or the app's .env, else app.db in the app
//                      directory, as server.js opens it), refused while
//                      LOCAL_REPLICA is set (a replica's database is never the
//                      app's own). Another file must be a copy outside this
//                      repository and outside any app directory (its folder
//                      holds no server.js and no .env); scripts/lib/app-database.js.
//   --data-dir <dir>   with a copy only, outside this repository: the folder
//                      whose uploads/invoices/ gets the PDF (default: the copy's
//                      folder)
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
const { parseArgs } = require("./lib/ledger-world");
const { resolveDatabase, insideRoot, DatabaseRefusal } = require("./lib/app-database");
const driverRateOnly = require("../lib/driver-rate-only");

const ROOT = path.join(__dirname, "..");
const ACTOR = "system: correction-invoice script";
const SYSTEM_USER = Object.freeze({ id: 0, username: ACTOR, role: "system" });
const AUDIT_ACTION = "create_correction_invoice";
const OPTIONS = ["invoice", "days", "rate", "date", "db", "data-dir", "dry-run"];
const TEMPLATE = "service_invoice_manual";
// What the PDF prints under "Prepared by".
const PREPARED_BY = "LogisX correction (script)";
// The weekly template's day grid, keyed by weekday name.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// What the script lifts from server.js, and what it must never reach.
const ROOTS = [
	"sanitizeManualInvoiceRows", "manualInvoiceTotals", "generateInvoiceNumber", "invoicePdfFileName",
	"commitInvoiceWithPdf", "findInvoicePayee", "reservedDriverNameRefusal", "normalizeDriverName",
	"invoiceTotalDue", "periodWriteLocked", "appTodayKey", "renderPolicy", "appTime", "APP_TIMEZONE",
];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "DATA_DIR", "fetch"];
const DENIED = ["app", "getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive", "notifyChange"];
// What the lifted code may require: Node's path, fs and crypto, and the app's own lib/.
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "fs"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);

class Refusal extends Error {}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isCalendarDay = (s) => {
	if (typeof s !== "string" || !DAY_RE.test(s)) return false;
	const d = new Date(`${s}T12:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const weekdayOf = (day) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
const longDay = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)}`;
const monthLabel = (period) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
const cents = (v) => Math.round(Number(v || 0) * 100);
const usd = (v) => `$${(cents(v) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// "$250" for whole dollars, "$262.50" otherwise: the line text's amount.
const usdShort = (v) => (cents(v) % 100 === 0 ? `$${(cents(v) / 100).toLocaleString("en-US")}` : usd(v));
const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
// Every calendar month a day range touches, as YYYY-MM.
function monthsBetween(from, to) {
	const out = [];
	let y = Number(from.slice(0, 4));
	let m = Number(from.slice(5, 7));
	const endKey = to.slice(0, 7);
	for (let i = 0; i < 24; i++) {
		const key = `${y}-${String(m).padStart(2, "0")}`;
		out.push(key);
		if (key >= endKey) break;
		m += 1;
		if (m === 13) { m = 1; y += 1; }
	}
	return out;
}

// The command line, checked before anything is opened. Returns
// { invoiceNumber, days, rate, date, dryRun, db, dataDir } or throws Refusal.
function readOptions(argv) {
	const args = parseArgs(argv);
	for (const a of argv) {
		if (!a.startsWith("--")) continue;
		const name = a.slice(2).split("=")[0];
		if (!OPTIONS.includes(name)) throw new Refusal(`unknown option --${name}`);
	}
	const text = (k) => (typeof args[k] === "string" ? args[k].trim() : "");
	const invoiceNumber = text("invoice");
	if (!invoiceNumber || invoiceNumber.length > 64) throw new Refusal("--invoice <original invoice number> is required");
	const days = text("days").split(",").map((s) => s.trim()).filter(Boolean);
	if (!days.length) throw new Refusal("--days <YYYY-MM-DD,...> is required");
	if (days.length > 7) throw new Refusal("--days names more than 7 days; a weekly invoice has 7");
	for (const d of days) if (!isCalendarDay(d)) throw new Refusal(`--days: ${d} is not a calendar day (YYYY-MM-DD)`);
	if (new Set(days).size !== days.length) throw new Refusal("--days names a day twice");
	const rateText = text("rate");
	if (!/^\d{1,5}(\.\d{1,2})?$/.test(rateText) || !(Number(rateText) > 0)) throw new Refusal("--rate <dollars> is required: a daily rate above $0, at most 2 decimal places");
	const date = text("date");
	if (!isCalendarDay(date)) throw new Refusal("--date <YYYY-MM-DD> is required: the correction's date, in an open month");
	if (args["data-dir"] !== undefined && !text("data-dir")) throw new Refusal("--data-dir needs a folder");
	if (args.db !== undefined && !text("db")) throw new Refusal("--db needs a file");
	if (args["dry-run"] !== undefined && args["dry-run"] !== true) throw new Refusal("--dry-run takes no value");
	return {
		invoiceNumber, days: [...days].sort(), rate: Number(rateText), date,
		dryRun: args["dry-run"] === true, db: text("db") || null, dataDir: text("data-dir") || null,
	};
}

// Which database to open (scripts/lib/app-database.js) and where the PDF goes:
// { scope, file, dataDir }. The app's own database keeps its PDFs in the app
// directory, as the server does; a copy's go beside it, or in --data-dir.
function resolveTarget({ db, dataDir }, root, { env = process.env } = {}) {
	const onlyForCopy = "--data-dir is only for a copy of the database; the app's own database keeps its PDFs in the app directory";
	if (!db && dataDir) throw new Refusal(onlyForCopy);
	let target;
	try { target = resolveDatabase(db, root, { env }); } catch (err) {
		if (err instanceof DatabaseRefusal) throw new Refusal(err.message);
		throw err;
	}
	if (target.scope === "app") {
		if (dataDir) throw new Refusal(onlyForCopy);
		return { ...target, dataDir: root };
	}
	if (!dataDir) return { ...target, dataDir: path.dirname(target.file) };
	let dir;
	try { dir = fs.realpathSync(dataDir); } catch { throw new Refusal(`--data-dir ${dataDir} does not exist`); }
	if (insideRoot(dir, root)) throw new Refusal(`--data-dir ${dataDir} is inside the repository; a copy's PDFs go outside it`);
	return { ...target, dataDir: dir };
}

// The server code this script runs, lifted from `root`'s server.js, on `db`.
// `render` replaces renderPolicy() (tests pass a stub; the default is the
// server's own).
function buildWorld({ root = ROOT, db, dataDir, render = null }) {
	const SRC = fs.readFileSync(path.join(root, "server.js"), "utf8");
	const appRequire = createRequire(path.join(root, "server.js"));
	const lifted = closure(SRC, { roots: ROOTS, provided: PROVIDED, denied: DENIED });
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this script makes no network calls"); };
	const scriptProcess = { env: process.env, pid: process.pid, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const body = [
		'"use strict";',
		lifted.text,
		`return { ${ROOTS.join(", ")} };`,
	].join("\n");
	const api = new Function("db", "require", "console", "process", "__dirname", "DATA_DIR", "fetch", body)(
		db, liftedRequire, console, scriptProcess, root, dataDir, noFetch,
	);
	if (render) api.renderPolicy = render;
	return { api, liftedNames: lifted.names };
}

// A weekly day-grid line bills its day when it is marked completed or carries
// an amount.
const lineBills = (line) => !!line && (!!line.completed || cents(line.total) !== 0);

// A weekly invoice's day grid (render snapshot), or null when it has none.
function dayGrid(row) {
	const render = parseJson(row.render_data || "", null);
	if (!render || render.__templateName !== "service_invoice" || !render.days || typeof render.days !== "object") return null;
	return render.days;
}

// Whether a weekly invoice's grid bills `day`: true, false, or null (no grid,
// or no line for that weekday).
function gridBills(row, day) {
	const grid = dayGrid(row);
	if (!grid) return null;
	const line = grid[weekdayOf(day)];
	if (!line) return null;
	return lineBills(line);
}

const correctionPrefix = (originalNumber) => `Correction for ${originalNumber}:`;

// Dates written M/D or MM/DD, with an optional /YYYY or /YY; and a word then a
// day number ("January 5", "Jan. 5"). Fixed patterns: the text's dates are
// found first and then compared with the day as numbers, so nothing from the
// command line or the database is ever compiled into a pattern.
const SLASH_DATE_RE = /(^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;
const WORD_DATE_RE = /\b([a-z]{3,9})\.?\s{1,3}(\d{1,2})(?!\d)/gi;

// Whether free text names `day`: 2026-01-05, 1/5 or 01/05 (with this year or
// none), January 5 or Jan 5 (any case).
function namesDay(text, day) {
	const t = String(text || "");
	if (t.includes(day)) return true;
	const y = day.slice(0, 4);
	const m = Number(day.slice(5, 7));
	const d = Number(day.slice(8, 10));
	for (const hit of t.matchAll(SLASH_DATE_RE)) {
		if (Number(hit[2]) === m && Number(hit[3]) === d && (!hit[4] || hit[4] === y || hit[4] === y.slice(2))) return true;
	}
	const month = MONTHS[m - 1].toLowerCase();
	for (const hit of t.matchAll(WORD_DATE_RE)) {
		const word = hit[1].toLowerCase();
		if ((word === month || word === month.slice(0, 3)) && Number(hit[2]) === d) return true;
	}
	return false;
}
// Any date the script can read in free text, in the forms namesDay() reads.
const READABLE_DATE_RE = /\d{4}-\d{2}-\d{2}|(^|[^\d/])\d{1,2}\/\d{1,2}(?!\d)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.?\s{1,3}\d{1,2}(?!\d)/i;

// Everything the run would write, read from the database. Synchronous (no
// await), so it runs again inside the write's transaction. Returns
// { state: "draft", ... } or { state: "already", existing } or throws Refusal.
function plan(db, api, opts, { today = null } = {}) {
	const { invoiceNumber, days, rate, date } = opts;
	const todayKey = today || api.appTodayKey();
	const original = db.prepare("SELECT * FROM invoices WHERE invoice_number = ?").get(invoiceNumber);
	if (!original) throw new Refusal(`invoice ${invoiceNumber} was not found`);

	// The driver's live invoices: not deleted, not Rejected, in any stored spelling.
	const key = api.normalizeDriverName(original.driver);
	const live = db.prepare("SELECT * FROM invoices WHERE COALESCE(deleted_at, '') = '' AND status != 'Rejected' ORDER BY id")
		.all().filter((r) => api.normalizeDriverName(r.driver) === key);
	const manualLines = (r) => parseJson(r.render_data || "", {}).lineItems || [];
	// Listed on every run, for a person to check.
	const manualSince = live.filter((r) => Number(r.is_manual) && String(r.week_end || "") >= original.week_start).map((r) => ({
		invoiceNumber: r.invoice_number, status: r.status, totalDue: api.invoiceTotalDue(r),
		lines: manualLines(r).map((l) => String(l.description || "")),
	}));
	// This script's corrections for the original: their lines start with its prefix.
	const prefix = correctionPrefix(invoiceNumber);
	const corrections = [];
	for (const r of live.filter((x) => Number(x.is_manual))) {
		const lines = manualLines(r).filter((l) => String(l.description || "").startsWith(prefix));
		if (lines.length) corrections.push({ row: r, lines, days: [...new Set(lines.map((l) => String(l.date || "")))].sort() });
	}

	// Idempotent first: a correction already naming exactly these days is the
	// answer, whatever the date or the month locks say now.
	const wanted = days.join(",");
	const exact = corrections.find((c) => c.days.join(",") === wanted);
	if (exact) {
		const rates = [...new Set(exact.lines.map((l) => cents(l.amount)))];
		if (rates.length !== 1 || rates[0] !== cents(rate)) {
			throw new Refusal(`${exact.row.invoice_number} (${exact.row.status}, total due ${usd(api.invoiceTotalDue(exact.row))}) already corrects ${invoiceNumber} for these days at ${rates.map((c) => usd(c / 100)).join(" / ")} a day, not ${usd(rate)}; nothing was drafted`);
		}
		return { state: "already", existing: exact.row, existingTotal: api.invoiceTotalDue(exact.row), original, manualSince };
	}

	if (original.deleted_at) throw new Refusal(`${invoiceNumber} is deleted`);
	if (original.status === "Rejected") throw new Refusal(`${invoiceNumber} is Rejected`);
	if (Number(original.is_manual)) throw new Refusal(`${invoiceNumber} is a manual invoice; this script corrects weekly driver invoices`);
	if (cents(original.adjustment) !== 0) throw new Refusal(`${invoiceNumber} carries an adjustment of ${usd(original.adjustment)}; the days may already be corrected`);
	const origRender = parseJson(original.render_data || "", null);
	if (!origRender || origRender.__templateName !== "service_invoice" || !origRender.days) {
		throw new Refusal(`${invoiceNumber} has no daily day grid to read, so the script can't tell which days it bills`);
	}
	for (const d of days) {
		if (!(original.week_start <= d && d <= original.week_end)) throw new Refusal(`${d} is not in ${invoiceNumber}'s week (${original.week_start} to ${original.week_end})`);
		const bills = gridBills(original, d);
		if (bills === null) throw new Refusal(`${invoiceNumber}'s day grid has no ${weekdayOf(d)} line, so the script can't tell whether it bills ${d}`);
		if (bills) throw new Refusal(`${invoiceNumber} already bills ${weekdayOf(d)} ${d}`);
	}

	if (date > todayKey) throw new Refusal(`--date ${date} is after today (${todayKey})`);
	if (date < original.week_start) throw new Refusal(`--date ${date} is before ${invoiceNumber}'s week (${original.week_start})`);
	const period = date.slice(0, 7);
	if (api.periodWriteLocked(period)) throw new Refusal(`${monthLabel(period)} is closed (or the month locks can't be read), so a correction can't be dated ${date}; use a day in the open month`);

	const payee = origRender.driverName && api.normalizeDriverName(origRender.driverName) === key ? String(origRender.driverName).trim() : String(original.driver).trim();
	const reserved = api.reservedDriverNameRefusal(payee, "payee");
	if (reserved) throw new Refusal(`${invoiceNumber}'s driver name can't be a payee: ${reserved.error}`);

	const partial = corrections.find((c) => c.days.some((d) => days.includes(d)));
	if (partial) throw new Refusal(`${partial.row.invoice_number} already corrects ${invoiceNumber} for ${partial.days.join(", ")}, which overlaps these days; nothing was drafted`);

	const originalUpper = invoiceNumber.toUpperCase();
	for (const r of live) {
		// This script's corrections of other days of the original: checked above.
		if (corrections.some((c) => c.row.id === r.id)) continue;
		if (!Number(r.is_manual)) {
			for (const d of days) {
				if (!(r.week_start <= d && d <= r.week_end)) continue;
				const bills = gridBills(r, d);
				if (bills === null) throw new Refusal(`${r.invoice_number} covers ${d} but has no day grid, so the script can't tell whether it pays that day`);
				if (bills) throw new Refusal(`${weekdayOf(d)} ${d} is already billed on ${r.invoice_number} (${r.status})`);
			}
			continue;
		}
		const lines = manualLines(r);
		for (const d of days) {
			if (lines.some((l) => String(l.date || "") === d)) throw new Refusal(`${r.invoice_number} (${r.status}) has a line dated ${d}; it may already pay that day`);
			if (r.week_start <= d && d <= r.week_end && lines.some((l) => !String(l.date || "").trim())) {
				throw new Refusal(`${r.invoice_number} (${r.status}) covers ${d} with an undated line, so the script can't tell whether it pays that day`);
			}
		}
		// A line or the notes naming the original: a hand-made correction.
		const texts = [...lines.map((l) => ({ text: String(l.description || ""), date: String(l.date || "").trim() })),
			{ text: String(parseJson(r.render_data || "", {}).notes || ""), date: "" }];
		for (const t of texts) {
			if (!t.text.toUpperCase().includes(originalUpper)) continue;
			const named = days.find((d) => namesDay(t.text, d));
			if (named) throw new Refusal(`${r.invoice_number} (${r.status}) names ${invoiceNumber} and ${named}; it may already pay that day`);
			if (!t.date && !READABLE_DATE_RE.test(t.text)) {
				throw new Refusal(`${r.invoice_number} (${r.status}) names ${invoiceNumber} with no date the script can read, so it can't tell whether it already pays these days`);
			}
		}
	}

	const lineItems = days.map((d) => ({ date: d, description: `${prefix} ${weekdayOf(d)}, ${longDay(d)}, ${usdShort(rate)}`, amount: rate }));
	const itemsRes = api.sanitizeManualInvoiceRows(lineItems, "lineItems");
	if (itemsRes.error) throw new Refusal(itemsRes.error);
	const dedRes = api.sanitizeManualInvoiceRows([], "deductions");
	const totals = api.manualInvoiceTotals(itemsRes.items, dedRes.items);
	if (cents(totals.totalDue) !== days.length * cents(rate)) throw new Error(`total ${usd(totals.totalDue)} is not ${days.length} x ${usd(rate)}`);

	const closed = monthsBetween(original.week_start, original.week_end).filter((m) => api.periodWriteLocked(m));
	const notes = `Correction for ${invoiceNumber} (billing week ${longDay(original.week_start)} - ${longDay(original.week_end)}): ` +
		`${days.length} day${days.length === 1 ? "" : "s"} that invoice did not bill, at ${usdShort(rate)} a day. ` +
		(closed.length
			? `Dated in ${monthLabel(period)} because ${closed.map(monthLabel).join(" and ")} ${closed.length === 1 ? "is" : "are"} closed.`
			: `Dated in ${monthLabel(period)}.`);
	const invoiceNumberNew = api.generateInvoiceNumber(payee, date, { prefix: "INV-M-" });
	const onFile = api.findInvoicePayee(payee);
	const renderData = {
		payeeName: payee,
		payeeRole: "",
		payeeAddress: ((onFile && onFile.address) || "").slice(0, 200),
		payeePhone: ((onFile && onFile.phone) || "").slice(0, 40),
		invoiceNumberSuffix: invoiceNumberNew.replace(/^INV-/, ""),
		issueDate: api.appTime.dateTextInZone(new Date(`${date}T12:00:00Z`), api.APP_TIMEZONE),
		billingPeriodStart: longDay(date),
		billingPeriodEnd: longDay(date),
		lineItems: itemsRes.items,
		deductions: dedRes.items,
		subtotal: totals.subtotal,
		deductionsTotal: totals.deductionsTotal,
		totalDue: totals.totalDue,
		notes: notes.slice(0, 500),
		preparedBy: PREPARED_BY,
		adjustment: 0,
		adjustmentNote: "",
	};
	const row = {
		invoice_number: invoiceNumberNew,
		driver: payee.toLowerCase(),
		week_start: date,
		week_end: date,
		loads_count: itemsRes.items.length,
		rate_per_load: 0,
		total_earnings: totals.totalDue,
		expenses_total: totals.deductionsTotal,
		status: "Draft",
		pdf_file_name: api.invoicePdfFileName(invoiceNumberNew),
		load_ids: "[]",
		expense_ids: "[]",
		render_data: JSON.stringify({ ...renderData, __templateName: TEMPLATE }),
		is_manual: 1,
		created_by: ACTOR,
	};
	const audit = {
		user_id: SYSTEM_USER.id, username: SYSTEM_USER.username, role: SYSTEM_USER.role,
		action: AUDIT_ACTION, entity: "invoice",
		details: `${invoiceNumberNew} (Draft) for ${payee}: correction for ${invoiceNumber} (invoice id ${original.id}), ` +
			`days ${days.join(", ")} at ${usd(rate)} = ${usd(totals.totalDue)}, dated ${date}`,
	};
	return { state: "draft", original, payee, renderData, row, audit, closed, period, manualSince };
}

// The route's INSERT (POST /api/invoices/manual), and the audit row.
const INSERT_INVOICE = `INSERT INTO invoices (invoice_number, driver, week_start, week_end, loads_count, rate_per_load, total_earnings, expenses_total, status, pdf_file_name, load_ids, expense_ids, render_data, is_manual, created_by)
	 VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'Draft', ?, '[]', '[]', ?, 1, ?)`;
const INSERT_AUDIT = "INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

// The comparable part of a plan: a re-plan inside the transaction must match it.
const planKey = (p) => JSON.stringify({ row: p.row, audit: p.audit.details });

// Draft the correction. Returns { state, plan?, invoice?, auditId? }.
async function run(db, api, opts, { today = null } = {}) {
	const first = plan(db, api, opts, { today });
	if (first.state === "already" || opts.dryRun) return { state: first.state, plan: first };
	const pdfBuffer = await api.renderPolicy(TEMPLATE, first.renderData);
	let auditId = null;
	const result = api.commitInvoiceWithPdf({
		invoiceNumber: first.row.invoice_number, pdfFileName: first.row.pdf_file_name, pdfBuffer,
		insert: () => {
			const again = plan(db, api, opts, { today });
			if (again.state !== "draft" || planKey(again) !== planKey(first)) {
				throw new Refusal(again.state === "already"
					? `${again.existing.invoice_number} was drafted for these days while this run rendered its PDF; nothing was written`
					: "the invoices changed while this run rendered its PDF; nothing was written, run it again");
			}
			const r = first.row;
			const res = db.prepare(INSERT_INVOICE).run(r.invoice_number, r.driver, r.week_start, r.week_end, r.loads_count, r.total_earnings, r.expenses_total, r.pdf_file_name, r.render_data, r.created_by);
			const a = first.audit;
			auditId = db.prepare(INSERT_AUDIT).run(new Date().toISOString(), a.user_id, a.username, a.role, a.action, a.entity, String(res.lastInsertRowid), a.details).lastInsertRowid;
			return res;
		},
	});
	const invoice = db.prepare("SELECT * FROM invoices WHERE id = ?").get(result.lastInsertRowid);
	return { state: "written", plan: first, invoice, auditId };
}

// `env` decides the daily-rate rule's wording (lib/driver-rate-only.js): from
// DRIVER_RATE_ONLY_FROM on, a driver with no rate of his own is paid the $250
// default, not his truck's rate.
function describe(p, opts, dirRow, env = process.env) {
	const o = p.original;
	const ruleFrom = driverRateOnly.ruleFromEnv(env);
	const ruleCovers = !!ruleFrom && String(o.week_end || "").slice(0, 7) >= ruleFrom;
	const out = [];
	const grid = dayGrid(o);
	const billed = grid ? WEEKDAYS.filter((w) => lineBills(grid[w])).join(", ") || "no day" : "unknown (no day grid)";
	out.push(`Original: ${o.invoice_number} (id ${o.id}, ${o.status}, week ${o.week_start} to ${o.week_end}, ${usd(o.rate_per_load)}/day, bills ${billed})`);
	out.push(`Live manual invoices for this driver from ${o.week_start} on: ${p.manualSince.length ? "" : "none"}`);
	for (const m of p.manualSince) out.push(`  ${m.invoiceNumber} (${m.status}, total due ${usd(m.totalDue)}): ${m.lines.map((l) => JSON.stringify(l)).join(" | ") || "no lines"}`);
	if (p.state === "already") return out;
	const r = p.row;
	const rd = p.renderData;
	out.push(`Invoice row: ${r.invoice_number}, ${r.status}, manual, driver "${r.driver}", period ${r.week_start} to ${r.week_end}, issue date ${rd.issueDate}, ` +
		`${r.loads_count} line(s), total ${usd(r.total_earnings)}, deductions ${usd(r.expenses_total)}, created by "${r.created_by}"`);
	rd.lineItems.forEach((l, i) => out.push(`  line ${i + 1}: ${l.date}  ${l.description}  ${usd(l.amount)}`));
	out.push(`  subtotal ${usd(rd.subtotal)}, deductions ${usd(rd.deductionsTotal)}, total due ${usd(rd.totalDue)}`);
	out.push(`  notes: ${rd.notes}`);
	out.push(`  payee address on file: ${rd.payeeAddress ? "yes" : "none"}, phone on file: ${rd.payeePhone ? "yes" : "none"}`);
	out.push(`PDF: uploads/invoices/${r.pdf_file_name}`);
	out.push(`Audit row: ${p.audit.action}, ${p.audit.entity} <new id>, by "${p.audit.username}" (${p.audit.role}): ${p.audit.details}`);
	const dirRate = dirRow ? Number(dirRow.pay_daily) || 0 : null;
	out.push(`Rate: --rate ${usd(opts.rate)}; the original invoice's rate ${usd(o.rate_per_load)}; drivers directory now ${dirRate == null ? "no row" : dirRate > 0 ? usd(dirRate) : ruleCovers ? "not set ($250 default)" : "not set (truck rate applies)"}`);
	if (cents(opts.rate) !== cents(o.rate_per_load) || (dirRate && cents(opts.rate) !== cents(dirRate))) out.push("NOTE: the rates above differ; confirm the rate before approving the draft.");
	if (!p.closed.length) out.push(`NOTE: ${o.invoice_number}'s week is in open months; an adjustment on it (PUT /api/invoices/:id/adjust) would also work.`);
	return out;
}

// Returns the exit code. The PDF renderer's shared browser is shut down
// whatever happens, or it would keep the process alive after the write.
async function main() {
	const opts = readOptions(process.argv.slice(2));
	const target = resolveTarget(opts, ROOT);
	const appRequire = createRequire(path.join(ROOT, "server.js"));
	const Database = appRequire("better-sqlite3");
	const db = new Database(target.file, { readonly: opts.dryRun, fileMustExist: true });
	try {
		if (opts.dryRun && !db.readonly) throw new Error("refusing: the dry run's SQLite handle is not read-only");
		db.pragma("busy_timeout = 10000");
		const { api } = buildWorld({ db, dataDir: target.dataDir });
		console.log(`Database: ${target.file} (${target.scope === "app" ? "the app's own" : "a copy"}); PDFs: ${path.join(target.dataDir, "uploads", "invoices")}`);
		const out = await run(db, api, opts);
		const p = out.plan;
		// The directory row pay reads: the first one in the driver's name.
		const directory = db.prepare("SELECT driver_name, pay_daily FROM drivers_directory ORDER BY id").all()
			.find((d) => api.normalizeDriverName(d.driver_name) === api.normalizeDriverName(p.original.driver)) || null;
		if (out.state === "already") {
			for (const line of describe(p, opts, directory)) console.log(line);
			console.log(`already drafted: ${p.existing.invoice_number} (id ${p.existing.id}, ${p.existing.status}, total due ${usd(p.existingTotal)}) corrects ${opts.invoiceNumber} for ${opts.days.join(", ")}; nothing written`);
		} else if (opts.dryRun) {
			console.log("DRY RUN: nothing written.");
			for (const line of describe(p, opts, directory)) console.log(line);
		} else {
			for (const line of describe(p, opts, directory)) console.log(line);
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
	ACTOR, AUDIT_ACTION, PREPARED_BY, ROOTS, PROVIDED, DENIED, TEMPLATE, INSERT_INVOICE, Refusal,
	readOptions, resolveTarget, buildWorld, plan, run, describe, monthsBetween, namesDay,
};
