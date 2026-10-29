#!/usr/bin/env node
// scripts/driver-rate-lines-report.js — read-only: one daily-rate driver's
// invoice day lines dated on or after a day, each judged against his own rate
// in effect that day, with the correction route today's code offers for it.
// It prints ids, days and amounts only: no name, address, phone or note.
//
// The rate in effect on a day is the server's own reading of pay_rate_history:
// driverDayRater().ownRateOn() (loadPayRateIndex(): the latest driver row whose
// business day is on or before that day, a day before the first row reads the
// first row, no row reads his current Drivers Database rate), lifted from this
// checkout's server.js (scripts/lib/server-lift.js) on a read-only handle. A day
// whose own rate reads $0 or less is not judged (a truck rate or the $250
// default prices it, which this report does not decide).
//
// The lines:
//   - a weekly invoice (service_invoice): each paid day of its Saturday-Friday
//     grid (render_data.days[<weekday>].completed), one day at its printed total;
//   - a manual invoice (service_invoice_manual): each line the server counts as
//     one day's pay (DAY_PAY_DRAFT_LINE_RE: "Correction for <invoice>: ..." and
//     "Missed week ...: ..."), dated that day, at its amount. Other dated lines
//     are listed as not judged. A Personal correction (is_correction) pays no day.
// Live and soft-deleted invoices are reported apart; each deleted line says
// whether a live invoice (not Rejected) pays its day. Days no invoice carries
// are not listed: finding them needs the Job Tracking sheet.
//
// The route for a live line whose printed amount differs, as today's code has it:
//   the day's month is closed           none (closed months stay as recorded)
//   Approved, Processing, Paid          the difference on the driver's next invoice
//   weekly Draft                        regenerate the Draft (POST /api/invoices/generate),
//                                       or, when its week touches a closed month,
//                                       a manual invoice in the open month
//   manual Draft                        adjust it or re-create it at the correct rate,
//                                       or, when its period touches a closed month,
//                                       re-create it in the open month
//   Submitted, Rejected                 an adjustment (PUT /api/invoices/:id/adjust),
//                                       or, when its week touches a closed month
//                                       (invoiceMonthLockBlockers(), the adjust route's
//                                       own guard), a manual invoice in the open month
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/driver-rate-lines-report.js --db app --driver-id <users.id> --from <YYYY-MM-DD> [--json]
//   --db app | <file>   required: "app" is the app's own database as server.js opens
//                       it (scripts/lib/app-database.js; refused while LOCAL_REPLICA
//                       is set); a file must be a copy outside this repository and
//                       outside any app directory
//   --driver-id <id>    the driver's user id (a Driver account; its driver name
//                       keys his invoices, Drivers Database row and rate history)
//   --from <day>        the first day whose lines are judged
//   --json              the whole result as JSON (default: a text report)
// Exit codes: 0 done (whatever it found); 1 error; 2 refused. Nothing is ever
// written: the handle is opened read-only and refused otherwise.
//
// Required as a module (by its test runner) it runs nothing and exports its parts.

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { closure } = require("./lib/server-lift");
const { serverSource } = require("./lib/server-source");
const { parseArgs } = require("./lib/ledger-world");
const { resolveDatabase, DatabaseRefusal } = require("./lib/app-database");

const ROOT = path.join(__dirname, "..");
const OPTIONS = ["db", "driver-id", "from", "json"];
const ROOTS = ["normalizeDriverName", "driverDayRater", "getDriverPayStructures", "appDay", "invoiceGridDayName",
	"periodLocksReadable", "periodWriteLocked", "invoiceMonthLockBlockers", "DAY_PAY_DRAFT_LINE_RE", "APP_TIMEZONE"];
const PROVIDED = ["db", "require", "console", "process", "__dirname", "fetch"];
const DENIED = ["app", "getSheets", "sheets", "SPREADSHEET_ID", "KEY_FILE", "server", "io", "sendEmail", "transporter", "getDrive",
	"notifyChange", "logAudit", "getJobTrackingCached", "jtCacheInvalidate", "commitInvoiceWithPdf"];
const LIFTED_REQUIRE_OK = (m) => ["crypto", "path", "fs"].includes(m) || /^\.\/lib\/[\w.-]+$/.test(m);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const APPROVED = ["Approved", "Processing", "Paid"];
const GRID_TEMPLATE = "service_invoice";
const MANUAL_TEMPLATE = "service_invoice_manual";

class Refusal extends Error {}

const cents = (x) => Math.round(Number(x || 0) * 100);
const usd = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
const signed = (c) => (c > 0 ? `+${usd(c)}` : usd(c));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDay = (s) => DAY_RE.test(String(s || "")) && addDays(String(s), 0) === String(s);
const parseSnapshot = (text) => {
	try {
		const v = JSON.parse(text || "{}");
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
};

// The command line, checked before anything is opened.
function readOptions(argv) {
	for (const a of argv) {
		if (!a.startsWith("--")) continue;
		const name = a.slice(2).split("=")[0];
		if (!OPTIONS.includes(name)) throw new Refusal(`unknown option --${name}`);
	}
	const args = parseArgs(argv);
	const text = (k) => (typeof args[k] === "string" ? args[k].trim() : "");
	const db = text("db");
	if (!db) throw new Refusal("--db is required: \"app\" for the app's own database, or a copy's file");
	const id = text("driver-id");
	if (!/^[1-9]\d{0,9}$/.test(id)) throw new Refusal("--driver-id <users.id> is required: the driver's user id, a whole number");
	const from = text("from");
	if (!isDay(from)) throw new Refusal("--from <YYYY-MM-DD> is required: the first day whose lines are judged");
	if (args.json !== undefined && args.json !== true) throw new Refusal("--json takes no value");
	return { db, driverId: Number(id), from, json: args.json === true };
}

// The server.js code the report reads with, lifted from `root`'s server.js and
// bound to the read-only handle `db`. `env` is what the lifted code reads as
// process.env (only APP_TIMEZONE matters here). Warnings are collected.
function buildWorld({ db, root = ROOT, env = {} }) {
	const lifted = closure(serverSource({ root }), { roots: ROOTS, provided: PROVIDED, denied: DENIED });
	const appRequire = createRequire(path.join(root, "server.js"));
	const warnings = [];
	const quiet = { log() {}, info() {}, error: (...a) => warnings.push(a.join(" ")), warn: (...a) => warnings.push(a.join(" ")) };
	const liftedRequire = (m) => {
		if (!LIFTED_REQUIRE_OK(m)) throw new Error(`lifted code required ${m}, which this script does not load`);
		return appRequire(m);
	};
	const noFetch = () => { throw new Error("lifted code called fetch(); this script makes no network calls"); };
	const scriptProcess = { env: { ...env }, argv: [], exit: () => { throw new Error("lifted code called process.exit()"); } };
	const body = ['"use strict";', lifted.text, `return { ${ROOTS.join(", ")} };`].join("\n");
	const api = new Function(...PROVIDED, body)(db, liftedRequire, quiet, scriptProcess, root, noFetch);
	return { api, warnings, liftedNames: lifted.names };
}

// Opens `file` read-only; refuses a handle that is not.
function openReadOnly(file, root = ROOT) {
	const Database = createRequire(path.join(root, "server.js"))("better-sqlite3");
	const db = new Database(file, { readonly: true, fileMustExist: true });
	if (!db.readonly) {
		db.close();
		throw new Error("refusing: the SQLite handle is not read-only");
	}
	db.pragma("query_only = ON");
	return db;
}

// The route today's code offers for a live line that differs.
function routeFor(api, inv, line) {
	if (line.monthClosed) return { key: "none-closed-month", text: "none: the day's month is closed (closed months stay as recorded)" };
	if (APPROVED.includes(inv.status)) return { key: "next-invoice", text: "the difference on the driver's next invoice (this invoice is approved or paid)" };
	const lock = api.invoiceMonthLockBlockers(inv);
	const closedSpan = lock.unreadable ? ["(period locks unreadable)"] : [...new Set(lock.blockers.flatMap((b) => b.periods))].filter(Boolean).sort();
	const touches = lock.unreadable || lock.blockers.length > 0;
	const open = (what) => `a manual invoice dated in the open month (New Manual Invoice) for the difference: ${what} touches closed ${closedSpan.join(", ")}`;
	if (inv.kind === "weekly" && inv.status === "Draft") {
		return touches ? { key: "open-month-manual", text: open("its week") } : { key: "regenerate", text: "regenerate the Draft (POST /api/invoices/generate)" };
	}
	if (inv.kind === "manual" && inv.status === "Draft") {
		return touches
			? { key: "recreate-open-month", text: `re-create the Draft dated in the open month: its period touches closed ${closedSpan.join(", ")}` }
			: { key: "adjust-or-recreate", text: "adjust the Draft (PUT /api/invoices/:id/adjust) or re-create it at the correct rate" };
	}
	return touches
		? { key: "open-month-manual", text: `${open("its week")} (the adjust route refuses it)` }
		: { key: "adjustment", text: "an adjustment (PUT /api/invoices/:id/adjust)" };
}

// The report for one driver. `today` (a business day) bounds the rate table.
function buildReport(db, api, { driverId, from, today = null }) {
	if (!api.periodLocksReadable()) throw new Refusal("period_locks cannot be read, so no month can be told open or closed");
	const user = db.prepare("SELECT id, role, driver_name FROM users WHERE id = ?").get(driverId);
	if (!user) throw new Refusal(`no user ${driverId}`);
	if (user.role !== "Driver") throw new Refusal(`user ${driverId} is not a Driver account (role ${user.role})`);
	const key = api.normalizeDriverName(user.driver_name);
	if (!key) throw new Refusal(`user ${driverId} names no driver`);
	const directoryIds = db.prepare("SELECT id, driver_name FROM drivers_directory ORDER BY id").all()
		.filter((r) => api.normalizeDriverName(r.driver_name) === key).map((r) => r.id);
	const struct = api.getDriverPayStructures()[key];
	if (!struct || !directoryIds.length) throw new Refusal(`user ${driverId} has no Drivers Database row, so no own rate to judge by`);
	if (struct.payType !== "fixed") throw new Refusal(`user ${driverId} is paid by percentage; only daily-rate lines are judged`);
	const todayKey = today || api.appDay(new Date());

	const rater = api.driverDayRater();
	const rateOn = (day) => cents(rater.ownRateOn(key, struct.payDaily, day));
	const history = db.prepare("SELECT id, rate, effective_from, source FROM pay_rate_history WHERE subject = 'driver' AND subject_key = ? ORDER BY effective_from, id").all(key)
		.map((r) => {
			const d = new Date(r.effective_from);
			return { id: r.id, rate: cents(r.rate), day: isNaN(d) ? "" : api.appDay(d), source: r.source };
		});
	const closedMonths = db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period);

	const invoices = db.prepare("SELECT * FROM invoices ORDER BY week_start, id").all()
		.filter((inv) => api.normalizeDriverName(inv.driver || "") === key);
	const live = [];
	const deleted = [];
	const notJudged = [];
	// Days a live invoice (not Rejected) pays: a weekly grid day, a manual line's date, its paidDays.
	const paidLive = new Map();
	const notePaid = (day, id) => { if (!paidLive.has(day)) paidLive.set(day, []); paidLive.get(day).push(id); };

	for (const inv of invoices) {
		const snap = parseSnapshot(inv.render_data);
		const isDeleted = String(inv.deleted_at || "") !== "";
		const kind = Number(inv.is_manual) ? "manual" : "weekly";
		const head = {
			invoiceId: inv.id, kind, status: inv.status, weekStart: inv.week_start, weekEnd: inv.week_end,
			deleted: isDeleted, deletedOn: isDeleted ? String(inv.deleted_at).slice(0, 10) : "", adjustment: cents(inv.adjustment),
		};
		const lines = [];
		if (kind === "weekly") {
			if (!snap || snap.__templateName !== GRID_TEMPLATE || !snap.days || !isDay(inv.week_start)) {
				notJudged.push({ ...head, why: "no daily day grid (a percentage or pre-snapshot invoice)" });
				continue;
			}
			for (let i = 0; i < 7; i++) {
				const day = addDays(inv.week_start, i);
				const cell = snap.days[api.invoiceGridDayName(day)] || {};
				if (!cell.completed) continue;
				if (!isDeleted && inv.status !== "Rejected") notePaid(day, inv.id);
				lines.push({ day, used: cents(cell.total) });
			}
		} else {
			if (Number(inv.is_correction)) {
				notJudged.push({ ...head, why: "a Personal correction: it pays no day" });
				continue;
			}
			const items = snap && Array.isArray(snap.lineItems) ? snap.lineItems : [];
			if (!isDeleted && inv.status !== "Rejected" && snap && Array.isArray(snap.paidDays)) {
				for (const d of snap.paidDays) if (isDay(d)) notePaid(String(d), inv.id);
			}
			for (const l of items) {
				const day = String((l && l.date) || "").trim();
				if (!isDay(day)) continue;
				if (!isDeleted && inv.status !== "Rejected") notePaid(day, inv.id);
				if (day < from) continue;
				if (!api.DAY_PAY_DRAFT_LINE_RE.test(String((l && l.description) || ""))) {
					notJudged.push({ ...head, day, amount: cents(l.amount), why: "a dated line that is not one day's pay" });
					continue;
				}
				lines.push({ day, used: cents(l.amount) });
			}
		}
		for (const l of lines) {
			if (l.day < from) continue;
			const correct = rateOn(l.day);
			const month = l.day.slice(0, 7);
			const row = { ...head, day: l.day, month, monthClosed: api.periodWriteLocked(month), days: 1, used: l.used, correct, difference: correct - l.used };
			if (correct <= 0) {
				notJudged.push({ ...head, day: l.day, amount: l.used, why: "no own rate in effect that day" });
				continue;
			}
			(isDeleted ? deleted : live).push(row);
		}
	}

	for (const row of live) {
		row.differs = row.difference !== 0;
		row.route = row.differs ? routeFor(api, { ...invoices.find((i) => i.id === row.invoiceId), kind: row.kind }, row) : null;
	}
	for (const row of deleted) {
		row.differs = row.difference !== 0;
		row.paidByLive = (paidLive.get(row.day) || []).slice().sort((a, b) => a - b);
	}

	// The rate in effect per day, --from to the later of today and the last line, as runs.
	const lastDay = [todayKey, ...live.map((r) => r.day), ...deleted.map((r) => r.day)].sort().pop();
	const rateRuns = [];
	for (let d = from; d <= lastDay; d = addDays(d, 1)) {
		const rate = rateOn(d);
		const last = rateRuns[rateRuns.length - 1];
		if (last && last.rate === rate) last.to = d;
		else rateRuns.push({ from: d, to: d, rate });
	}

	const differing = live.filter((r) => r.differs);
	const byStatus = {};
	for (const r of differing) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
	const byRoute = {};
	for (const r of differing) byRoute[r.route.key] = (byRoute[r.route.key] || 0) + 1;
	return {
		driver: { userId: user.id, directoryRowIds: directoryIds, payType: struct.payType, ownRateNow: cents(struct.payDaily) },
		from, today: todayKey, zone: api.APP_TIMEZONE, closedMonths,
		history, rateRuns,
		counts: {
			invoices: invoices.length,
			liveInvoices: invoices.filter((i) => !String(i.deleted_at || "")).length,
			deletedInvoices: invoices.filter((i) => String(i.deleted_at || "")).length,
			liveLines: live.length,
			liveLinesDiffering: differing.length,
			liveDifferingByStatus: byStatus,
			liveDifferingByRoute: byRoute,
			liveDifference: differing.reduce((c, r) => c + r.difference, 0),
			deletedLines: deleted.length,
			deletedLinesDiffering: deleted.filter((r) => r.differs).length,
			deletedLinesOnNoLiveInvoice: deleted.filter((r) => !r.paidByLive.length).length,
			notJudged: notJudged.length,
		},
		live, deleted, notJudged,
	};
}

function printText(r, { dbLabel }) {
	const c = r.counts;
	const out = [];
	out.push("Driver rate lines report (read-only; nothing was written)");
	out.push(`Database: ${dbLabel}`);
	out.push(`Driver: user ${r.driver.userId}, Drivers Database row ${r.driver.directoryRowIds.join(", ")}${r.driver.directoryRowIds.length > 1 ? " (pay reads the first)" : ""}, pay type ${r.driver.payType}, own rate now ${usd(r.driver.ownRateNow)}`);
	out.push(`Lines dated ${r.from} or later; business day zone ${r.zone}; today ${r.today}`);
	out.push(`Closed months: ${r.closedMonths.length ? `${r.closedMonths.join(", ")} (latest ${r.closedMonths[r.closedMonths.length - 1]})` : "none"}`);
	out.push("Rate history (pay_rate_history, driver rows; business day of effective_from):");
	if (!r.history.length) out.push("  none: every day reads the current own rate");
	for (const h of r.history) out.push(`  row ${h.id}  ${usd(h.rate)} from ${h.day || "(unreadable)"}  ${h.source}`);
	out.push(`Rate in effect: ${r.rateRuns.map((x) => `${x.from === x.to ? x.from : `${x.from}..${x.to}`} ${usd(x.rate)}`).join("; ")}`);
	out.push("");
	out.push(`Invoices: ${c.invoices} (${c.liveInvoices} live, ${c.deletedInvoices} deleted)`);
	const statusText = Object.entries(c.liveDifferingByStatus).map(([s, n]) => `${s} ${n}`).join(", ") || "none";
	const routeText = Object.entries(c.liveDifferingByRoute).map(([s, n]) => `${s} ${n}`).join(", ") || "none";
	out.push(`Live lines: ${c.liveLines}; differing ${c.liveLinesDiffering} (by status: ${statusText}; by route: ${routeText}); difference ${signed(c.liveDifference)}`);
	out.push(`Deleted invoices' lines: ${c.deletedLines}; differing ${c.deletedLinesDiffering}; on no live invoice ${c.deletedLinesOnNoLiveInvoice}`);
	out.push(`Not judged: ${c.notJudged}`);
	out.push("");
	out.push("Live lines (invoice, kind, status, week, day, days, used -> correct, difference, month, route):");
	if (!r.live.length) out.push("  none");
	for (const l of r.live) {
		out.push(`  invoice ${l.invoiceId}  ${l.kind}  ${l.status}  ${l.weekStart}..${l.weekEnd}  ${l.day}  ${l.days} day  ${usd(l.used)} -> ${usd(l.correct)}  ${signed(l.difference)}  ${l.month} ${l.monthClosed ? "closed" : "open"}  ${l.differs ? `DIFFERS: ${l.route.text}` : "ok"}`);
	}
	out.push("");
	out.push("Deleted invoices' lines (invoice, kind, status when deleted, deleted on, day, days, used -> correct, difference, paid by a live invoice):");
	if (!r.deleted.length) out.push("  none");
	for (const l of r.deleted) {
		out.push(`  invoice ${l.invoiceId}  ${l.kind}  ${l.status}  deleted ${l.deletedOn}  ${l.day}  ${l.days} day  ${usd(l.used)} -> ${usd(l.correct)}  ${signed(l.difference)}  ${l.paidByLive.length ? `yes (invoice ${l.paidByLive.join(", ")})` : "no live invoice pays this day"}`);
	}
	out.push("");
	out.push("Not judged (invoice, status, day, amount, why):");
	if (!r.notJudged.length) out.push("  none");
	for (const n of r.notJudged) out.push(`  invoice ${n.invoiceId}  ${n.status}${n.deleted ? " (deleted)" : ""}  ${n.day || "-"}  ${n.amount == null ? "-" : usd(n.amount)}  ${n.why}`);
	return out.join("\n");
}

function main(argv = process.argv.slice(2)) {
	const opts = readOptions(argv);
	let target;
	try {
		target = resolveDatabase(opts.db === "app" ? null : opts.db, ROOT);
	} catch (err) {
		if (err instanceof DatabaseRefusal) throw new Refusal(err.message);
		throw err;
	}
	const db = openReadOnly(target.file);
	try {
		const env = process.env.APP_TIMEZONE ? { APP_TIMEZONE: process.env.APP_TIMEZONE } : {};
		const { api } = buildWorld({ db, env });
		const report = buildReport(db, api, opts);
		if (opts.json) console.log(JSON.stringify(report, null, 1));
		else console.log(printText(report, { dbLabel: `${target.scope === "app" ? "the app's own" : "a copy"} (read-only handle)` }));
		return 0;
	} finally {
		db.close();
	}
}

if (require.main === module) {
	try {
		process.exit(main());
	} catch (err) {
		if (err instanceof Refusal) { console.error(`REFUSED: ${err.message}`); process.exit(2); }
		console.error(`ERROR: ${err.stack || err.message}`);
		process.exit(1);
	}
}

module.exports = { ROOTS, DENIED, OPTIONS, Refusal, readOptions, buildWorld, openReadOnly, buildReport, routeFor, printText, main };
