#!/usr/bin/env node
// scripts/driver-rate-only-report.js — the read-only "what would change" report
// for the owner's daily-rate rule (2026-10-16; DRIVER_RATE_ONLY_ENABLED and
// DRIVER_RATE_ONLY_FROM, lib/driver-rate-only.js): a daily rate belongs to the
// driver, and $250 is the default only when he has none. Run it on the server
// with no login before the flag goes on.
//
// It lifts the server's own payout ledger (computeFleetLedger()), investor
// payables (computeInvestorMonthlyEarnings(), the loss carried forward
// included) and invoice day pricing (invoiceDayRater(), resolveDailyRate())
// from this checkout's server.js twice (scripts/lib/ledger-world.js): once with
// the rule off and once with it on from --from, every other setting as the
// app's .env has it, each on a read-only handle of app.db. Nothing is written:
// with the rule on, the start record the server would stamp is this run's own,
// in memory (a month closed before now keeps the old rule).
//
// It reports:
//   - drivers: each daily-rate driver whose rate changes: { driver, ownRate,
//     truck, truckRate, rateToday, rateUnderRule } (truck: the last truck naming
//     him, whose rate the pay paths read today);
//   - driverMonths: per scope (owner id; 0 is the company), driver and month,
//     FROM and later, the payout ledger's days and driver pay now and under the
//     rule, where they differ;
//   - investorMonths: per investor and month, FROM and later, the payable now
//     and under the rule (the loss carried forward included) and driver pay;
//   - invoices: each issued (not Draft, not deleted) weekly invoice with a paid
//     day that pays in FROM or later whose printed amount differs from the
//     rule's rate for that day: { invoiceNumber, driver, status, days,
//     printedRate, ruleRate, difference, correction }, correction being
//     "adjustment" (its week is all in open months) or "correction draft" (its
//     week touches a closed month). Issued invoices are never regenerated;
//   - drafts: Draft weekly invoices (regenerate them) and Draft manual
//     correction invoices whose per-day line differs from the rule's rate;
//   - ledgerDaysOnNoInvoice: the payout ledger's days, FROM and later, whose
//     pay changes and that no live weekly invoice carries;
//   - historyGaps: { driver, from, to }, days from FROM on whose dated rate
//     (pay_rate_history) reads $0 while the driver has a rate of his own now
//     (what the dated-rate and trip rules would pay at $250);
//   - closedMonthsUnchanged: every closed month and every month before FROM
//     identical with the rule off and on, and a fingerprint of the closed
//     months' frozen rows. If not, the run exits 1 after printing.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/driver-rate-only-report.js --from=YYYY-MM --db=app.db --sheet-id=<id> [--key=service-account-key.json] [--names] [--json]
//   --from=YYYY-MM         the DRIVER_RATE_ONLY_FROM to try. Refused unless it is
//                          after the latest closed month
//   --sheet-id=env         the SPREADSHEET_ID the .env sets (refused when none)
//   --values-json=<file>   a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>      with a copy of the database under the temp directory only
//   --names                name drivers and investors (default: "driver 1", …,
//                          numbered per run, and investors by owner id)
//   --json                 print the whole result as JSON (default: a text report)
//   --dry-run              accepted; the run is always read-only
// Exit codes: 0 done, 1 error or a closed month would change, 2 refused.

"use strict";

const crypto = require("crypto");
const path = require("path");
const { createRequire } = require("module");
const { buildLedgerWorld, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const driverRateOnly = require("../lib/driver-rate-only");
const ledgerDayOnce = require("../lib/ledger-day-once");

const ROOT = path.join(__dirname, "..");
const FINGERPRINTED = ["investor_payouts", "investor_payout_history", "financials_ledger_items", "financials_ledger_freezes", "period_locks"];
// What the report lifts beside the ledger (ledger-world's own ROOTS).
const EXTRA_ROOTS = [
	"getDriverPayStructures", "truckDailyRateCandidates", "resolveDailyRate", "normalizeDriverName", "driverNameForTotals",
	"loadAssignedMonthKey", "jobTrackingMonthCols", "normalizeLoadId", "loadPayRateIndex", "invoiceGridDayName", "invoiceDayRater",
	"appDay", "TRIP_WORK_DAYS_FROM", "DRIVER_RATE_ONLY_FROM",
];
// A correction's per-day line ("Correction for <invoice>: <Weekday, Month D, YYYY>, $<rate>").
const DAY_LINE_RE = /^Correction for [^:]+: (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), /;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (x) => Math.round(x * 100) / 100;
const usd = (x) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const cents = (x) => Math.round(Number(x || 0) * 100);
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function refuse(msg) {
	console.error(`REFUSED: ${msg}`);
	process.exit(2);
}

function latestClosedOf(dbFile) {
	const Database = createRequire(path.join(ROOT, "server.js"))("better-sqlite3");
	const probe = new Database(dbFile, { readonly: true, fileMustExist: true });
	try {
		if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'period_locks'").get()) {
			refuse("the database has no period_locks table, so its closed months cannot be told");
		}
		return ledgerDayOnce.latestClosedMonth(probe);
	} finally {
		probe.close();
	}
}

// sha256 of one table's closed-month rows (empty when the table is absent).
function closedRowsHash(db, table, periods) {
	const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
	const rows = present && periods.length
		? db.prepare(`SELECT * FROM "${table}" WHERE period IN (${periods.map(() => "?").join(", ")}) ORDER BY rowid`).all(...periods)
		: [];
	return { rows: rows.length, sha256: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}

// One rate when every listed day shares it, else null.
function oneRate(list, key) {
	const set = new Set(list.map((d) => d[key]));
	return set.size === 1 ? [...set][0] : null;
}

function parseSnapshot(text) {
	try {
		const v = JSON.parse(text || "{}");
		return v && typeof v === "object" ? v : null;
	} catch {
		return null;
	}
}

// What the report reads about the drivers in world `A` (lifted from server.js):
// the normalized name (norm), the pay structures, the display names, the
// trucks, the month a day pays in (payMonthOfDay) and the rate an invoice pays
// a day at in that world (raterOf). scripts/october-flags-report.js reads its
// invoices through it and invoiceRateDiffs() too.
async function driverIndex({ db, A }) {
	const norm = (n) => A.normalizeDriverName(A.driverNameForTotals(n) || "");
	const structs = A.getDriverPayStructures();
	const isDaily = (k) => (structs[k] || { payType: "fixed" }).payType !== "percentage";

	// Display names: the directory's first row, then the trucks and the sheet.
	const display = new Map();
	const see = (raw) => { const k = norm(raw); if (k && !display.has(k)) display.set(k, String(raw).trim()); };
	for (const r of db.prepare("SELECT driver_name FROM drivers_directory ORDER BY id").all()) see(r.driver_name);
	const trucks = db.prepare("SELECT unit_number, assigned_driver, driver_pay_daily FROM trucks").all();
	for (const t of trucks) see(t.assigned_driver);
	const jt = await A.getJobTrackingCached();
	const cols = A.jobTrackingMonthCols(jt.headers || []);
	for (const r of jt.data || []) if (cols.driverCol) see(r[cols.driverCol]);
	// Each load's Assigned month, by its normalized Load ID (the earliest when a
	// load has several rows).
	const assignedMonthOf = new Map();
	for (const r of jt.data || []) {
		const id = cols.loadIdCol ? A.normalizeLoadId(r[cols.loadIdCol]) : "";
		if (!id) continue;
		const m = A.loadAssignedMonthKey(r, cols);
		assignedMonthOf.set(id, driverRateOnly.payMonthOf("", [assignedMonthOf.get(id), m]));
	}
	// A load with no Assigned Date (or not on the sheet) pays in the day's own month.
	const payMonthOfDay = (day, loadIds) => driverRateOnly.payMonthOf(day, loadIds.map((id) => assignedMonthOf.get(A.normalizeLoadId(id)) || String(day).slice(0, 7)));

	// The rate each pay path hands a driver's day: his own, the last truck naming him.
	const truckOf = (k) => {
		const list = trucks.filter((t) => norm(t.assigned_driver) === k);
		return list.length ? list[list.length - 1] : null;
	};
	const raters = new Map();
	const raterOf = (k) => {
		if (!raters.has(k)) {
			const own = (structs[k] && structs[k].payDaily) || 0;
			const truckRate = A.truckDailyRateCandidates(display.get(k) || k).slice(-1)[0];
			raters.set(k, A.invoiceDayRater({ nameNorm: k, payDaily: own, truckRate, fromMonth: A.TRIP_WORK_DAYS_FROM }));
		}
		return raters.get(k);
	};
	return { norm, structs, isDaily, display, trucks, truckOf, payMonthOfDay, raterOf };
}

// Whether an invoice's week touches a closed month (its correction is then a
// correction draft, else an adjustment).
const weekTouchesClosed = (A, inv) => [String(inv.week_start || "").slice(0, 7), String(inv.week_end || "").slice(0, 7)].some((m) => A.isLocked(m));

// The live invoices of daily-rate drivers, priced the way world `A` would
// price them (index: driverIndex() of A): each issued (not Draft) weekly
// invoice with a paid grid day that pays in `from` or later whose printed
// amount differs from A's rate for that day, the Draft weekly invoices likewise,
// and the Draft manual corrections whose per-day line differs. Returns
// { invoices, drafts, onSomeInvoice } (onSomeInvoice: "<driver>\t<day>" for
// every live weekly invoice's paid grid day).
function invoiceRateDiffs({ db, A, from, index }) {
	const { norm, isDaily, payMonthOfDay, raterOf } = index;
	const live = db.prepare("SELECT * FROM invoices WHERE COALESCE(deleted_at, '') = '' ORDER BY week_start, id").all();
	const gridDaysOf = (inv, snap) => {
		const out = [];
		if (!snap || snap.__templateName !== "service_invoice" || !snap.days || !DAY_RE.test(String(inv.week_start || ""))) return out;
		for (let i = 0; i < 7; i++) {
			const day = addDays(inv.week_start, i);
			const cell = snap.days[A.invoiceGridDayName(day)] || {};
			if (!cell.completed) continue;
			out.push({ day, loads: String(cell.loadBol || "").split(",").map((x) => x.trim()).filter(Boolean), total: Number(cell.total) || 0 });
		}
		return out;
	};
	const onSomeInvoice = new Set();
	const invoices = [];
	const drafts = [];
	for (const inv of live) {
		const k = norm(inv.driver || "");
		if (!k || !isDaily(k)) continue;
		const snap = parseSnapshot(inv.render_data);
		if (!Number(inv.is_manual)) {
			const grid = gridDaysOf(inv, snap);
			for (const g of grid) onSomeInvoice.add(`${k}\t${g.day}`);
			const days = [];
			for (const g of grid) {
				const month = payMonthOfDay(g.day, g.loads);
				if (month < from) continue;
				const ruleRate = raterOf(k)(g.day, month);
				if (cents(ruleRate) !== cents(g.total)) days.push({ day: g.day, month, printed: g.total, rule: ruleRate });
			}
			if (!days.length) continue;
			const row = {
				invoiceNumber: inv.invoice_number, driver: k, status: inv.status, weekStart: inv.week_start, weekEnd: inv.week_end, days,
				printedRate: oneRate(days, "printed"), ruleRate: oneRate(days, "rule"),
				difference: round2(days.reduce((c, d) => c + (cents(d.rule) - cents(d.printed)), 0) / 100),
			};
			if (inv.status === "Draft") drafts.push({ ...row, kind: "weekly", action: "regenerate the Draft once the rule is on" });
			else invoices.push({ ...row, correction: weekTouchesClosed(A, inv) ? "correction draft" : "adjustment" });
			continue;
		}
		if (inv.status !== "Draft" || !snap || !Array.isArray(snap.lineItems)) continue;
		const days = [];
		for (const l of snap.lineItems) {
			const desc = String(l && l.description || "");
			if (!DAY_LINE_RE.test(desc) || !DAY_RE.test(String(l.date || ""))) continue;
			const loads = ((desc.match(/\(loads? ([^)]*)\)\s*$/) || [])[1] || "").split(",").map((x) => x.trim()).filter(Boolean);
			const month = payMonthOfDay(l.date, loads);
			if (month < from) continue;
			const ruleRate = raterOf(k)(l.date, month);
			if (cents(ruleRate) !== cents(l.amount)) days.push({ day: l.date, month, printed: Number(l.amount) || 0, rule: ruleRate });
		}
		if (!days.length) continue;
		drafts.push({
			invoiceNumber: inv.invoice_number, driver: k, status: inv.status, weekStart: inv.week_start, weekEnd: inv.week_end, days,
			printedRate: oneRate(days, "printed"), ruleRate: oneRate(days, "rule"),
			difference: round2(days.reduce((c, d) => c + (cents(d.rule) - cents(d.printed)), 0) / 100),
			kind: "manual", action: "a person checks the line's rate before approving the Draft",
		});
	}
	return { invoices, drafts, onSomeInvoice };
}

async function report({ off, on, from, names }) {
	const { db } = on;
	const A = on.api;
	if (A.DRIVER_RATE_ONLY_FROM !== from) throw new Error(`the rule did not start from ${from} in the lifted server (DRIVER_RATE_ONLY_FROM is ${A.DRIVER_RATE_ONLY_FROM || "unset"})`);
	if (off.api.DRIVER_RATE_ONLY_FROM) throw new Error("the baseline world has the rule on");
	const latestClosed = ledgerDayOnce.latestClosedMonth(db);
	const closedMonths = db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period);
	const index = await driverIndex({ db, A });
	const { structs, isDaily, display, truckOf } = index;

	// drivers
	const drivers = [];
	for (const k of [...display.keys()].sort()) {
		if (!isDaily(k)) continue;
		const own = (structs[k] && structs[k].payDaily) || 0;
		const truck = truckOf(k);
		const truckRate = A.truckDailyRateCandidates(display.get(k)).slice(-1)[0];
		const rateToday = off.api.resolveDailyRate(own, truckRate, from);
		const rateUnderRule = A.resolveDailyRate(own, truckRate, from);
		if (rateToday === rateUnderRule) continue;
		drivers.push({ driver: k, ownRate: own, truck: truck ? truck.unit_number : "", truckRate: truck ? (Number(truck.driver_pay_daily) || 0) : null, rateToday, rateUnderRule });
	}

	// The payout ledger, rule off and on.
	const fleetOff = await off.api.computeFleetLedger();
	const fleetOn = await A.computeFleetLedger();
	const dayItems = (fleet) => {
		const out = new Map();
		for (const s of fleet.scopes) {
			for (const it of s.items) {
				if (it.kind !== "driver_pay" || it.payType !== "fixed" || !it.day) continue;
				out.set(`${s.ownerId}\t${it.driver}\t${it.month}\t${it.day}`, it);
			}
		}
		return out;
	};
	const itemsOff = dayItems(fleetOff);
	const itemsOn = dayItems(fleetOn);
	const months = new Map();
	const changedDays = [];
	for (const [key, it] of itemsOn) {
		const [ownerId, driver, month, day] = key.split("\t");
		if (month < from) continue;
		const was = itemsOff.get(key);
		const k = `${ownerId}\t${driver}\t${month}`;
		if (!months.has(k)) months.set(k, { ownerId: Number(ownerId), driver, month, days: 0, nowCents: 0, ruleCents: 0 });
		const m = months.get(k);
		m.days++;
		m.nowCents += was ? was.cents : 0;
		m.ruleCents += it.cents;
		if (!was || was.cents !== it.cents) changedDays.push({ ownerId: Number(ownerId), driver, month, day, loadId: it.loadId || "", payNow: was ? was.cents / 100 : 0, payUnderRule: it.cents / 100 });
	}
	const driverMonths = [...months.values()].filter((m) => m.nowCents !== m.ruleCents)
		.map((m) => ({ ownerId: m.ownerId, driver: m.driver, month: m.month, days: m.days, payNow: m.nowCents / 100, payUnderRule: m.ruleCents / 100, difference: (m.ruleCents - m.nowCents) / 100 }))
		.sort((p, q) => p.ownerId - q.ownerId || p.driver.localeCompare(q.driver) || p.month.localeCompare(q.month));

	// Investor payables, rule off and on (the loss carried forward included).
	const investorMonths = [];
	const carrierOn = A.getCarrierDBFromSQLite();
	const driverCol = A.findCol(carrierOn.headers, /driver/i) || carrierOn.headers[0];
	const carrierCol = A.findCol(carrierOn.headers, /carrier/i);
	const globalConfig = {};
	db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all().forEach((r) => { globalConfig[r.key] = r.value; });
	const payables = async (api, inv) => {
		const config = { ...globalConfig };
		db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(inv.ownerId).forEach((r) => { config[r.key] = r.value; });
		const investorDriverSet = api.getInvestorDriverSet(inv.ownerId, carrierOn.data, driverCol, carrierCol);
		const { monthlyEarnings } = await api.computeInvestorMonthlyEarnings({ user: { id: inv.ownerId }, isSuperAdmin: false, investorDriverSet, investorOwnerId: inv.ownerId, config });
		const carry = api.computeLossCarryForward(monthlyEarnings);
		return Object.fromEntries(monthlyEarnings.map((m) => [m.month, { payable: carry[m.month].payable, driverPay: (m.exact && m.exact.driverPay) ?? m.driverPay ?? 0 }]));
	};
	for (const inv of A.listSettlableInvestors()) {
		const now = await payables(off.api, inv);
		const rule = await payables(A, inv);
		for (const month of [...new Set([...Object.keys(now), ...Object.keys(rule)])].sort()) {
			if (month < from) continue;
			const a = now[month] || { payable: 0, driverPay: 0 };
			const b = rule[month] || { payable: 0, driverPay: 0 };
			const delta = round2(b.payable - a.payable);
			const driverPayChange = round2(b.driverPay - a.driverPay);
			if (!delta && !driverPayChange) continue;
			investorMonths.push({ ownerId: inv.ownerId, investor: inv.name, period: month, current: a.payable, withRule: b.payable, delta, driverPayChange });
		}
	}

	// Invoices: each paid grid day that pays in FROM or later, printed vs the rule.
	const { invoices, drafts, onSomeInvoice } = invoiceRateDiffs({ db, A, from, index });
	const ledgerDaysOnNoInvoice = changedDays.filter((d) => !onSomeInvoice.has(`${d.driver}\t${d.day}`))
		.sort((p, q) => p.driver.localeCompare(q.driver) || p.day.localeCompare(q.day));

	// Dated-history gaps: days from FROM's first day to today whose dated own
	// rate reads $0 while the driver has a rate of his own now.
	const historyGaps = [];
	const rates = A.loadPayRateIndex();
	const today = A.appDay(new Date());
	for (const k of [...display.keys()].sort()) {
		const own = (structs[k] && structs[k].payDaily) || 0;
		if (!isDaily(k) || !(own > 0)) continue;
		let run = null;
		for (let day = `${from}-01`; day <= today; day = addDays(day, 1)) {
			if (rates.at("driver", k, day) === 0) {
				if (run) run.to = day;
				else run = { driver: k, from: day, to: day };
			} else if (run) {
				historyGaps.push(run);
				run = null;
			}
		}
		if (run) historyGaps.push(run);
	}

	// Closed months and months before FROM: identical with the rule off and on.
	const problems = [];
	const scopeMonths = (fleet) => new Map(fleet.scopes.map((s) => [s.ownerId, { months: new Map(s.months.map((m) => [m.month, m])), items: s.items }]));
	const offScopes = scopeMonths(fleetOff);
	const onScopes = scopeMonths(fleetOn);
	const guarded = (m) => A.isLocked(m) || m < from;
	for (const ownerId of new Set([...offScopes.keys(), ...onScopes.keys()])) {
		const a = offScopes.get(ownerId) || { months: new Map(), items: [] };
		const b = onScopes.get(ownerId) || { months: new Map(), items: [] };
		for (const m of new Set([...a.months.keys(), ...b.months.keys()])) {
			if (!guarded(m)) continue;
			const same = JSON.stringify(a.months.get(m) || null) === JSON.stringify(b.months.get(m) || null)
				&& JSON.stringify(a.items.filter((i) => i.month === m)) === JSON.stringify(b.items.filter((i) => i.month === m));
			if (!same) problems.push({ ownerId, month: m, closed: A.isLocked(m), issue: `${m} would change with the rule on` });
		}
	}
	const fingerprint = Object.fromEntries(FINGERPRINTED.map((t) => [t, closedRowsHash(db, t, closedMonths)]));

	// Names, or numbers.
	const labels = new Map();
	const label = (k) => { if (!labels.has(k)) labels.set(k, `driver ${labels.size + 1}`); return labels.get(k); };
	const named = (list) => list.map((r) => ({ ...r, driver: names ? (display.get(r.driver) || r.driver) : label(r.driver) }));
	const investorsNamed = investorMonths.map((r) => (names ? r : { ...r, investor: `owner ${r.ownerId}` }));
	return {
		from, latestClosedMonth: latestClosed, closedMonths,
		baseline: "DRIVER_RATE_ONLY off; every other setting as the server has it",
		drivers: named(drivers), driverMonths: named(driverMonths), investorMonths: investorsNamed,
		invoices: named(invoices), drafts: named(drafts), ledgerDaysOnNoInvoice: named(ledgerDaysOnNoInvoice), historyGaps: named(historyGaps),
		closedMonthsUnchanged: !problems.some((p) => p.closed),
		monthsBeforeFromUnchanged: !problems.some((p) => !p.closed),
		closedMonthsFingerprint: fingerprint,
		problems,
		summary: {
			driversChanged: drivers.length,
			driverPayChange: round2(driverMonths.reduce((c, m) => c + m.difference, 0)),
			investorPayableChange: round2(investorMonths.reduce((c, m) => c + m.delta, 0)),
			issuedInvoicesToCorrect: invoices.length,
			issuedInvoiceDifference: round2(invoices.reduce((c, i) => c + i.difference, 0)),
			drafts: drafts.length,
			ledgerDaysOnNoInvoice: ledgerDaysOnNoInvoice.length,
			historyGaps: historyGaps.length,
		},
		generatedAt: new Date().toISOString(),
	};
}

function printText(r) {
	const s = r.summary;
	const lines = [];
	lines.push(`Daily-rate rule report: DRIVER_RATE_ONLY_FROM=${r.from} (latest closed month: ${r.latestClosedMonth || "none"}). Nothing was written.`);
	lines.push(`Drivers whose rate changes: ${s.driversChanged}. Ledger driver pay ${usd(s.driverPayChange)}; investor payable ${usd(s.investorPayableChange)}.`);
	lines.push(`Issued invoices to correct: ${s.issuedInvoicesToCorrect} (${usd(s.issuedInvoiceDifference)}). Drafts: ${s.drafts}. Ledger days on no invoice: ${s.ledgerDaysOnNoInvoice}. History gaps: ${s.historyGaps}.`);
	lines.push("", "Drivers (own rate, truck and its rate, rate today -> under the rule):");
	for (const d of r.drivers) lines.push(`  ${d.driver}  own ${usd(d.ownRate)}  ${d.truck || "(no truck)"} ${d.truckRate == null ? "" : usd(d.truckRate)}  ${usd(d.rateToday)} -> ${usd(d.rateUnderRule)}`);
	lines.push("", "Payout ledger by scope, driver and month (days, now -> under the rule):");
	for (const m of r.driverMonths) lines.push(`  owner ${m.ownerId}  ${m.driver}  ${m.month}  ${m.days} day(s)  ${usd(m.payNow)} -> ${usd(m.payUnderRule)}  (${usd(m.difference)})`);
	lines.push("", "Investor payable by month (now -> under the rule):");
	for (const i of r.investorMonths) lines.push(`  owner ${i.ownerId} (${i.investor})  ${i.period}  ${usd(i.current)} -> ${usd(i.withRule)}  (${usd(i.delta)}; driver pay ${usd(i.driverPayChange)})`);
	lines.push("", "Issued invoices whose printed rate differs (number, status, week, days, printed -> rule, difference, correction):");
	for (const i of r.invoices) lines.push(`  ${i.invoiceNumber}  ${i.status}  ${i.weekStart}  ${i.driver}  [${i.days.map((d) => `${d.day} ${usd(d.printed)} -> ${usd(d.rule)}`).join(", ")}]  ${usd(i.difference)}  ${i.correction}`);
	lines.push("", "Drafts (number, kind, days, printed -> rule, what to do):");
	for (const i of r.drafts) lines.push(`  ${i.invoiceNumber}  ${i.kind}  ${i.driver}  [${i.days.map((d) => `${d.day} ${usd(d.printed)} -> ${usd(d.rule)}`).join(", ")}]  ${usd(i.difference)}  ${i.action}`);
	lines.push("", "Ledger days whose pay changes and that no live weekly invoice carries:");
	for (const d of r.ledgerDaysOnNoInvoice) lines.push(`  owner ${d.ownerId}  ${d.driver}  ${d.month}  ${d.day}  load ${d.loadId || "(added day)"}  ${usd(d.payNow)} -> ${usd(d.payUnderRule)}`);
	lines.push("", "Dated-history gaps (driver, first and last day the dated rate reads $0):");
	for (const g of r.historyGaps) lines.push(`  ${g.driver}  ${g.from} to ${g.to}`);
	lines.push("", `Closed months unchanged: ${r.closedMonthsUnchanged ? "yes" : "NO"}. Months before FROM unchanged: ${r.monthsBeforeFromUnchanged ? "yes" : "NO"}.`);
	lines.push(`Closed months' frozen rows: ${Object.entries(r.closedMonthsFingerprint).map(([t, f]) => `${t} ${f.rows} row(s) ${f.sha256.slice(0, 16)}`).join("; ")}.`);
	for (const p of r.problems) lines.push(`PROBLEM: owner ${p.ownerId}: ${p.issue}`);
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const from = typeof args.from === "string" ? args.from.trim() : "";
	if (!driverRateOnly.FROM_MONTH_RE.test(from)) refuse("--from=YYYY-MM is required: the DRIVER_RATE_ONLY_FROM to try");
	if (!args.db || args.db === true) refuse("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	try {
		dbFile = envFor({ root: ROOT, dbPath: args.db, envFile }).file;
	} catch (err) {
		refuse(err.message);
	}
	const latestClosed = latestClosedOf(dbFile);
	if (latestClosed && from <= latestClosed) {
		refuse(`--from=${from} is at or before ${latestClosed}, the latest closed month. The rule may only start in an open month: closed months are final as recorded.`);
	}
	const sheetData = await sheetFor(args, ROOT);
	const world = (envOverrides) => buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, envOverrides, extraRoots: EXTRA_ROOTS });
	const off = world({ DRIVER_RATE_ONLY_ENABLED: "false" });
	const on = world({ DRIVER_RATE_ONLY_ENABLED: "true", DRIVER_RATE_ONLY_FROM: from });
	try {
		const result = await report({ off, on, from, names: args.names === true });
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
		if (!result.closedMonthsUnchanged || !result.monthsBeforeFromUnchanged) process.exitCode = 1;
	} finally {
		off.db.close();
		on.db.close();
	}
}

// scripts/october-flags-report.js reuses the invoice pricing and the closed
// months' fingerprint.
module.exports = { EXTRA_ROOTS, FINGERPRINTED, driverIndex, invoiceRateDiffs, weekTouchesClosed, closedRowsHash };

if (require.main === module) main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
