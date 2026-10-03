"use strict";
// Financials reports: any date range, by day, week (the house week, Saturday to
// Friday), month, quarter or year, grouped by the fleet, truck, driver, load,
// pickup state, delivery state or owner. Built only from the dated line items of
// lib/financials-calc.js (open months live, closed months as settled), so every
// view adds up to the same books, to the cent.
//
// Where an item lands:
//   - an item with a day in its own month lands on that day;
//   - a driver-pay day outside its month (a load's days are paid in its
//     Assigned month) lands on that month's first or last day, so a month is
//     the same total in every view;
//   - an item with no day (a truck-month's fixed costs, a percentage driver's
//     month, a Settlement adjustment, the monthly reserve, depreciation and
//     overhead) is spread evenly over its month's days.
//   Then the day is kept if it is inside the range, and bucketed by period.
//
// Cost lines are Financials settings (decision D7: they change Financials only,
// never payouts). Every line's value is reported; only the lines switched on
// for an item's month count in its total costs and margin. A closed month keeps
// the settings it closed with.
//
// "Settlement adjustment" items (a closed investor-month brought to the figures
// it settled at) are folded into the line they correct, so each line of a closed
// month is what was settled; their total is reported beside the margin. By owner
// they are part of the owner's figures; in the other groupings they are their
// own group (they belong to no truck, driver or load).
//
// Pure: no database, network or file access.

const COST_LINES = [
	{ key: "fuel", label: "Fuel" },
	{ key: "tolls", label: "Tolls" },
	{ key: "otherReceipts", label: "Other receipts" },
	{ key: "driverPay", label: "Driver pay" },
	{ key: "fixedCosts", label: "Truck fixed costs" },
	{ key: "maintenanceFund", label: "Maintenance-fund entries" },
	{ key: "complianceFees", label: "Compliance fees" },
	{ key: "maintenanceReserve", label: "Maintenance reserve" },
	{ key: "depreciation", label: "Depreciation" },
	{ key: "overhead", label: "Overhead" },
	{ key: "investorPayouts", label: "Investor payouts" },
];
const COST_KEYS = COST_LINES.map((l) => l.key);

// The payout ledger's categories are on; the rest are off until switched on.
const DEFAULT_SETTINGS = Object.freeze({
	costs: Object.freeze({
		fuel: true, tolls: true, otherReceipts: true, driverPay: true, fixedCosts: true,
		maintenanceFund: true, complianceFees: true,
		maintenanceReserve: false, depreciation: false, overhead: false, investorPayouts: false,
	}),
	overheadMonthly: 0,
	depreciationYears: 5,
});

// A stored settings value read back into the full shape; anything unknown or
// mistyped falls back to the default.
function normalizeSettings(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const costs = {};
	for (const k of COST_KEYS) {
		const v = src.costs && src.costs[k];
		costs[k] = typeof v === "boolean" ? v : DEFAULT_SETTINGS.costs[k];
	}
	const overhead = Number(src.overheadMonthly);
	const years = Number(src.depreciationYears);
	return {
		costs,
		overheadMonthly: Number.isFinite(overhead) && overhead >= 0 ? Math.round(overhead * 100) / 100 : DEFAULT_SETTINGS.overheadMonthly,
		depreciationYears: Number.isFinite(years) && years > 0 ? years : DEFAULT_SETTINGS.depreciationYears,
	};
}

const LINE_OF_KIND = {
	revenue: "revenue",
	driver_pay: "driverPay",
	fixed: "fixedCosts",
	maint_fund: "maintenanceFund",
	compliance: "complianceFees",
	maint_reserve: "maintenanceReserve",
	depreciation: "depreciation",
	overhead: "overhead",
	investor_payout: "investorPayouts",
};
function tripLine(expenseType) {
	const t = String(expenseType || "").trim().toLowerCase();
	if (t === "fuel") return "fuel";
	if (t === "toll" || t === "tolls") return "tolls";
	return "otherReceipts";
}
// The line an item counts in. A Settlement adjustment counts in the line of the
// figure it corrects; a trip correction cannot be split by receipt type, so it
// is "Other receipts".
function lineOf(item) {
	if (item.kind === "trip") return tripLine(item.expenseType);
	if (item.kind === "settlement_adjustment") return item.adjusts === "trip" ? "otherReceipts" : (LINE_OF_KIND[item.adjusts] || null);
	return LINE_OF_KIND[item.kind] || null;
}

// ── calendar ──────────────────────────────────────────────────────────────────
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");
// Calendar arithmetic on noon UTC, so no clock zone can shift a day.
const dayMs = (d) => Date.parse(`${d}T12:00:00Z`);
const msDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => msDay(dayMs(d) + n * 86400000);
function daysInMonth(mk) {
	const [y, m] = mk.split("-").map(Number);
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const monthFirst = (mk) => `${mk}-01`;
const monthLast = (mk) => `${mk}-${pad2(daysInMonth(mk))}`;

// The Saturday that starts the house week a day belongs to.
function weekStart(d) {
	const dow = new Date(dayMs(d)).getUTCDay(); // 0 Sunday .. 6 Saturday
	return addDays(d, -((dow + 1) % 7));
}

function periodKey(d, granularity) {
	switch (granularity) {
		case "day": return d;
		case "week": return weekStart(d);
		case "quarter": return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
		case "year": return d.slice(0, 4);
		default: return d.slice(0, 7);
	}
}
function periodBounds(key, granularity) {
	switch (granularity) {
		case "day": return { from: key, to: key };
		case "week": return { from: key, to: addDays(key, 6) };
		case "quarter": {
			const y = key.slice(0, 4);
			const q = Number(key.slice(6));
			const m0 = (q - 1) * 3 + 1;
			return { from: `${y}-${pad2(m0)}-01`, to: monthLast(`${y}-${pad2(m0 + 2)}`) };
		}
		case "year": return { from: `${key}-01-01`, to: `${key}-12-31` };
		default: return { from: monthFirst(key), to: monthLast(key) };
	}
}
function periodLabel(key, granularity) {
	switch (granularity) {
		case "day": return `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}, ${key.slice(0, 4)}`;
		case "week": {
			const to = addDays(key, 6);
			return `Week of ${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))} – ${MONTH_NAMES[Number(to.slice(5, 7)) - 1]} ${Number(to.slice(8, 10))}, ${to.slice(0, 4)}`;
		}
		case "quarter": return `${key.slice(5)} ${key.slice(0, 4)}`;
		case "year": return key;
		default: return `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
	}
}
// Every period touching [from, to], in order, each clipped to the range.
function periodsBetween(from, to, granularity) {
	const out = [];
	let d = from;
	let guard = 0;
	while (d <= to && guard++ < 4000) {
		const key = periodKey(d, granularity);
		const b = periodBounds(key, granularity);
		out.push({ key, label: periodLabel(key, granularity), from: b.from < from ? from : b.from, to: b.to > to ? to : b.to });
		d = addDays(b.to, 1);
	}
	return out;
}

// Integer cents split over n days: the remainder goes one cent at a time to
// the first days, so the parts add back to the whole.
function splitCents(cents, n) {
	const sign = cents < 0 ? -1 : 1;
	const abs = Math.abs(cents);
	const base = Math.floor(abs / n);
	const rem = abs - base * n;
	const out = [];
	for (let i = 0; i < n; i++) out.push(sign * (base + (i < rem ? 1 : 0)));
	return out;
}
// The days an item counts on, with its cents on each (see the header).
function placements(item) {
	const mk = item.month;
	if (item.day && DAY_RE.test(item.day)) {
		if (item.day.slice(0, 7) === mk) return [{ day: item.day, cents: item.cents }];
		return [{ day: item.day < monthFirst(mk) ? monthFirst(mk) : monthLast(mk), cents: item.cents }];
	}
	const n = daysInMonth(mk);
	return splitCents(item.cents, n).map((c, i) => ({ day: `${mk}-${pad2(i + 1)}`, cents: c })).filter((p) => p.cents !== 0);
}

// ── grouping ──────────────────────────────────────────────────────────────────
const SETTLEMENT_GROUP = { key: "settlement_adjustment", label: "Settlement adjustment" };

// ctx:
//   truckOf(item)      the item's truck label ("" when none can be told)
//   loadOf(loadKey)    { state: { pickup, delivery }, truck, driver } for a load
//   loadKey(loadId)    the one load-ID key (normalizeLoadId)
//   driverKey(name)    the one driver key (normalizeDriverName): loads and pay
//                      carry it, receipts carry the name as typed
//   driverLabel(key), ownerLabel(id), truckLabel(unit)
function groupOf(item, groupBy, ctx) {
	if (groupBy === "fleet") return { key: "fleet", label: "Fleet" };
	// An adjustment belongs to the investor-month it settles, so by owner it is
	// part of that owner's figures (what the owner settled at).
	if (groupBy === "owner") {
		const id = Number(item.ownerId) || 0;
		return { key: `owner:${id}`, label: ctx.ownerLabel(id) };
	}
	if (item.kind === "settlement_adjustment") return SETTLEMENT_GROUP;
	if (item.kind === "investor_payout") return { key: "investor_payouts", label: "Investor payouts" };
	if (groupBy === "truck") {
		if (item.kind === "overhead") return { key: "overhead", label: "Company overhead" };
		const t = ctx.truckOf(item);
		return t ? { key: `truck:${t.toLowerCase()}`, label: ctx.truckLabel(t) } : { key: "truck:", label: "No truck" };
	}
	if (groupBy === "driver") {
		const k = item.driver ? ctx.driverKey(item.driver) : "";
		return k ? { key: `driver:${k}`, label: ctx.driverLabel(k) } : { key: "driver:", label: "Not tied to a driver" };
	}
	const lk = item.loadId ? ctx.loadKey(item.loadId) : "";
	const known = lk && ctx.loadOf(lk);
	if (groupBy === "load") {
		if (lk) return { key: `load:${lk}`, label: String(item.loadId).trim(), loadKey: lk };
		if (item.kind === "overhead") return { key: "unallocated:overhead", label: "Unallocated — company overhead" };
		const t = ctx.truckOf(item);
		return { key: `unallocated:${(t || "").toLowerCase()}`, label: t ? `Unallocated — ${ctx.truckLabel(t)}` : "Unallocated — no truck" };
	}
	// pickupState / deliveryState: a load's state; costs tied to no load are unallocated.
	const which = groupBy === "pickupState" ? "pickup" : "delivery";
	if (!lk) return { key: "unallocated", label: "Unallocated (not tied to a load)" };
	const st = known ? known.state[which] : "";
	return st ? { key: `state:${st}`, label: st } : { key: "state:", label: "State unknown" };
}

function newAcc() {
	const lines = {};
	for (const k of COST_KEYS) lines[k] = 0;
	return { revenue: 0, lines, enabledCosts: 0, settlement: 0, loads: new Set(), settled: false, live: false };
}

// Build the report.
//   items      books items (lib/financials-calc.js shape, each with basis)
//   from, to   'YYYY-MM-DD', inclusive
//   granularity day | week | month | quarter | year
//   groupBy    fleet | truck | driver | load | pickupState | deliveryState | owner
//   settingsFor(monthKey)  the normalized settings in force for that month
//   milesOf(loadKey)       { miles, source } | null
//   ctx                    see groupOf()
function buildReport({ items, from, to, granularity, groupBy, settingsFor, milesOf, ctx }) {
	const periods = periodsBetween(from, to, granularity);
	const groups = new Map();
	const fleet = { byPeriod: new Map(), total: newAcc() };
	const accFor = (holder, period) => {
		if (!holder.byPeriod.has(period)) holder.byPeriod.set(period, newAcc());
		return holder.byPeriod.get(period);
	};
	for (const item of items) {
		const line = lineOf(item);
		if (!line) continue;
		const enabled = line === "revenue" || settingsFor(item.month).costs[line] === true;
		const g = groupOf(item, groupBy, ctx);
		if (!groups.has(g.key)) groups.set(g.key, { ...g, byPeriod: new Map(), total: newAcc() });
		const holder = groups.get(g.key);
		const lk = item.kind === "revenue" && item.loadId ? ctx.loadKey(item.loadId) : "";
		for (const p of placements(item)) {
			if (p.day < from || p.day > to) continue;
			const pk = periodKey(p.day, granularity);
			for (const acc of [accFor(holder, pk), holder.total, accFor(fleet, pk), fleet.total]) {
				if (line === "revenue") acc.revenue += p.cents;
				else {
					acc.lines[line] += p.cents;
					if (enabled) acc.enabledCosts += p.cents;
				}
				if (item.kind === "settlement_adjustment") acc.settlement += line === "revenue" ? p.cents : (enabled ? -p.cents : 0);
				if (lk) acc.loads.add(lk);
				if (item.basis === "settled") acc.settled = true;
				else acc.live = true;
			}
		}
	}
	const dollars = (c) => c / 100;
	const figures = (acc) => {
		let miles = 0;
		let measured = 0;
		for (const lk of acc.loads) {
			const m = milesOf(lk);
			if (m && Number(m.miles) > 0) { miles += Number(m.miles); measured++; }
		}
		const revenue = dollars(acc.revenue);
		const totalCosts = dollars(acc.enabledCosts);
		const margin = Math.round((acc.revenue - acc.enabledCosts)) / 100;
		const lines = {};
		for (const k of COST_KEYS) lines[k] = dollars(acc.lines[k]);
		return {
			revenue,
			costs: lines,
			totalCosts,
			margin,
			marginPct: acc.revenue ? Math.round(((acc.revenue - acc.enabledCosts) / acc.revenue) * 1000) / 10 : null,
			settlementAdjustment: dollars(acc.settlement),
			loads: acc.loads.size,
			loadsWithMiles: measured,
			miles: Math.round(miles),
			revenuePerMile: miles > 0 ? Math.round((acc.revenue / miles)) / 100 : null,
			costPerMile: miles > 0 ? Math.round((acc.enabledCosts / miles)) / 100 : null,
			basis: acc.settled && acc.live ? "mixed" : acc.settled ? "settled" : acc.live ? "live" : "none",
		};
	};
	const shape = (holder) => {
		const byPeriod = {};
		for (const p of periods) if (holder.byPeriod.has(p.key)) byPeriod[p.key] = figures(holder.byPeriod.get(p.key));
		return { total: figures(holder.total), byPeriod };
	};
	const outGroups = [...groups.values()].map((g) => {
		const base = { key: g.key, label: g.label, ...shape(g) };
		if (g.loadKey) {
			const info = ctx.loadOf(g.loadKey) || {};
			const m = milesOf(g.loadKey);
			base.load = {
				loadId: g.label,
				truck: info.truck || "",
				driver: info.driver ? ctx.driverLabel(ctx.driverKey(info.driver)) : "",
				assignedDate: info.assignedDate || "",
				pickupState: (info.state && info.state.pickup) || "",
				deliveryState: (info.state && info.state.delivery) || "",
				milesSource: m ? m.source : "",
			};
		}
		return base;
	}).filter((g) => Object.keys(g.byPeriod).length);
	outGroups.sort((a, b) => b.total.revenue - a.total.revenue || a.label.localeCompare(b.label));
	const fleetShape = shape(fleet);
	return {
		periods: periods.map((p) => ({ ...p, basis: fleetShape.byPeriod[p.key] ? fleetShape.byPeriod[p.key].basis : "none" })),
		lines: COST_LINES,
		groups: outGroups,
		total: fleetShape.total,
		totalByPeriod: fleetShape.byPeriod,
	};
}

// One CSV-ready row per group and period, then each group's total, then the
// fleet: the same figures as the report.
function reportRows(report, { groupLabel = "Group" } = {}) {
	const header = ["Period", groupLabel, "Basis", "Revenue", ...COST_LINES.map((l) => l.label), "Total costs", "Margin", "Margin %",
		"Settlement adjustment (included)", "Loads", "Miles", "Revenue per mile", "Cost per mile"];
	const row = (periodLabelText, group, f) => [
		periodLabelText, group, f.basis, f.revenue, ...COST_KEYS.map((k) => f.costs[k]), f.totalCosts, f.margin,
		f.marginPct == null ? "" : f.marginPct, f.settlementAdjustment, f.loads, f.miles,
		f.revenuePerMile == null ? "" : f.revenuePerMile, f.costPerMile == null ? "" : f.costPerMile,
	];
	const out = [header];
	for (const g of report.groups) {
		for (const p of report.periods) if (g.byPeriod[p.key]) out.push(row(p.label, g.label, g.byPeriod[p.key]));
		out.push(row("Total", g.label, g.total));
	}
	for (const p of report.periods) if (report.totalByPeriod[p.key]) out.push(row(p.label, "All", report.totalByPeriod[p.key]));
	out.push(row("Total", "All", report.total));
	return out;
}

module.exports = {
	COST_LINES,
	COST_KEYS,
	DEFAULT_SETTINGS,
	normalizeSettings,
	lineOf,
	weekStart,
	periodKey,
	periodsBetween,
	placements,
	splitCents,
	buildReport,
	reportRows,
};
