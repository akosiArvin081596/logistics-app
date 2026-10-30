"use strict";
// The Financials overview: one period of the books on one page (the fleet,
// every truck and every driver) and the checks that they agree to the cent.
//
// It adds no money math. Every figure is a buildFinancialsReport() figure
// (lib/financials-report.js, what Fleet P&L shows, cost settings applied). This
// module picks them, adds the sums the page shows (each from the lines counted
// under the settings), and checks the tables against each other and against the
// books' own items, in integer cents:
//   (a) the truck rows, catch-alls included, add up to the fleet: revenue, every
//       line, every counted line, total costs and margin;
//   (b) the same for the driver rows;
//   (c) each whole month: the month's items, summed by line without placement,
//       equal the fleet's lines for that month (a part month has no definition
//       but placement, so it is not checked);
//   (d) each whole month: the lines, mapped to the payout ledger's figures,
//       equal monthFiguresFromItems(); a frozen month also equals the summary
//       its freeze recorded (a closed month never frozen has none: skipped).
// A difference fails the check (ok: false), except (d) in a closed month: a
// closed month is shown as settled and never changed, so it is a note.
//
// Units: report figures (costs, countedCosts, totals) are dollars carrying exact
// cents; every sum here is taken in integer cents, never as floats. A line's
// lineState says how its months were switched, not how much of it counted:
// countedCosts says that.
//
// Pure: no database, network or file access.

const financialsReport = require("./financials-report");
const financialsCalc = require("./financials-calc");
const financialsPresets = require("./financials-presets");

const { COST_LINES, COST_KEYS, lineOf, placements } = financialsReport;

// The truck table shows these three lines on their own; "Other costs" is the rest.
const TRUCK_OWN_LINES = ["driverPay", "fuel", "fixedCosts"];
const OTHER_COST_LINES = Object.freeze(COST_KEYS.filter((k) => !TRUCK_OWN_LINES.includes(k)));
// The driver table's "Receipts tied to the driver".
const RECEIPT_LINES = Object.freeze(["fuel", "tolls", "otherReceipts"]);
// The report's own catch-all groups (financials-report.js groupOf()), listed last.
const TRUCK_CATCH_ALLS = Object.freeze(["truck:", "overhead", "settlement_adjustment", "investor_payouts"]);
const DRIVER_CATCH_ALLS = Object.freeze(["driver:", "settlement_adjustment", "investor_payouts"]);
// (d): the report lines each payout-ledger figure is made of (FIGURE_OF_KIND
// read through financials-report.js lineOf()).
const LINES_OF_FIGURE = Object.freeze({
	revenue: ["revenue"],
	driverPay: ["driverPay"],
	fixedCosts: ["fixedCosts"],
	tripExpenses: ["fuel", "tolls", "otherReceipts"],
	maintFundCost: ["maintenanceFund"],
	complianceCost: ["complianceFees"],
});
// The pending line reads the receipts table, not the books, so it is labelled.
const PENDING_KNOWN_LIMIT = "Counted from the receipts table by each receipt's month and full amount, not from the books: "
	+ "a receipt with a Personal part, or a future-dated one under the newer payout rules, can count differently here than in the figures above.";

const cents = (v) => Math.round(Number(v || 0) * 100);
const lineCents = (f, line) => (!f ? 0 : line === "revenue" ? cents(f.revenue) : cents(f.costs && f.costs[line]));
const countedSum = (f, keys) => keys.reduce((a, k) => a + cents(f.countedCosts && f.countedCosts[k]), 0) / 100;

function daysInMonth(mk) {
	return new Date(Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 0)).getUTCDate();
}
// The months whose every day is inside from–to.
function wholeMonths(from, to) {
	const out = [];
	for (const p of financialsReport.periodsBetween(from, to, "month")) {
		if (p.from === `${p.key}-01` && p.to === `${p.key}-${String(daysInMonth(p.key)).padStart(2, "0")}`) out.push(p.key);
	}
	return out;
}

// The overview's period: a preset resolved on `today` (the business day), or
// from–to checked by `checkRange` (the report's own check). Nothing sent is the
// report's default, the last 12 months.
function periodQuery(query, { today, checkRange }) {
	const q = query && typeof query === "object" ? query : {};
	const has = (k) => q[k] !== undefined;
	let preset = has("preset") ? q.preset : null;
	if (preset !== null && (typeof preset !== "string" || !financialsPresets.PRESET_KEYS.includes(preset))) {
		return { error: `preset must be one of ${financialsPresets.PRESET_KEYS.join(", ")}.` };
	}
	if (preset === null && !has("from") && !has("to")) preset = "last12";
	if (preset === "custom" && (!has("from") || !has("to"))) return { error: "A custom period needs from and to." };
	if (preset !== null && preset !== "custom") {
		if (has("from") || has("to")) return { error: "Send a preset, or from and to, not both." };
		const r = financialsPresets.presetRange(preset, today);
		if (!r) return { error: "The business day could not be read." };
		const checked = checkRange(r.from, r.to);
		return checked.error ? { error: checked.error } : { preset, from: checked.from, to: checked.to };
	}
	const checked = checkRange(q.from, q.to);
	return checked.error ? { error: checked.error } : { preset: "custom", from: checked.from, to: checked.to };
}

// Loads assigned in the period and not delivered yet: outside the P&L, which
// counts a load once it is delivered. `rows` are the ledger's sheet rows
// (server.js ledgerLoadRows(): live loads, `completed`, `amount`, `assignedDate`).
function bookedNotDelivered(rows, from, to, dayOf) {
	let count = 0;
	let total = 0;
	for (const r of rows || []) {
		if (r.completed || !r.loadId || !r.assignedDate || isNaN(r.assignedDate)) continue;
		const day = dayOf(r.assignedDate);
		if (day < from || day > to) continue;
		count++;
		total += cents(r.amount);
	}
	return { count, amount: total / 100 };
}

// Day items the books pay, by the driver group they land in (the report's own
// driver key), counted on the day the report places them. A percentage driver's
// month is paid on revenue, not days, so it counts none.
function paidDaysByDriver(items, from, to, driverKey) {
	const out = new Map();
	for (const it of items || []) {
		if (it.kind !== "driver_pay" || !it.day) continue;
		const [p] = placements(it);
		if (!p || p.day < from || p.day > to) continue;
		const k = it.driver ? driverKey(it.driver) : "";
		const key = k ? `driver:${k}` : "driver:";
		out.set(key, (out.get(key) || 0) + 1);
	}
	return out;
}

// How each truck's loads were measured (the miles source of each load whose
// revenue counts in the period), from the report by load.
function milesSourcesByTruck(loadReport) {
	const out = new Map();
	const add = (key, source) => {
		const m = out.get(key) || {};
		m[source] = (m[source] || 0) + 1;
		out.set(key, m);
	};
	for (const g of (loadReport && loadReport.groups) || []) {
		if (!g.load || !g.total || !g.total.loads) continue;
		const truck = String(g.load.truck || "").trim();
		const source = g.load.milesSource || "none";
		add(truck ? `truck:${truck.toLowerCase()}` : "truck:", source);
		add("fleet", source);
	}
	return out;
}

// A group's period total as a row; its months are Fleet P&L's to show, not the overview's.
function rowOf(group, catchAlls) {
	const total = group.total;
	return {
		key: group.key,
		label: group.label,
		catchAll: catchAlls.includes(group.key),
		...total,
		otherCosts: countedSum(total, OTHER_COST_LINES),
		receipts: countedSum(total, RECEIPT_LINES),
	};
}
// The report's groups as rows: its own order, catch-alls last in a fixed order.
function rowsOf(report, catchAlls) {
	const groups = (report && report.groups) || [];
	const plain = groups.filter((g) => !catchAlls.includes(g.key));
	const extras = catchAlls.map((k) => groups.find((g) => g.key === k)).filter(Boolean);
	return [...plain, ...extras].map((g) => rowOf(g, catchAlls));
}

// ── reconciliation ───────────────────────────────────────────────────────────
const difference = (line, expectedCents, actualCents) => ({ line, expectedCents, actualCents, diffCents: actualCents - expectedCents });

// (a) and (b): the rows add up to the fleet.
function rowsAddUp(check, scope, rows, fleet) {
	const metrics = [
		["revenue", (f) => cents(f.revenue)],
		...COST_KEYS.map((k) => [`costs.${k}`, (f) => cents(f.costs && f.costs[k])]),
		...COST_KEYS.map((k) => [`countedCosts.${k}`, (f) => cents(f.countedCosts && f.countedCosts[k])]),
		["totalCosts", (f) => cents(f.totalCosts)],
		["margin", (f) => cents(f.margin)],
		["otherCosts", (f) => cents(f.otherCosts)],
		["receipts", (f) => cents(f.receipts)],
	];
	const differences = [];
	for (const [line, get] of metrics) {
		const expected = get(fleet);
		const actual = rows.reduce((a, r) => a + get(r), 0);
		if (actual !== expected) differences.push(difference(line, expected, actual));
	}
	return { check, scope, status: differences.length ? "failed" : "ok", differences };
}

// (c): a whole month's items, by line, without placement.
function monthItemsAddUp(mk, items, fleetMonth) {
	const expected = Object.fromEntries(["revenue", ...COST_KEYS].map((l) => [l, 0]));
	for (const it of items) {
		if (it.month !== mk) continue;
		const line = lineOf(it);
		if (line) expected[line] += Number(it.cents) || 0;
	}
	const differences = [];
	for (const line of Object.keys(expected)) {
		const actual = lineCents(fleetMonth, line);
		if (actual !== expected[line]) differences.push(difference(line, expected[line], actual));
	}
	return { check: "c", scope: mk, status: differences.length ? "failed" : "ok", differences };
}

// The payout ledger's figures a month's report lines make, in cents.
function figuresOfLines(fleetMonth) {
	const out = {};
	for (const [fig, lines] of Object.entries(LINES_OF_FIGURE)) out[fig] = lines.reduce((a, l) => a + lineCents(fleetMonth, l), 0);
	return out;
}
function figureDifferences(expectedDollars, actualCents) {
	const differences = [];
	for (const fig of financialsCalc.SETTLED_FIGURES) {
		const expected = cents(expectedDollars && expectedDollars[fig]);
		if (actualCents[fig] !== expected) differences.push(difference(fig, expected, actualCents[fig]));
	}
	return differences;
}
// (d), on its two parts: the mapping, and a frozen month's recorded summary.
function monthFiguresAgree(mk, items, fleetMonth, { closed, frozen, summary }) {
	const actual = figuresOfLines(fleetMonth);
	const differing = (part, differences) => ({
		check: "d", part, scope: mk,
		status: !differences.length ? "ok" : closed ? "note" : "failed",
		...(differences.length && closed ? { note: "as settled" } : {}),
		differences,
	});
	const fromItems = financialsCalc.monthFiguresFromItems(items.filter((i) => i.month === mk))[mk] || {};
	const out = [differing("ledger figures", figureDifferences(fromItems, actual))];
	if (frozen && summary) out.push(differing("recorded summary", figureDifferences(summary, actual)));
	else if (frozen) out.push({ check: "d", part: "recorded summary", scope: mk, status: "skipped", reason: "its recorded summary can't be read", differences: [] });
	else if (closed) out.push({ check: "d", part: "recorded summary", scope: mk, status: "skipped", reason: "closed before freezing existed: no recorded summary", differences: [] });
	return out;
}

function reconcile({ from, to, fleet, trucks, drivers, fleetReport, items, lockedPeriods, frozenSummaries }) {
	const whole = wholeMonths(from, to);
	const checks = [rowsAddUp("a", "trucks", trucks, fleet), rowsAddUp("b", "drivers", drivers, fleet)];
	if (!whole.length) {
		for (const check of ["c", "d"]) checks.push({ check, scope: "period", status: "skipped", reason: "no whole month in the period", differences: [] });
	}
	const byMonth = (fleetReport && fleetReport.totalByPeriod) || {};
	for (const mk of whole) checks.push(monthItemsAddUp(mk, items, byMonth[mk] || null));
	for (const mk of whole) {
		const frozen = frozenSummaries.has(mk);
		checks.push(...monthFiguresAgree(mk, items, byMonth[mk] || null, { closed: lockedPeriods.has(mk), frozen, summary: frozen ? frozenSummaries.get(mk) : null }));
	}
	return { ok: !checks.some((c) => c.status === "failed"), wholeMonths: whole, checks };
}

/**
 * The overview for one period.
 *   fleetReport, truckReport, driverReport, loadReport  buildFinancialsReport()
 *       results for the period at granularity month, grouped by fleet, truck,
 *       driver and load, all from one reading of the books
 *   items           the items the fleet report read (books plus Financials' own lines)
 *   driverKey(name) the report's driver key
 *   lockedPeriods   closed months (Set); frozenSummaries: Map month -> summary (null if unreadable)
 *   bookedNotDelivered  bookedNotDelivered()'s result
 */
function buildOverview({ preset, from, to, fleetReport, truckReport, driverReport, loadReport, items, driverKey, lockedPeriods, frozenSummaries, bookedNotDelivered: booked, generatedAt }) {
	const paidDays = paidDaysByDriver(items, from, to, driverKey);
	const miles = milesSourcesByTruck(loadReport);
	const trucks = rowsOf(truckReport, TRUCK_CATCH_ALLS).map((r) => ({ ...r, milesSources: miles.get(r.key) || {} }));
	const drivers = rowsOf(driverReport, DRIVER_CATCH_ALLS).map((r) => ({ ...r, paidDays: paidDays.get(r.key) || 0 }));
	const total = fleetReport.total;
	const fleet = {
		...total,
		otherCosts: countedSum(total, OTHER_COST_LINES),
		receipts: countedSum(total, RECEIPT_LINES),
		paidDays: [...paidDays.values()].reduce((a, n) => a + n, 0),
		milesSources: miles.get("fleet") || {},
	};
	const reconciliation = reconcile({
		from, to, fleet, trucks, drivers, fleetReport, items: items || [],
		lockedPeriods: new Set(lockedPeriods || []), frozenSummaries: frozenSummaries || new Map(),
	});
	return {
		period: {
			preset,
			label: financialsPresets.presetLabel(preset) || "Custom",
			from, to,
			basis: total.basis,
			closedMonths: fleetReport.closedMonths || [],
			wholeMonths: reconciliation.wholeMonths,
		},
		lines: COST_LINES,
		otherCostLines: OTHER_COST_LINES,
		receiptLines: RECEIPT_LINES,
		fleet,
		trucks,
		drivers,
		reconciliation: { ok: reconciliation.ok, checks: reconciliation.checks },
		pendingReceipts: { ...fleetReport.pendingReceipts, knownLimit: PENDING_KNOWN_LIMIT },
		bookedNotDelivered: booked || { count: 0, amount: 0 },
		overlaps: fleetReport.overlaps || 0,
		generatedAt,
	};
}

// The CSV: the period, the truck table and the driver table (each with its
// fleet total), the checks, then the lines outside the figures. Line columns
// carry the line's value and totals what counted, as the report's CSV does.
function overviewRows(ov) {
	const blank = (v) => (v == null ? "" : v);
	const out = [["Financials overview", ov.period.label, `${ov.period.from} to ${ov.period.to}`, `Basis: ${ov.period.basis}`]];
	const switchedOff = COST_LINES.filter((l) => ov.fleet.lineState[l.key] !== "on" && ov.fleet.costs[l.key] !== 0)
		.map((l) => `${l.label}: ${ov.fleet.lineState[l.key] === "partial" ? "off in part of the period" : "off"}, ${ov.fleet.countedCosts[l.key]} of ${ov.fleet.costs[l.key]} counted`);
	if (switchedOff.length) out.push(["Cost lines switched off", switchedOff.join("; ")]);
	out.push([], ["By truck"], ["Truck", "Loads", "Revenue", "Driver pay", "Fuel", "Other costs (counted)", "Fixed", "Total costs", "Net", "Margin %", "Miles", "Revenue per mile", "Basis"]);
	const truckRow = (label, f) => [label, f.loads, f.revenue, f.costs.driverPay, f.costs.fuel, f.otherCosts, f.costs.fixedCosts, f.totalCosts, f.margin,
		blank(f.marginPct), f.miles, blank(f.revenuePerMile), f.basis];
	for (const r of ov.trucks) out.push(truckRow(r.label, r));
	out.push(truckRow("Fleet total", ov.fleet));
	out.push([], ["By driver"], ["Driver", "Loads", "Revenue", "Driver pay", "Pay % of revenue", "Receipts (counted)", "Total costs", "Net", "Miles", "Revenue per mile", "Paid days", "Basis"]);
	const driverRow = (label, f) => [label, f.loads, f.revenue, f.costs.driverPay, blank(f.driverPayPct), f.receipts, f.totalCosts, f.margin, f.miles,
		blank(f.revenuePerMile), f.paidDays, f.basis];
	for (const r of ov.drivers) out.push(driverRow(r.label, r));
	out.push(driverRow("Fleet total", ov.fleet));
	out.push([], ["Reconciliation", ov.reconciliation.ok ? "Trucks, drivers and Fleet P&L agree to the cent" : "Mismatch: see the failed checks below"]);
	for (const c of ov.reconciliation.checks) {
		if (c.status !== "failed" && c.status !== "note") continue;
		for (const d of c.differences) out.push([`(${c.check}) ${c.scope}${c.part ? ` ${c.part}` : ""}${c.status === "note" ? " (as settled)" : ""}`, d.line, d.expectedCents / 100, d.actualCents / 100, d.diffCents / 100]);
	}
	out.push([]);
	out.push(["Booked, not yet delivered (not in the figures above)", ov.bookedNotDelivered.count, ov.bookedNotDelivered.amount]);
	out.push(["Receipts pending review (counted above)", ov.pendingReceipts.count, ov.pendingReceipts.amount, ov.pendingReceipts.knownLimit]);
	return out;
}

module.exports = {
	OTHER_COST_LINES,
	RECEIPT_LINES,
	TRUCK_CATCH_ALLS,
	DRIVER_CATCH_ALLS,
	PENDING_KNOWN_LIMIT,
	wholeMonths,
	periodQuery,
	bookedNotDelivered,
	buildOverview,
	overviewRows,
};
