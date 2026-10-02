"use strict";
// The one money calculation: a scope's months and its dated line items.
//
// A scope is one investor (the payout ledger's view) or the company remainder
// (owner 0). The fleet is the sum of its scopes. computeLedgerScope() is the
// payout ledger's month math, moved here unchanged from
// computeInvestorMonthlyEarnings() in server.js, which now gathers the facts and
// settles the months it returns. The month totals are built in the same order,
// from the same aggregates, as before the move, so no payout moves
// (scripts/test-ledger-golden.js pins that to the byte).
//
// Beside the totals it emits one line item per contribution, so any period and
// any grouping can be built from the same figures the ledger settles:
//   revenue      one per completed load, in its Assigned month
//   driver_pay   one per paid driver-day (fixed rate), or one per driver-month
//                (percentage pay), in the load's Assigned month
//   fixed        one per truck-month charged ($0 in an idle month: none)
//   trip         one per receipt, in its posted period
//   maint_fund   one per maintenance-fund service entry
//   compliance   one per Paid compliance fee
// Amounts are integer cents. Every item carries its month, and where it has
// one its day, load, driver, truck and owner.
//
// Pure: no database, network or file access. The caller passes everything in,
// including the server's shared predicates (truckMonthlyFixed(),
// truckChargedInMonth(), resolveDailyRate()), so there is still one copy of each.

const cents = (dollars) => Math.round(Number(dollars || 0) * 100);
const pad2 = (n) => String(n).padStart(2, "0");

// The calendar day of a Date, in the process's clock zone, exactly as the
// ledger has always formatted it.
function fmtDate(d) {
	return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// Every calendar day from start to end inclusive, capped at 31 days; a missing
// or earlier end is the start day alone. The ledger's own expansion, unchanged.
function expandDateRange(start, end) {
	const dates = [];
	const s = new Date(start); s.setHours(12, 0, 0, 0);
	const e = end ? new Date(end) : new Date(start);
	e.setHours(12, 0, 0, 0);
	if (e < s) return [fmtDate(s)];
	const MAX_SPAN = 31 * 24 * 3600 * 1000;
	if (e - s > MAX_SPAN) e.setTime(s.getTime() + MAX_SPAN);
	const cur = new Date(s);
	while (cur <= e) { dates.push(fmtDate(cur)); cur.setDate(cur.getDate() + 1); }
	return dates;
}

// facts:
//   rows               the scope's live Job Tracking rows, in sheet order, each
//                      { loadId, driver (normalized), truckUnit (lower-case),
//                        truckLabel, assignedDate (Date|null), pickupDate,
//                        dropoffDate, completed, amount, ownerId, source }
//                      `source` is the raw row, handed back to describeLoad.
//   unitToVid          lower-case unit -> ELD vehicle id
//   eldByVid           vehicle id -> { travel: Set<day>, coverage: Set<day> }
//   driverDayOverrides driver -> { remove: Set<day>, add: Set<day> }
//   addDaysFor(drv)    whether a driver's added override days count in this scope
//   payStructures      driver -> { payType, payPercentage, payDaily }
//   expensesByDriverMonth driver -> { month: deductible total }
//   rateFor(driver, struct) the fixed daily rate for a driver in this scope
//   tripByMonth, maintByMonth, complianceByMonth   month -> SQL total
//   receipts           [{ id, month, day, amount, type, truck, driver, loadId, status }]
//   maintRows, complianceRows  [{ id, month, day, amount, truck }]
//   fixedTrucks        trucks charged fixed costs in this scope
//   truckChargedInMonth(t, mk), truckMonthlyFixed(t)  the server's predicates
//   isZeroActivityMonth(month figures)               investor-payout-basis
//   startMonthFor(earliestMonthKey|null)  first month of the ledger
//   currentMonthKey    the Houston month now; endDate the first of this month
//   ownerId            the scope's owner (0 for the company remainder)
//   detailForMonth     'YYYY-MM' to also build the month drill-down, else null
//   describeLoad(source, loadId) -> { pickup, dropoff }  (drill-down only)
function computeLedgerScope(facts) {
	const {
		rows, unitToVid, eldByVid, driverDayOverrides, addDaysFor, payStructures, expensesByDriverMonth, rateFor,
		tripByMonth, maintByMonth, complianceByMonth, receipts, maintRows, complianceRows,
		fixedTrucks, truckChargedInMonth, truckMonthlyFixed, isZeroActivityMonth, startMonthFor,
		currentMonthKey, endDate, ownerId = 0, detailForMonth = null, describeLoad,
	} = facts;
	const detail = detailForMonth ? { revenueLoads: [], driverPayRows: [], fixedCostItems: [], tripExpenseItems: [] } : null;
	const items = [];

	const monthlyRevenue = {};
	const driverMonthlyDays = Object.create(null);    // { driver: { mk: Set<day> } }
	const driverDayLoad = Object.create(null);        // { driver: { mk: { day: row } } }, the first load to claim a day
	const driverMonthlyRevenue = Object.create(null); // { driver: { mk: revenue } }
	let earliestDate = null;
	for (const r of rows) {
		const assignedMonthKey = r.assignedDate ? fmtDate(r.assignedDate).slice(0, 7) : null;
		const driver = r.driver;
		if (r.completed) {
			const amt = r.amount;
			if (amt && assignedMonthKey) {
				monthlyRevenue[assignedMonthKey] = (monthlyRevenue[assignedMonthKey] || 0) + amt;
				items.push({
					kind: "revenue", month: assignedMonthKey, day: fmtDate(r.assignedDate), cents: cents(amt),
					loadId: r.loadId, driver: driver || "", truck: r.truckLabel, ownerId, rowIndex: r.rowIndex,
					blankOwner: !r.ownerCell,
					workDay: r.pickupDate && !isNaN(r.pickupDate) ? fmtDate(r.pickupDate) : fmtDate(r.assignedDate),
				});
				if (detail && assignedMonthKey === detailForMonth) {
					const place = describeLoad ? describeLoad(r.source, r.loadId) : { pickup: "", dropoff: "" };
					detail.revenueLoads.push({
						loadId: r.loadId,
						driver: driver || "",
						truck: r.truckLabel,
						date: r.assignedText,
						pickup: place.pickup,
						dropoff: place.dropoff,
						amount: Math.round(amt * 100) / 100,
					});
				}
				if (driver) {
					if (!driverMonthlyRevenue[driver]) driverMonthlyRevenue[driver] = {};
					driverMonthlyRevenue[driver][assignedMonthKey] = (driverMonthlyRevenue[driver][assignedMonthKey] || 0) + amt;
				}
			}
		}
		if (r.completed && driver) {
			let pickup = r.pickupDate;
			const dropoff = r.dropoffDate;
			if (!pickup && r.assignedDate) pickup = r.assignedDate;
			if (pickup && !isNaN(pickup)) {
				const windowDays = expandDateRange(pickup, dropoff || pickup);
				const vid = r.truckUnit ? unitToVid[r.truckUnit] : null;
				const eld = vid ? eldByVid[vid] : null;
				const covered = eld && windowDays.some((d) => eld.coverage.has(d));
				const eldCounted = covered ? windowDays.filter((d) => eld.travel.has(d)) : windowDays;
				const ovr = driverDayOverrides[driver] || null;
				const skipSet = ovr ? ovr.remove : null;
				const counted = skipSet && skipSet.size ? eldCounted.filter((d) => !skipSet.has(d)) : eldCounted;
				if (!driverMonthlyDays[driver]) { driverMonthlyDays[driver] = {}; driverDayLoad[driver] = {}; }
				for (const d of counted) {
					const bucket = assignedMonthKey || d.slice(0, 7);
					if (!driverMonthlyDays[driver][bucket]) { driverMonthlyDays[driver][bucket] = new Set(); driverDayLoad[driver][bucket] = {}; }
					driverMonthlyDays[driver][bucket].add(d);
					if (!driverDayLoad[driver][bucket][d]) driverDayLoad[driver][bucket][d] = r;
				}
			}
		}
		if (r.assignedDate && !isNaN(r.assignedDate) && (!earliestDate || r.assignedDate < earliestDate)) earliestDate = r.assignedDate;
	}

	// Admin-added days. Bucketed by the day's own month: there is no load to
	// read an Assigned month from.
	for (const [drv, ovr] of Object.entries(driverDayOverrides)) {
		if (!ovr.add || !ovr.add.size) continue;
		if (!addDaysFor(drv)) continue;
		if (!driverMonthlyDays[drv]) { driverMonthlyDays[drv] = {}; driverDayLoad[drv] = {}; }
		for (const d of ovr.add) {
			const bucket = d.slice(0, 7);
			if (!driverMonthlyDays[drv][bucket]) { driverMonthlyDays[drv][bucket] = new Set(); driverDayLoad[drv][bucket] = {}; }
			driverMonthlyDays[drv][bucket].add(d);
		}
	}

	const monthlyDriverPay = {};
	for (const [driver, monthsMap] of Object.entries(driverMonthlyDays)) {
		const struct = payStructures[driver] || { payType: "fixed", payPercentage: 0 };
		const fixedRate = rateFor(driver, struct);
		for (const [mk, daySet] of Object.entries(monthsMap)) {
			const activeDays = daySet.size;
			const monthRev = (driverMonthlyRevenue[driver] || {})[mk] || 0;
			const monthExp = (expensesByDriverMonth[driver] || {})[mk] || 0;
			const net = Math.max(0, monthRev - monthExp);
			let pay;
			if (struct.payType === "percentage") {
				pay = Math.round((net * struct.payPercentage / 100) * 100) / 100;
				items.push({ kind: "driver_pay", month: mk, day: null, cents: cents(pay), driver, ownerId, payType: "percentage", days: activeDays });
			} else {
				pay = activeDays * fixedRate;
				for (const d of [...daySet].sort()) {
					const src = driverDayLoad[driver][mk][d] || null;
					items.push({
						kind: "driver_pay", month: mk, day: d, cents: cents(fixedRate), driver, ownerId, payType: "fixed",
						loadId: src ? src.loadId : "", truck: src ? src.truckLabel : "", added: !src, blankOwner: !!src && !src.ownerCell,
					});
				}
			}
			monthlyDriverPay[mk] = (monthlyDriverPay[mk] || 0) + pay;
			if (detail && mk === detailForMonth) {
				detail.driverPayRows.push({
					driver,
					activeDays,
					dailyRate: fixedRate,
					payType: struct.payType,
					payPercentage: struct.payPercentage,
					pay: Math.round(pay * 100) / 100,
				});
			}
		}
	}

	for (const x of receipts) {
		items.push({
			kind: "trip", month: x.month, day: x.day, cents: cents(x.amount), expenseId: x.id, expenseType: x.type,
			truck: x.truck, driver: x.driver, loadId: x.loadId, status: x.status, ownerId,
		});
	}
	for (const x of maintRows) items.push({ kind: "maint_fund", month: x.month, day: x.day, cents: cents(x.amount), truck: x.truck, sourceId: x.id, ownerId });
	for (const x of complianceRows) items.push({ kind: "compliance", month: x.month, day: x.day, cents: cents(x.amount), truck: x.truck, sourceId: x.id, ownerId });

	const getMonthlyFixedCosts = (monthKey) => {
		let total = 0;
		for (const t of fixedTrucks) {
			if (!truckChargedInMonth(t, monthKey)) continue;
			total += truckMonthlyFixed(t).total;
		}
		return Math.round(total * 100) / 100;
	};
	if (detail) {
		for (const t of fixedTrucks) {
			if (!truckChargedInMonth(t, detailForMonth)) continue;
			detail.fixedCostItems.push({ truck: t.unit_number || "", ...truckMonthlyFixed(t) });
		}
	}

	const startMonth = startMonthFor(earliestDate ? `${earliestDate.getFullYear()}-${pad2(earliestDate.getMonth() + 1)}` : null);
	let cursor = new Date(parseInt(startMonth.slice(0, 4)), parseInt(startMonth.slice(5, 7)) - 1, 1);
	const months = [];
	while (cursor <= endDate) {
		const mk = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}`;
		const revenue = monthlyRevenue[mk] || 0;
		const driverPay = monthlyDriverPay[mk] || 0;
		const rawFixedCosts = getMonthlyFixedCosts(mk);
		const tripExpenses = tripByMonth[mk] || 0;
		const maintFundCost = maintByMonth[mk] || 0;
		const complianceCost = complianceByMonth[mk] || 0;
		const driverCount = Object.values(driverMonthlyDays).filter((m) => m[mk] && m[mk].size).length;
		const isZeroActivity = isZeroActivityMonth({ revenue, driverPay, tripExpenses, maintFundCost, complianceCost, driverCount });
		const fixedCosts = isZeroActivity ? 0 : rawFixedCosts;
		if (detail && mk === detailForMonth && fixedCosts === 0) detail.fixedCostItems = [];
		if (fixedCosts) {
			// One item per truck; the last carries any rounding, so the items add
			// up to the month's figure to the cent.
			const fixedItems = [];
			for (const t of fixedTrucks) {
				if (!truckChargedInMonth(t, mk)) continue;
				fixedItems.push({ kind: "fixed", month: mk, day: null, cents: cents(truckMonthlyFixed(t).total), truck: t.unit_number || "", ownerId });
			}
			if (fixedItems.length) fixedItems[fixedItems.length - 1].cents += cents(fixedCosts) - fixedItems.reduce((a, i) => a + i.cents, 0);
			items.push(...fixedItems);
		}
		const netProfit = revenue - driverPay - fixedCosts - tripExpenses - maintFundCost - complianceCost;
		months.push({ month: mk, netProfit, zeroActivity: isZeroActivity, revenue, driverPay, fixedCosts, tripExpenses, maintFundCost, complianceCost });
		cursor.setMonth(cursor.getMonth() + 1);
	}
	return { months, items, detail, currentMonthKey, startMonth };
}

// The month figures a set of items adds up to, in dollars (from integer cents).
const FIGURE_OF_KIND = {
	revenue: "revenue", driver_pay: "driverPay", fixed: "fixedCosts", trip: "tripExpenses",
	maint_fund: "maintFundCost", compliance: "complianceCost",
};
function monthFiguresFromItems(items) {
	const byMonth = Object.create(null);
	for (const it of items) {
		const fig = FIGURE_OF_KIND[it.kind] || (it.kind === "settlement_adjustment" ? FIGURE_OF_KIND[it.adjusts] : null);
		if (!fig) continue;
		const m = byMonth[it.month] || (byMonth[it.month] = { revenue: 0, driverPay: 0, fixedCosts: 0, tripExpenses: 0, maintFundCost: 0, complianceCost: 0 });
		m[fig] += it.cents;
	}
	const out = Object.create(null);
	for (const [mk, c] of Object.entries(byMonth)) {
		const f = {};
		for (const k of Object.keys(c)) f[k] = c[k] / 100;
		f.netProfit = (c.revenue - c.driverPay - c.fixedCosts - c.tripExpenses - c.maintFundCost - c.complianceCost) / 100;
		out[mk] = f;
	}
	return out;
}

// The "Settlement adjustment" items that bring a closed investor-month's live
// items to the figures it settled at (its frozen breakdown), one per figure that
// differs, so frozen totals equal what was settled to the cent. Empty when they
// already agree.
const SETTLED_FIGURES = ["revenue", "driverPay", "fixedCosts", "tripExpenses", "maintFundCost", "complianceCost"];
const KIND_OF_FIGURE = Object.fromEntries(Object.entries(FIGURE_OF_KIND).map(([k, f]) => [f, k]));
function settlementAdjustments(items, month, settled, ownerId) {
	const live = monthFiguresFromItems(items.filter((i) => i.month === month))[month] || {};
	const out = [];
	for (const fig of SETTLED_FIGURES) {
		const diff = cents(settled[fig]) - cents(live[fig] || 0);
		if (diff) out.push({ kind: "settlement_adjustment", adjusts: KIND_OF_FIGURE[fig], month, day: null, cents: diff, ownerId });
	}
	return out;
}

module.exports = {
	computeLedgerScope,
	monthFiguresFromItems,
	settlementAdjustments,
	expandDateRange,
	fmtDate,
	FIGURE_OF_KIND,
	SETTLED_FIGURES,
};
