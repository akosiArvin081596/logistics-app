"use strict";
// The before-payroll check's reasons and shape, kept apart from server.js so they
// are decided on plain facts and tested alone; it holds no pay rule of its own.
// Pure: no I/O, no requires, no environment reads.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const SECTIONS = ["ledgerDays", "invoiceDays", "personalLines", "pendingReceipts", "correctionDrafts", "percentageLoads"];

const WEEK_REFUSALS = {
	invalid: "PAYROLL_CHECK_WEEK_END_INVALID",
	notFinished: "PAYROLL_CHECK_WEEK_NOT_FINISHED",
	closed: "PAYROLL_CHECK_WEEK_CLOSED",
};

// A real calendar day "YYYY-MM-DD", checked by arithmetic (2026-02-30 is none).
function isDay(s) {
	if (typeof s !== "string" || !DAY_RE.test(s)) return false;
	const [y, m, d] = s.split("-").map(Number);
	const t = new Date(Date.UTC(y, m - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function dayPlus(day, n) {
	return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function monthAfter(month) {
	const [y, m] = month.split("-").map(Number);
	return m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// Only a finished week that touches an open month is checked: a later week has no
// invoices yet, and a closed month's figures are final. weekOf is the server's own
// week rule (getWeekRange()), so the check and the invoices agree on every week.
function checkWeekEnd({ weekEnd, weekOf, currentWeekStart, latestClosedMonth = "" }) {
	const refuse = (code, reason) => ({ refused: true, code, reason });
	if (!isDay(weekEnd)) return refuse(WEEK_REFUSALS.invalid, "weekEnd must be a day, as YYYY-MM-DD: the Friday that ends the last week to check.");
	const week = weekOf(weekEnd);
	if (!week || week.weekEnd !== weekEnd) {
		return refuse(WEEK_REFUSALS.invalid, `weekEnd must be a Friday, the last day of a Saturday-Friday week; ${weekEnd} is not one.`);
	}
	const lastFinishedWeekEnd = dayPlus(currentWeekStart, -1);
	if (weekEnd > lastFinishedWeekEnd) {
		return refuse(WEEK_REFUSALS.notFinished, `The week ending ${weekEnd} is not finished; the latest finished week ends ${lastFinishedWeekEnd}.`);
	}
	let firstOpenMonth = "";
	let rangeStart = "";
	if (latestClosedMonth) {
		// A month the lock table names that is no month closes everything: the
		// check then refuses every week rather than guess the open ones.
		firstOpenMonth = MONTH_RE.test(latestClosedMonth) ? monthAfter(latestClosedMonth) : "9999-12";
		const firstOpenDay = `${firstOpenMonth}-01`;
		const openWeek = isDay(firstOpenDay) ? weekOf(firstOpenDay) : null;
		if (!openWeek || weekEnd < firstOpenDay) {
			return refuse(WEEK_REFUSALS.closed, `The week ending ${weekEnd} lies wholly in closed months (the latest closed month is ${latestClosedMonth})`
				+ `${openWeek ? `; the earliest week to check ends ${openWeek.weekEnd}` : ""}.`);
		}
		rangeStart = openWeek.weekStart;
	}
	return { weekEnd, weekStart: week.weekStart, rangeStart, firstOpenMonth, latestClosedMonth, lastFinishedWeekEnd };
}

const one = (list) => (list && list.length === 1 ? list[0] : null);

// What warns against paying the day again, or puts it in a person's hands, comes
// before what made the invoice miss it: the first reason is the one acted on.
function ledgerDayReason(f) {
	const out = (reason, text) => ({ reason, text });
	const closedTail = f.settlesInClosedMonth ? `; its load settles in ${f.settlesInClosedMonth}, which is closed` : "";
	const deletedText = () => `${f.deletedDraft}, which named it, was deleted by a Super Admin, so it is not carried again automatically; a person decides`;
	if (f.mayBePaidBy) {
		return out("mayBePaid", `${f.mayBePaidBy.invoiceNumber} may already pay it (${f.mayBePaidBy.why}); a person decides${closedTail}`);
	}
	if (f.settlesInClosedMonth) {
		// The week's own warnings stay ahead of the closed month: each says not to pay it again.
		if (f.mayBePaid) return out("mayBePaid", `${f.mayBePaid}${closedTail}`);
		if (f.deletedDraft) return out("deletedDraft", `${deletedText()}${closedTail}`);
		return out("settlesInClosedMonth", `its load settles in ${f.settlesInClosedMonth}, which is closed, so the books count the day there; a person decides (an open-month correction)`);
	}
	const weekly = f.weekly || [];
	if (!weekly.length) {
		return out("noWeeklyInvoice", `the week of ${f.weekStart} to ${f.weekEnd} has no weekly invoice`
			+ (f.inDirectory ? "" : "; the driver matches no Drivers Database row, so the Friday batch makes no invoice for this driver"));
	}
	if (weekly.length > 1) {
		return out("twoWeeklyInvoices", `the week of ${f.weekStart} has ${weekly.length} weekly invoices (${weekly.map((w) => w.invoiceNumber).join(", ")}); delete the extra one`);
	}
	const inv = one(weekly).invoiceNumber;
	if (f.mayBePaid) return out("mayBePaid", f.mayBePaid);
	if (f.deletedDraft) return out("deletedDraft", deletedText());
	if (f.closedMonth) return out("closedMonth", `its own month, ${f.closedMonth}, is closed, so no invoice of its week can take it; a person decides (a missed day goes on an open-month correction)`);
	if (f.beforeFrom) return out("beforeFrom", `its load settles before TRIP_WORK_DAYS_FROM (${f.beforeFrom}), so the late-day settle does not carry it`);
	if (f.added) return out("addedAfterInvoice", `added on Driver Pay Overrides after ${inv} was made`);
	const load = f.load || { loadId: "", found: false };
	if (!load.found) return out("unexplained", `no known reason: its load ${load.loadId || "(none)"} is not a completed live load on Job Tracking now`);
	if (load.blankPickup) {
		return out("blankPickup", `its load ${load.loadId} has a blank Pickup Appointment: the books count it from the Assigned Date, the weekly invoice pays it no day`);
	}
	if (!load.billed) {
		if (!load.completed) return out("loadUndated", `its load ${load.loadId} has no Status Update Date or Completion Date, so no weekly invoice bills it`);
		if (load.completed > f.weekEnd) {
			return out("completedAfterInvoice", `its load ${load.loadId} was completed on ${load.completed}, in a later week; ${inv} bills only the loads completed in its own week`);
		}
		if (load.completed >= f.weekStart) return out("completedAfterInvoice", `its load ${load.loadId} was completed (${load.completed}) after ${inv} was made`);
		return out("unexplained", `no known reason: its load ${load.loadId} was completed on ${load.completed}, before this week, and ${inv} does not bill it`);
	}
	if (!load.inWindow) return out("unexplained", `no known reason: ${inv} bills load ${load.loadId}, but the day lies outside the invoice's window for it`);
	if (load.scopeNoEld) {
		return out("investorScopeNoEld", `the investor's books read no ELD for truck ${load.scopeNoEld} (another owner's truck), so they pay the load's whole window; `
			+ `${inv} read that truck's ELD and paid no driving that day`);
	}
	if (load.truckEld) return out("invoiceEldNoDriving", `${inv} bills load ${load.loadId}, but its ELD read showed no driving that day`);
	return out("unexplained", `no known reason: ${inv} bills load ${load.loadId} and its window holds the day, but the load's truck reports to no ELD`);
}

// Named, never taken back: an issued invoice keeps the day, and a person decides.
function invoiceDayReason(f) {
	const out = (reason, text) => ({ reason, text });
	const inv = f.invoiceNumber;
	const loads = f.loads || [];
	if (f.removeOverride) return out("removeOverride", `a "remove" on Driver Pay Overrides takes it out of the books; ${inv} paid it and stays as issued`);
	if (f.addedDay && !f.addStill) return out("addRemoved", `${inv} paid it as an added day, and Driver Pay Overrides no longer adds it`);
	if (loads.length && loads.every((l) => !l.live)) {
		return out("loadNotLive", `its load ${loads.map((l) => l.loadId).join(", ")} is no longer a completed live load on Job Tracking (cancelled, deleted or not delivered)`);
	}
	const blank = loads.find((l) => l.live && l.blankDropoff);
	if (blank) return out("blankDropoff", `its load ${blank.loadId} has a blank Drop-off Appointment: ${inv} paid to the completion date, the books stop at the pickup day`);
	const live = loads.find((l) => l.live);
	if (live) return out("ledgerLeavesOut", `the books' window or ELD read for load ${live.loadId} leaves the day out; ${inv} paid it`);
	return out("unexplained", `no known reason: ${inv} pays it and the books count it in no month`);
}

// A receipt driver no Drivers Database row names is said first: no weekly invoice
// can ever take that line; otherwise the screens' own words (personalCarryReason()).
function personalLineReason(f) {
	if (!f.inDirectory) {
		return { reason: "unknownDriver", text: "the receipt's driver matches no driver in the Drivers Database, so no weekly invoice takes the line" };
	}
	if (f.state === "carried") return { reason: "carried", text: f.wait ? f.wait.text : "carried to the driver's next weekly invoice with room" };
	if (f.state === "needs_correction") return { reason: "needsCorrection", text: "waits for its week's correction invoice, which a Super Admin creates" };
	return { reason: "pending", text: f.wait ? f.wait.reason : "waits for its week's weekly invoice" };
}

// A load a manual invoice names may be billed already, so that is said first.
function percentageLoadReason(f) {
	if (f.mayBeBilledBy) return { reason: "mayBeBilled", text: `${f.mayBeBilledBy} names it, so it may already be billed; a person decides` };
	if (!f.completed) return { reason: "loadUndated", text: "it has no Status Update Date or Completion Date, so no weekly invoice bills it" };
	const weekly = f.weekly || [];
	if (!weekly.length) return { reason: "noWeeklyInvoice", text: `the week of ${f.weekStart} has no weekly invoice` };
	return {
		reason: "completedAfterInvoice",
		text: `it was completed (${f.completed}) after ${weekly.map((w) => w.invoiceNumber).join(", ")} was made; a weekly invoice bills only the loads completed when it is made`,
	};
}

function byReason(list) {
	const counts = {};
	for (const x of list) counts[x.reason] = (counts[x.reason] || 0) + 1;
	return Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
}

const sumCents = (list, key) => list.reduce((c, x) => c + (Number.isInteger(x[key]) ? x[key] : 0), 0);

// Labels ("driver N", numbered in key order) keep names out of a script's report
// unless asked for; totals are summed here from the items so they always agree.
function shapeCheck({ scope, names = false, sections, rules = {}, generatedAt = "" }) {
	const keys = new Set();
	const nameOf = new Map();
	for (const k of SECTIONS) {
		for (const it of sections[k] || []) {
			const key = it.driverKey || "";
			keys.add(key);
			if (!nameOf.has(key) && it.driverName) nameOf.set(key, it.driverName);
		}
	}
	const order = [...keys].sort();
	const rank = new Map(order.map((k, i) => [k, i]));
	const shown = (key) => (names ? nameOf.get(key) || key || "(no driver)" : `driver ${rank.get(key) + 1}`);
	const sortKey = (it) => [it.weekStart || "", it.day || it.date || it.completed || "", String(it.lineId ?? it.expenseId ?? it.invoiceNumber ?? it.loadId ?? "")];
	const out = {};
	for (const k of SECTIONS) {
		out[k] = [...(sections[k] || [])]
			.sort((a, b) => {
				const r = rank.get(a.driverKey || "") - rank.get(b.driverKey || "");
				if (r) return r;
				const x = sortKey(a);
				const y = sortKey(b);
				for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
				return 0;
			})
			.map(({ driverKey, driverName, ...rest }) => ({ driver: shown(driverKey || ""), ...rest }));
	}

	// Per driver and week: each section's count and, for the five sections that
	// hold pay, deductions or receipts, their cents. A percentage driver's loads
	// carry revenue, not pay, so their sum has a key of its own.
	const PAY_SECTIONS = SECTIONS.filter((s) => s !== "percentageLoads");
	const weeks = new Map();
	for (const k of SECTIONS) {
		for (const it of sections[k] || []) {
			const key = it.driverKey || "";
			const ws = it.weekStart || "";
			const id = `${key}\t${ws}`;
			if (!weeks.has(id)) {
				weeks.set(id, {
					key, weekStart: ws, weekEnd: isDay(ws) ? dayPlus(ws, 6) : "",
					counts: Object.fromEntries(SECTIONS.map((s) => [s, 0])), cents: Object.fromEntries(PAY_SECTIONS.map((s) => [s, 0])), percentageRevenueCents: 0,
				});
			}
			const w = weeks.get(id);
			w.counts[k] += 1;
			if (k === "percentageLoads") w.percentageRevenueCents += Number.isInteger(it.paymentCents) ? it.paymentCents : 0;
			else if (Number.isInteger(it.cents)) w.cents[k] += it.cents;
		}
	}
	const drivers = order.map((key) => ({
		driver: shown(key),
		weeks: [...weeks.values()].filter((w) => w.key === key).sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0))
			.map(({ key: _k, ...w }) => w),
	}));

	const summary = {
		ledgerDays: { count: out.ledgerDays.length, cents: sumCents(out.ledgerDays, "cents"), byReason: byReason(out.ledgerDays) },
		invoiceDays: { count: out.invoiceDays.length, cents: sumCents(out.invoiceDays, "cents"), byReason: byReason(out.invoiceDays) },
		personalLines: { count: out.personalLines.length, cents: sumCents(out.personalLines, "cents"), byReason: byReason(out.personalLines) },
		pendingReceipts: { count: out.pendingReceipts.length, cents: sumCents(out.pendingReceipts, "cents") },
		correctionDrafts: { count: out.correctionDrafts.length, cents: sumCents(out.correctionDrafts, "cents") },
		percentageLoads: { count: out.percentageLoads.length, paymentCents: sumCents(out.percentageLoads, "paymentCents"), byReason: byReason(out.percentageLoads) },
	};
	return {
		weekEnd: scope.weekEnd, weekStart: scope.weekStart, rangeStart: scope.rangeStart, latestClosedMonth: scope.latestClosedMonth,
		firstOpenMonth: scope.firstOpenMonth, lastFinishedWeekEnd: scope.lastFinishedWeekEnd, rules,
		...out, drivers, summary, generatedAt,
	};
}

module.exports = {
	SECTIONS, WEEK_REFUSALS, isDay, dayPlus, checkWeekEnd,
	ledgerDayReason, invoiceDayReason, personalLineReason, percentageLoadReason, shapeCheck,
};
