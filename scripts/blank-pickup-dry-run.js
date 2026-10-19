#!/usr/bin/env node
// scripts/blank-pickup-dry-run.js — what the two blank-appointment fallbacks
// (money plan D, lib/load-pay-days.js payWindow()) would change, run on the
// server with no login before either flag goes on. Read-only: it opens app.db
// with a read-only handle, reads Job Tracking with the read-only scope (or a
// saved values.get), and writes nothing anywhere.
//
// It lifts this checkout's server.js (scripts/lib/ledger-world.js) and runs the
// server's own code with each fallback off (today) and on from its FROM, every
// other setting as the app's .env has it. Two sections, so the two flags are
// approved separately:
//   invoice  (--invoice-from, INVOICE_BLANK_PICKUP_FALLBACK_*, driver pay): every
//            completed load with a blank or non-date Pickup Appointment whose
//            Assigned month is FROM or later, and each driver-week such a load is
//            billed in: the days and the amount the weekly invoice pays now and
//            with the flag (invoiceWeekPaidDays() and invoiceDayPricing(), the
//            code generate runs), the live invoice for that week if any, and what
//            happens once the flag is on (a Draft is regenerated; an issued
//            invoice is not, so the days it would add are listed for a person);
//   ledger   (--ledger-from, LEDGER_BLANK_DROPOFF_FALLBACK_*, payouts): each
//            driver-day the payout ledger pays differently (computeFleetLedger(),
//            every scope), per scope, driver and month, and per investor and
//            month the payable now and with the flag (the loss carried forward
//            included; computeInvestorMonthlyEarnings() and
//            computeLossCarryForward(), as the server settles).
// Then every closed month and every month before each FROM checked identical
// with and without the flag (if not, the run exits 1 after printing).
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/blank-pickup-dry-run.js --db=app.db --sheet-id=<id> --invoice-from=YYYY-MM --ledger-from=YYYY-MM [--key=service-account-key.json] [--names] [--json]
//   --invoice-from=YYYY-MM  the INVOICE_BLANK_PICKUP_FALLBACK_FROM to try
//   --ledger-from=YYYY-MM   the LEDGER_BLANK_DROPOFF_FALLBACK_FROM to try
//                           (at least one; each refused unless it is after the
//                           latest closed month)
//   --sheet-id=env          the SPREADSHEET_ID the .env sets (refused when none)
//   --values-json=<file>    a saved values.get of Job Tracking, in place of --sheet-id
//   --env-file=<file>       with a copy of the database under the temp directory only
//   --names                 name drivers and investors (default: "driver 1", …,
//                           numbered per run, and investors by owner id)
//   --json                  print the whole result as JSON (default: a text report)
//   --dry-run               accepted; the run is always read-only
// Exit codes: 0 done, 1 error or a closed month or a month before FROM would
// change, 2 refused (a FROM that is not a month or is closed, a missing input, or
// the flag already on in the app's .env, so "today" would already include it).

"use strict";

const path = require("path");
const { createRequire } = require("module");
const { buildLedgerWorld, parseArgs, sheetFor, envFor } = require("./lib/ledger-world");
const loadPayDays = require("../lib/load-pay-days");
const ledgerDayOnce = require("../lib/ledger-day-once");

const ROOT = path.join(__dirname, "..");
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FIGURES = ["revenue", "driverPay", "fixedCosts", "tripExpenses", "maintFundCost", "complianceCost"];
const round2 = (x) => Math.round(x * 100) / 100;
const usd = (x) => (x === null ? "n/a" : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);

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

// The server functions this script runs, lifted from server.js with their closure.
const EXTRA_ROOTS = [
	"payoutRules", "jobTrackingRowsOf", "invoiceWeekColumns", "invoiceWeekVerdict", "invoiceCompletionDay", "selectInvoiceWeekLoads",
	"getWeekRange", "parseInvoiceDate", "jobTrackingMonthCols", "loadAssignedMonthKey", "invoiceWeekPaidDays", "invoiceDayPricing",
	"liveWeeklyInvoicesForDriverWeek", "invoicePaidDaysOf", "getDriverPayStructures", "truckDailyRateCandidates", "resolveDailyRate",
	"normalizeDriverName", "loadKeySet", "getDeletedLoadIds", "tripDayResolver", "invoiceExtraRuleLoads",
];

// Section 1: the weekly invoice, the blank-pickup fallback off and on from `from`.
function invoiceSection(api, sheetValues, from, problems) {
	const { headers, data } = api.jobTrackingRowsOf(sheetValues);
	const cols = api.invoiceWeekColumns(headers);
	const monthCols = api.jobTrackingMonthCols(headers);
	const deletedKeys = api.loadKeySet(api.getDeletedLoadIds());
	// The driver-weeks that bill a completed, live load with no pickup date whose
	// Assigned month is FROM or later. Which of their loads the fallback starts at
	// the Assigned Date is invoiceWeekPaidDays()'s answer below (the week's billed
	// row of each load), not this scan's.
	const weeks = new Map();
	for (const row of data) {
		// Completed, live and dated: billed in exactly one week.
		if (api.invoiceWeekVerdict(row, cols, "", "", deletedKeys) !== "other-week") continue;
		if (cols.pickupCol && api.parseInvoiceDate(row[cols.pickupCol])) continue;
		const month = api.loadAssignedMonthKey(row, monthCols);
		if (!month || month < from) continue;
		const display = cols.driverCol ? String(row[cols.driverCol] || "").trim() : "";
		const nameNorm = api.normalizeDriverName(display);
		if (!nameNorm) continue;
		const { weekStart, weekEnd } = api.getWeekRange(api.invoiceCompletionDay(row, cols));
		const key = `${nameNorm}\t${weekStart}`;
		if (!weeks.has(key)) weeks.set(key, { nameNorm, display, weekStart, weekEnd });
	}
	const loads = [];
	const payStructs = api.getDriverPayStructures();
	const tripRule = api.tripDayResolver();
	const out = [];
	for (const w of weeks.values()) {
		const week = api.selectInvoiceWeekLoads(data, headers, w.display, w.weekStart, w.weekEnd, deletedKeys);
		const payStruct = payStructs[w.nameNorm] || { payType: "fixed", payPercentage: 0 };
		const percentage = payStruct.payType === "percentage";
		const weekRule = tripRule && !percentage ? tripRule : null;
		const extraRuleLoads = weekRule
			? api.invoiceExtraRuleLoads({ data, headers, driverName: w.display, billed: week.loads, weekStart: w.weekStart, weekEnd: w.weekEnd, resolver: weekRule, deletedKeys })
			: [];
		const args = { headers, cols: week.cols, loads: week.loads, extraRuleLoads, weekRule, weekStart: w.weekStart, weekEnd: w.weekEnd, nameNorm: w.nameNorm };
		const now = api.invoiceWeekPaidDays({ ...args, blankPickupFrom: null });
		const withFlag = api.invoiceWeekPaidDays({ ...args, blankPickupFrom: from });
		for (const loadId of withFlag.blankPickupLoads) loads.push({ loadId, driver: w.nameNorm, weekStart: w.weekStart });
		// Priced as generate prices them: a percentage driver's total reads revenue,
		// not days, so it does not move.
		const truckRate = api.truckDailyRateCandidates(w.display).slice(-1)[0];
		const dailyRate = api.resolveDailyRate(payStruct.payDaily, truckRate, w.weekEnd.slice(0, 7));
		const price = (r) => (percentage ? null
			: api.invoiceDayPricing({ dailyRate, nameNorm: w.nameNorm, payDaily: payStruct.payDaily, truckRate, weekRule, dayPayMonth: r.dayPayMonth }).totalOf(r.activeDaySet));
		const daysNow = [...now.activeDaySet].sort();
		const daysWith = [...withFlag.activeDaySet].sort();
		const addedDays = daysWith.filter((d) => !now.activeDaySet.has(d));
		const removedDays = daysNow.filter((d) => !withFlag.activeDaySet.has(d));
		for (const d of [...addedDays, ...removedDays]) {
			if (api.isLocked(d.slice(0, 7))) problems.push({ section: "invoice", issue: `${d}, in closed month ${d.slice(0, 7)}, would change on a weekly invoice`, closed: true });
			if (d.slice(0, 7) < from) problems.push({ section: "invoice", issue: `${d}, before FROM, would change on a weekly invoice`, beforeFrom: true });
		}
		const amountNow = price(now);
		const amountWith = price(withFlag);
		const live = api.liveWeeklyInvoicesForDriverWeek(w.display, w.weekStart);
		const inv = live.length === 1 ? live[0] : null;
		const afterSwitchOn = !addedDays.length && !removedDays.length ? "nothing changes"
			: live.length > 1 ? `${live.length} live invoices for this week: a person decides`
				: !inv ? "no invoice yet: the week's invoice pays these days when it is generated"
					: inv.status === "Draft" ? "Draft: regenerating it pays these days"
						: `issued (${inv.status}): generate refuses a settled week, so these days stay unpaid until a person adds them`;
		out.push({
			driver: w.nameNorm, weekStart: w.weekStart, weekEnd: w.weekEnd, loadIds: withFlag.blankPickupLoads, payType: percentage ? "percentage" : "fixed",
			daysNow, daysWithFlag: daysWith, addedDays, removedDays,
			amountNow, amountWithFlag: amountWith, delta: amountNow === null ? null : round2(amountWith - amountNow),
			invoice: inv ? { invoiceNumber: inv.invoice_number, status: inv.status, totalEarnings: Number(inv.total_earnings) || 0, paidDays: api.invoicePaidDaysOf(inv) } : null,
			afterSwitchOn,
		});
	}
	out.sort((p, q) => p.driver.localeCompare(q.driver) || p.weekStart.localeCompare(q.weekStart));
	loads.sort((p, q) => p.driver.localeCompare(q.driver) || p.weekStart.localeCompare(q.weekStart) || p.loadId.localeCompare(q.loadId));
	const changed = out.filter((w) => w.addedDays.length || w.removedDays.length);
	const issued = changed.filter((w) => w.invoice && w.invoice.status !== "Draft");
	return {
		from, loads, weeks: out,
		summary: {
			loads: loads.length,
			weeksChanged: changed.length,
			daysAdded: changed.reduce((c, w) => c + w.addedDays.length, 0),
			daysRemoved: changed.reduce((c, w) => c + w.removedDays.length, 0),
			amountChange: round2(changed.reduce((c, w) => c + (w.delta || 0), 0)),
			issuedWeeks: issued.length,
			issuedAmountNotPaid: round2(issued.reduce((c, w) => c + (w.delta || 0), 0)),
		},
	};
}

// Section 2: the payout ledger, the blank drop-off fallback off and on from `from`.
async function ledgerSection(api, from, names, problems) {
	const base = api.payoutRules();
	const offRules = { ...base, blankDropoffFrom: null };
	const onRules = { ...base, blankDropoffFrom: from };
	const off = await api.computeFleetLedger({ rules: offRules });
	const on = await api.computeFleetLedger({ rules: onRules });
	const perDay = [];
	const driverMonths = new Map();
	const onByOwner = new Map(on.scopes.map((s) => [s.ownerId, s]));
	for (const scope of off.scopes) {
		const next = onByOwner.get(scope.ownerId) || { items: [], months: [] };
		// A fixed-rate driver's pay is one item per day; a percentage driver's one
		// per month, carrying its day count.
		const keyed = (items) => new Map(items.filter((i) => i.kind === "driver_pay").map((i) => [`${i.driver}\t${i.month}\t${i.day || ""}`, i]));
		const a = keyed(scope.items);
		const b = keyed(next.items);
		const note = (was, is) => {
			const it = is || was;
			const daysChange = it.day ? (is ? 1 : 0) - (was ? 1 : 0) : ((is && is.days) || 0) - ((was && was.days) || 0);
			const payChange = ((is && is.cents) || 0) - ((was && was.cents) || 0);
			if (!daysChange && !payChange) return;
			if (it.month < from) problems.push({ section: "ledger", ownerId: scope.ownerId, issue: `${it.month}, a month before FROM, would change`, beforeFrom: true });
			if (it.day && daysChange) perDay.push({ ownerId: scope.ownerId, driver: it.driver, month: it.month, day: it.day, change: is ? "added" : "removed", loadId: it.loadId || "", amount: payChange / 100 });
			const mk = `${scope.ownerId}\t${it.driver}\t${it.month}`;
			const row = driverMonths.get(mk) || { ownerId: scope.ownerId, driver: it.driver, month: it.month, payType: it.payType || "fixed", daysChange: 0, driverPayChange: 0 };
			row.daysChange += daysChange;
			row.driverPayChange = round2(row.driverPayChange + payChange / 100);
			driverMonths.set(mk, row);
		};
		for (const [k, it] of a) note(it, b.get(k) || null);
		for (const [k, it] of b) if (!a.has(k)) note(null, it);
		const monthsOf = (ms) => new Map(ms.map((m) => [m.month, m]));
		const x = monthsOf(scope.months);
		const y = monthsOf(next.months);
		for (const mk of new Set([...x.keys(), ...y.keys()])) {
			const moved = FIGURES.filter((f) => Math.round(((x.get(mk) || {})[f] || 0) * 100) !== Math.round(((y.get(mk) || {})[f] || 0) * 100));
			if (!moved.length) continue;
			if (api.isLocked(mk)) problems.push({ section: "ledger", ownerId: scope.ownerId, issue: `closed month ${mk} changed: ${moved.join(", ")}`, closed: true });
			else if (mk < from) problems.push({ section: "ledger", ownerId: scope.ownerId, issue: `${mk}, a month before FROM, changed: ${moved.join(", ")}`, beforeFrom: true });
		}
	}
	perDay.sort((p, q) => p.ownerId - q.ownerId || p.driver.localeCompare(q.driver) || p.day.localeCompare(q.day));
	// The loads behind the added days.
	const byLoad = new Map();
	for (const d of perDay) {
		const k = `${d.ownerId}\t${d.loadId}`;
		const row = byLoad.get(k) || { ownerId: d.ownerId, loadId: d.loadId, driver: d.driver, month: d.month, days: [], amount: 0 };
		row.days.push(d.day);
		row.amount = round2(row.amount + d.amount);
		byLoad.set(k, row);
	}

	// Each investor's payable, off and on.
	const carrierDB = api.getCarrierDBFromSQLite();
	const driverCol = api.findCol(carrierDB.headers, /driver/i) || carrierDB.headers[0];
	const carrierCol = api.findCol(carrierDB.headers, /carrier/i);
	const globalConfig = {};
	api.db.prepare("SELECT key, value FROM investor_config WHERE owner_id = 0").all().forEach((r) => { globalConfig[r.key] = r.value; });
	const investorMonths = [];
	for (const inv of api.listSettlableInvestors()) {
		const config = { ...globalConfig };
		api.db.prepare("SELECT key, value FROM investor_config WHERE owner_id = ?").all(inv.ownerId).forEach((r) => { config[r.key] = r.value; });
		const investorDriverSet = api.getInvestorDriverSet(inv.ownerId, carrierDB.data, driverCol, carrierCol);
		const payable = async (rules) => {
			const { monthlyEarnings } = await api.computeInvestorMonthlyEarnings({ user: { id: inv.ownerId }, isSuperAdmin: false, investorDriverSet, investorOwnerId: inv.ownerId, config, rules });
			const carry = api.computeLossCarryForward(monthlyEarnings);
			return new Map(monthlyEarnings.map((m) => [m.month, { payable: carry[m.month].payable, driverPay: m.exact.driverPay }]));
		};
		const was = await payable(offRules);
		const is = await payable(onRules);
		for (const period of [...new Set([...was.keys(), ...is.keys()])].sort()) {
			const p = was.get(period) || { payable: 0, driverPay: 0 };
			const q = is.get(period) || { payable: 0, driverPay: 0 };
			const delta = round2(q.payable - p.payable);
			const driverPayChange = round2(q.driverPay - p.driverPay);
			if (!delta && !driverPayChange) continue;
			if (api.isLocked(period)) { problems.push({ section: "ledger", ownerId: inv.ownerId, issue: `closed month ${period} changed its payable or driver pay`, closed: true }); continue; }
			if (period < from) problems.push({ section: "ledger", ownerId: inv.ownerId, issue: `${period}, a month before FROM, changed its payable or driver pay`, beforeFrom: true });
			investorMonths.push({ ownerId: inv.ownerId, ...(names ? { investor: inv.name } : {}), period, current: round2(p.payable), withFlag: round2(q.payable), delta, driverPayChange });
		}
	}
	const months = [...driverMonths.values()].sort((p, q) => p.ownerId - q.ownerId || p.driver.localeCompare(q.driver) || p.month.localeCompare(q.month));
	return {
		from, perDay, loads: [...byLoad.values()], driverMonths: months, investorMonths,
		summary: {
			loads: byLoad.size,
			daysAdded: perDay.filter((d) => d.change === "added").length,
			daysRemoved: perDay.filter((d) => d.change === "removed").length,
			driverPayChange: round2(months.reduce((c, m) => c + m.driverPayChange, 0)),
			investorPayableChange: round2(investorMonths.reduce((c, m) => c + m.delta, 0)),
		},
	};
}

// Drivers as numbered labels unless --names (one numbering across both sections).
function labelDrivers(result, displayOf, names) {
	const labels = new Map();
	const label = (n) => {
		if (names) return displayOf.get(n) || n;
		if (!labels.has(n)) labels.set(n, `driver ${labels.size + 1}`);
		return labels.get(n);
	};
	const relabel = (list) => list.map((r) => ({ ...r, driver: label(r.driver) }));
	if (result.invoice) Object.assign(result.invoice, { loads: relabel(result.invoice.loads), weeks: relabel(result.invoice.weeks) });
	if (result.ledger) Object.assign(result.ledger, { perDay: relabel(result.ledger.perDay), loads: relabel(result.ledger.loads), driverMonths: relabel(result.ledger.driverMonths) });
}

function printText(r) {
	const lines = [];
	lines.push(`Blank-appointment dry run (latest closed month: ${r.latestClosedMonth || "none"}). Nothing was written.`);
	lines.push(`Baseline: ${r.baseline}`);
	if (r.invoice) {
		const s = r.invoice.summary;
		lines.push("", `1. DRIVER PAY: INVOICE_BLANK_PICKUP_FALLBACK_FROM=${r.invoice.from}`);
		lines.push(`Loads the invoice would start at the Assigned Date (blank or non-date pickup, Assigned ${r.invoice.from} or later): ${s.loads}. Weeks that change: ${s.weeksChanged} (+${s.daysAdded} / -${s.daysRemoved} days, ${usd(s.amountChange)}).`);
		lines.push(`Of those, issued invoices (not regenerated; a person adds the days): ${s.issuedWeeks} (${usd(s.issuedAmountNotPaid)}).`);
		lines.push("Weeks (driver, week, loads, days now -> with the flag, $ now -> with, invoice, once on):");
		for (const w of r.invoice.weeks) {
			lines.push(`  ${w.driver}  ${w.weekStart}..${w.weekEnd}  ${w.loadIds.join(", ")}  ${w.daysNow.length} -> ${w.daysWithFlag.length} (+[${w.addedDays.join(", ")}])  ${usd(w.amountNow)} -> ${usd(w.amountWithFlag)}  ${w.invoice ? `${w.invoice.invoiceNumber} ${w.invoice.status}` : "(no invoice)"}  ${w.afterSwitchOn}`);
		}
	}
	if (r.ledger) {
		const s = r.ledger.summary;
		lines.push("", `2. PAYOUTS: LEDGER_BLANK_DROPOFF_FALLBACK_FROM=${r.ledger.from}`);
		lines.push(`Loads whose ledger days change: ${s.loads}. Ledger driver-days +${s.daysAdded} / -${s.daysRemoved}; driver pay ${usd(s.driverPayChange)}; investor payable ${usd(s.investorPayableChange)}.`);
		lines.push("Driver pay by scope, driver and month:");
		for (const m of r.ledger.driverMonths) lines.push(`  owner ${m.ownerId}  ${m.driver}  ${m.month}  ${m.daysChange > 0 ? "+" : ""}${m.daysChange} day(s)  ${usd(m.driverPayChange)}`);
		lines.push("Investor payable by month:");
		for (const i of r.ledger.investorMonths) lines.push(`  owner ${i.ownerId}${i.investor ? ` (${i.investor})` : ""}  ${i.period}  ${usd(i.current)} -> ${usd(i.withFlag)}  (${usd(i.delta)}; driver pay ${usd(i.driverPayChange)})`);
	}
	lines.push("", `Closed months (${r.closedMonths.join(", ") || "none"}) unchanged: ${r.closedMonthsUnchanged ? "yes" : "NO"}. Months before FROM unchanged: ${r.monthsBeforeFromUnchanged ? "yes" : "NO"}.`);
	for (const p of r.problems) lines.push(`PROBLEM (${p.section}${p.ownerId !== undefined ? `, owner ${p.ownerId}` : ""}): ${p.issue}`);
	console.log(lines.join("\n"));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const pick = (k) => (typeof args[k] === "string" ? args[k].trim() : "");
	const invoiceFrom = pick("invoice-from");
	const ledgerFrom = pick("ledger-from");
	if (!invoiceFrom && !ledgerFrom) refuse("--invoice-from=YYYY-MM and/or --ledger-from=YYYY-MM is required: the FROM month(s) to try");
	for (const [flag, v] of [["--invoice-from", invoiceFrom], ["--ledger-from", ledgerFrom]]) {
		if (v && !MONTH_RE.test(v)) refuse(`${flag} must be a month (YYYY-MM)`);
	}
	if (!args.db || args.db === true) refuse("--db is required");
	const envFile = typeof args["env-file"] === "string" ? args["env-file"] : null;
	let dbFile;
	let env;
	try {
		({ file: dbFile, env } = envFor({ root: ROOT, dbPath: args.db, envFile }));
	} catch (err) {
		refuse(err.message);
	}
	// "Today" must be each flag off, so the comparison is today against the flag.
	if (invoiceFrom && loadPayDays.blankFallbackFromEnv(env, "pickup")) refuse("INVOICE_BLANK_PICKUP_FALLBACK is already on in the app's .env, so today already includes it");
	if (ledgerFrom && loadPayDays.blankFallbackFromEnv(env, "dropoff")) refuse("LEDGER_BLANK_DROPOFF_FALLBACK is already on in the app's .env, so today already includes it");
	const latestClosed = latestClosedOf(dbFile);
	for (const [flag, v] of [["--invoice-from", invoiceFrom], ["--ledger-from", ledgerFrom]]) {
		if (v && latestClosed && v <= latestClosed) {
			refuse(`${flag}=${v} is at or before ${latestClosed}, the latest closed month. A fallback may only start in an open month: closed months are final as recorded.`);
		}
	}
	let sheetData;
	try {
		sheetData = await sheetFor(args, ROOT);
	} catch (err) {
		refuse(err.message);
	}
	const world = buildLedgerWorld({ root: ROOT, dbPath: args.db, readonly: true, sheetData, envFile, extraRoots: EXTRA_ROOTS });
	try {
		const api = { ...world.api, db: world.db };
		const problems = [];
		const result = {
			latestClosedMonth: latestClosed,
			closedMonths: world.db.prepare("SELECT period FROM period_locks WHERE status = 'locked' ORDER BY period").all().map((r) => r.period),
			baseline: "both blank-appointment fallbacks off; every other setting as the app's .env has it",
			invoice: invoiceFrom ? invoiceSection(api, sheetData.values || [], invoiceFrom, problems) : null,
			ledger: ledgerFrom ? await ledgerSection(api, ledgerFrom, args.names === true, problems) : null,
		};
		const { headers, data } = api.jobTrackingRowsOf(sheetData.values || []);
		const driverCol = api.invoiceWeekColumns(headers).driverCol;
		const displayOf = new Map();
		for (const row of data) {
			const display = driverCol ? String(row[driverCol] || "").trim() : "";
			const n = api.normalizeDriverName(display);
			if (n && !displayOf.has(n)) displayOf.set(n, display);
		}
		labelDrivers(result, displayOf, args.names === true);
		result.closedMonthsUnchanged = !problems.some((p) => p.closed);
		result.monthsBeforeFromUnchanged = !problems.some((p) => p.beforeFrom);
		result.problems = problems;
		result.generatedAt = new Date().toISOString();
		if (args.json === true) console.log(JSON.stringify(result, null, 1));
		else printText(result);
		if (problems.length) process.exitCode = 1;
	} finally {
		world.db.close();
	}
}

main().catch((err) => { console.error(`ERROR: ${err.stack || err.message}`); process.exit(1); });
