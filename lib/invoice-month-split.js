// One driver invoice's share of each month in the Financials driver table
// (money plan C, 2026-10-15, decisions C-D1 to C-D4). A weekly invoice's
// Saturday-to-Friday week can span two months; the table once counted the whole
// invoice in both. Here each part of the invoice counts in one month only, so
// the months' shares add up to the invoice's invoiced amount exactly (earnings,
// adjustment and an owner-operator's returned Personal share: the table's
// "Invoiced", which never subtracts what a driver repays on Personal lines):
//
//   - a paid day (the invoice's own days: server.js invoicePaidDaysOf()) counts
//     in the month the Financials books count that driver-day in (a closed
//     month's frozen items, an open month's live ledger); the caller's
//     booksMonthOf() answers the earliest month when the books count it in two;
//     a day the books do not pay counts in its own calendar month (C-D1);
//   - an owner-operator invoice (no day grid) splits its earnings across its
//     loads by each load's rate, each load's part in the month the books count
//     that load's revenue in (loadMonthOf()), else in the month of the date the
//     invoice records for the load, else in week_end's month;
//   - an invoice with neither days nor loads is prorated by the calendar days of
//     its period in each month (C-D3);
//   - the adjustment, an owner-operator's returned Personal share and any gap
//     between the days' amounts and total_earnings count once, in week_end's
//     month, as named parts (`unsplit`), never spread as rounding (C-D2).
// Prorated cents are rounded cumulatively, so the parts add up to the amount
// exactly and, for a period in two months, the rounding lands in the later one.
//
// Display only: no figure here is written anywhere, and nothing reads it for
// pay, payouts or a closed month's settled figures. Pure: no database, network
// or file access.

"use strict";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_MS = 86400000;
// A period longer than this is not prorated by day (no real invoice has one).
const MAX_CALENDAR_DAYS = 400;

function toCents(x) {
	const n = Number(x);
	return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
function isDay(s) {
	return typeof s === "string" && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
}
function monthOfDay(s) {
	return isDay(s) ? s.slice(0, 7) : "";
}
function validMonth(mk) {
	return typeof mk === "string" && MONTH_RE.test(mk) ? mk : "";
}
function snapshotOf(renderData) {
	if (renderData && typeof renderData === "object") return renderData;
	try {
		const snap = JSON.parse(renderData || "{}");
		return snap && typeof snap === "object" ? snap : {};
	} catch {
		return {};
	}
}

// The calendar days from `from` to `to`, both included ([] when either is not a
// date, they are out of order, or the period is longer than MAX_CALENDAR_DAYS).
function calendarDays(from, to) {
	if (!isDay(from) || !isDay(to) || from > to) return [];
	const end = Date.parse(`${to}T12:00:00Z`);
	const out = [];
	for (let ms = Date.parse(`${from}T12:00:00Z`); ms <= end; ms += DAY_MS) {
		if (out.length >= MAX_CALENDAR_DAYS) return [];
		out.push(new Date(ms).toISOString().slice(0, 10));
	}
	return out;
}

// `total` cents across `weights` (non-negative), rounded cumulatively: the parts
// add up to `total` exactly and none moves more than a cent from its exact share.
function prorate(total, weights) {
	const sum = weights.reduce((s, w) => s + w, 0);
	if (!(sum > 0)) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
	const out = [];
	let cum = 0;
	let given = 0;
	for (const w of weights) {
		cum += w;
		const upTo = Math.round((total * cum) / sum);
		out.push(upTo - given);
		given = upTo;
	}
	return out;
}

// An owner-operator invoice's loads ({ loadId, date, weight in cents }), or null
// when it is no owner-operator invoice or its loads carry no positive rate.
function ownerOperatorLoads(snap) {
	if (!snap || snap.__templateName !== "service_invoice_owner_op" || !Array.isArray(snap.loads) || !snap.loads.length) return null;
	const loads = snap.loads.map((l) => ({
		loadId: String((l && l.loadId) || "").trim(),
		date: String((l && l.date) || "").trim(),
		weight: Math.max(0, toCents(l && l.rate)),
	}));
	return loads.some((l) => l.weight > 0) ? loads : null;
}

// invoice: { driver, week_start, week_end, total_earnings, adjustment,
//   personal_share_total, render_data (the stored text or the parsed snapshot) }.
// paidDays: the days the invoice pays (YYYY-MM-DD). dayAmount(day): that day's
// amount in dollars. booksMonthOf(driver, day): the month the books count the
// driver-day in, "" when they do not pay it. loadMonthOf(loadId): the month the
// books count the load's revenue in, "". correctionLines: the correction lines
// it carries ({ kind, line_date, cents }): a day or rate line is an invoiced
// day, in the month the books count its driver-day in, else its own month
// (C-D1); an amount line counts in week_end's month as a named part (C-D2).
// Returns {
//   invoicedCents  total_earnings + adjustment + personal_share_total + its
//                  correction lines, in cents
//   shares         { "YYYY-MM": cents }, the months holding a part (at least one)
//   months         the shares' months, sorted
//   split          true when more than one month holds a part
//   method         "days" | "loads" | "calendar" | "whole" (no readable period)
//   unsplit        { month, adjustmentCents, personalShareCents, gapCents }
//   parts          [{ kind, month, cents, day | loadId | days }], every part
// }
// The shares add up to invoicedCents exactly. An invoice of $0 counts, at $0, in
// week_end's month.
function invoiceMonthShares(invoice, { paidDays = [], dayAmount = () => 0, booksMonthOf = () => "", loadMonthOf = () => "", correctionLines = [] } = {}) {
	const inv = invoice || {};
	const snap = snapshotOf(inv.render_data);
	const weekStart = isDay(inv.week_start) ? inv.week_start : "";
	const weekEnd = isDay(inv.week_end) ? inv.week_end : "";
	const lastMonth = monthOfDay(weekEnd) || monthOfDay(weekStart);
	const earnedCents = toCents(inv.total_earnings);
	const adjustmentCents = toCents(inv.adjustment);
	const personalShareCents = toCents(inv.personal_share_total);
	const parts = [];
	let method;
	let gapCents = 0;

	const days = [...new Set((Array.isArray(paidDays) ? paidDays : []).filter(isDay))].sort();
	const loads = days.length ? null : ownerOperatorLoads(snap);
	if (days.length) {
		method = "days";
		let dayTotal = 0;
		for (const day of days) {
			const cents = toCents(dayAmount(day));
			dayTotal += cents;
			parts.push({ kind: "day", day, month: validMonth(booksMonthOf(inv.driver, day)) || monthOfDay(day), cents });
		}
		gapCents = earnedCents - dayTotal;
	} else if (loads) {
		method = "loads";
		const alloc = prorate(earnedCents, loads.map((l) => l.weight));
		loads.forEach((l, i) => {
			const month = validMonth(l.loadId ? loadMonthOf(l.loadId) : "") || monthOfDay(l.date) || lastMonth;
			parts.push({ kind: "load", loadId: l.loadId, month, cents: alloc[i] });
		});
	} else {
		const cal = calendarDays(weekStart, weekEnd);
		if (cal.length) {
			method = "calendar";
			const counts = new Map();
			for (const d of cal) counts.set(d.slice(0, 7), (counts.get(d.slice(0, 7)) || 0) + 1);
			const months = [...counts.keys()];
			const alloc = prorate(earnedCents, months.map((m) => counts.get(m)));
			months.forEach((m, i) => parts.push({ kind: "calendar", month: m, days: counts.get(m), cents: alloc[i] }));
		} else {
			method = "whole";
			parts.push({ kind: "whole", month: lastMonth, cents: earnedCents });
		}
	}
	for (const [kind, cents] of [["adjustment", adjustmentCents], ["personal_share", personalShareCents], ["gap", gapCents]]) {
		if (cents) parts.push({ kind, month: lastMonth, cents, unsplit: true });
	}
	let correctionCents = 0;
	let correctionAmountCents = 0;
	for (const l of Array.isArray(correctionLines) ? correctionLines : []) {
		const cents = Math.round(Number(l && l.cents) || 0);
		if (!cents) continue;
		correctionCents += cents;
		if (l.kind === "day" || l.kind === "rate") {
			const day = isDay(l.line_date) ? l.line_date : "";
			parts.push({ kind: `correction_${l.kind}`, day, month: validMonth(day ? booksMonthOf(inv.driver, day) : "") || monthOfDay(day) || lastMonth, cents });
		} else {
			correctionAmountCents += cents;
			parts.push({ kind: "correction_amount", month: lastMonth, cents, unsplit: true });
		}
	}

	const sums = new Map();
	for (const p of parts) {
		if (!p.cents) continue;
		sums.set(p.month, (sums.get(p.month) || 0) + p.cents);
	}
	if (!sums.size) sums.set(lastMonth, 0);
	const months = [...sums.keys()].sort();
	const shares = {};
	for (const m of months) shares[m] = sums.get(m);
	return {
		invoicedCents: earnedCents + adjustmentCents + personalShareCents + correctionCents,
		shares,
		months,
		split: months.length > 1,
		method,
		unsplit: { month: lastMonth, adjustmentCents, personalShareCents, gapCents, ...(correctionAmountCents ? { correctionAmountCents } : {}) },
		parts,
	};
}

// The driver table's invoice columns for `month`, from invoiceMonthShares()
// results that also carry `driver` (the driver's key): per driver, the invoices
// holding a share of the month (count), their shares (invoicedCents), the
// adjustments among them (adjustmentCents: an adjustment counts in its
// week_end's month only) and how many of them are split with another month
// (splitCount). Keyed by driver, into `out` (the caller's null-prototype map, or
// a new one); a row with no driver is skipped. Returns `out`.
function monthInvoiceTotals(rows, month, out = Object.create(null)) {
	for (const r of rows || []) {
		if (!r || !r.driver || !r.shares || !Object.prototype.hasOwnProperty.call(r.shares, month)) continue;
		if (!out[r.driver]) out[r.driver] = { count: 0, invoicedCents: 0, adjustmentCents: 0, splitCount: 0 };
		const e = out[r.driver];
		e.count += 1;
		e.invoicedCents += r.shares[month];
		if (r.unsplit && r.unsplit.month === month) e.adjustmentCents += r.unsplit.adjustmentCents;
		if (r.split) e.splitCount += 1;
	}
	return out;
}

module.exports = { invoiceMonthShares, monthInvoiceTotals, prorate, calendarDays, MAX_CALENDAR_DAYS };
