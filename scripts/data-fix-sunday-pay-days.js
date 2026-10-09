#!/usr/bin/env node
// scripts/data-fix-sunday-pay-days.js — corrects a Sunday that was paid as a
// driver-pay day although it was not one, in a month that is already closed.
//
// The closed month stays exactly as recorded. The correction is posted on the
// open month that follows, as two lines, each through the column its own screen
// and route write:
//   1. the driver's pay: an adjustment on his earliest weekly invoice for a week
//      inside that month that is still Draft or Submitted (invoices.adjustment,
//      the column PUT /api/invoices/:id/adjust sets; the PDF Total Due, the
//      Invoices screen and the payment report read total_earnings + adjustment);
//   2. the investor's payout: an adjustment on the investor's payout row for that
//      month (investor_payouts.adjustment, the column PUT
//      /api/investor/payouts/:id/adjust sets; effective payout = amount +
//      adjustment, which the Payouts console, the investor portal and the
//      statement read), with its investor_payout_history row.
// Each line gets one audit_trail row as a system change, named after this
// script, with the route's own action name.
//
// Amounts are replayed, never assumed:
//   - the driver line is minus what the day was billed, read from the invoice's
//     stored day line (render_data) and from the closed month's frozen ledger
//     item for that driver-day; the two must agree;
//   - the investor line is the payout the closed month settled at, recomputed by
//     lib/investor-payout-basis.js (settleInvestorMonths(), its rounding and its
//     loss carry-forward) from the frozen line items with that one driver-pay day
//     removed, minus the payout recomputed with it. The replay must first
//     reproduce the settled row exactly, from items the month's own close froze
//     with no Settlement adjustment among them.
// Anything uncertain is skipped and said: amounts that disagree, a source
// invoice or settled payout that already carries an adjustment (the day may
// have been corrected by hand), a replay that does not reproduce the
// settlement, a missing or closed target, a target that already carries an
// adjustment this script did not write, a settled target, a Total Due that
// would go below $0. A line whose home does not exist yet is skipped with when
// to re-run; this script never creates an invoice or a payout row.
//
// Only an approved case applies: each case says whether the owner approved it,
// and changing that is a reviewed change to this file. An unapproved case runs
// its dry run only. Applying also needs --approval naming the case's decision.
//
// Idempotent: each line carries its reference (for example "Ref SPD-20260927")
// in its adjustment note and a token in its audit row; a line already applied
// is reported and never written again. All writes of one run are one SQLite
// transaction. The closed-month triggers of server.js are installed on this
// script's connection as a floor under its own checks; if they cannot be
// installed, nothing is written.
//
// It reads and writes SQLite only: no Google Sheets, no network, no .env. The
// invoice PDF is not re-rendered (that needs the server's renderer); the output
// says how to bring the PDF in line from the Invoices screen.
//
// Usage (on the server, from the app directory, with the Node pm2 runs it with):
//   node scripts/data-fix-sunday-pay-days.js --day 2026-09-27 --dry-run [--db=app.db]
//   node scripts/data-fix-sunday-pay-days.js --day 2026-09-27 --approval C1 [--db=app.db]
//   --day        one of the cases listed in CASES below; any other day is refused
//   --dry-run    opens the database read-only, prints what it would write
//   --approval   required to apply: the case's decision (C1, C2), recorded in
//                the audit rows
//   --db         default: app.db next to server.js. The database must be this
//                app directory's own or a copy under the temp directory.
// Exit codes: 0 done (written or skipped, as printed), 1 error (nothing
// written), 2 refused (nothing written).
//
// Required as a module (by its test runner) it runs nothing and exports its
// parts.

"use strict";

const fs = require("fs");
const path = require("path");
const { dbScope } = require("./lib/ledger-world");
const { closure } = require("./lib/server-lift");
const financialsCalc = require("../lib/financials-calc");
const investorPayoutBasis = require("../lib/investor-payout-basis");

const ROOT = path.join(__dirname, "..");
const ACTOR = "script:data-fix-sunday-pay-days";
// Both adjust routes keep the first 500 characters of a note and refuse more
// than $10,000 either way.
const NOTE_MAX = 500;
const ADJUST_CAP_CENTS = 1000000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// The invoice template's week: Saturday to Friday.
const INVOICE_WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const FIGURE_LABELS = [
	["revenue", "revenue"], ["driverPay", "driver pay"], ["fixedCosts", "fixed costs"],
	["tripExpenses", "trip expenses"], ["maintFundCost", "maintenance fund"], ["complianceCost", "compliance"],
];
// A line's token in its audit row. The target is the invoice number (driver)
// or "<owner id>:<period>" (investor).
const TOKEN_RE = /\[(SPD-\d{8}) (driver|investor) ([+-]\d+\.\d{2}) ([^\]\s]+)\]/g;

// The listed, explained cases. The driver is not named here (this repository is
// public): it is read from the source invoice, and the ledger day must be the
// same driver's. `approved` is the owner's decision; only an approved case
// applies, and marking one approved is a reviewed change to this file.
const CASES = Object.freeze({
	"2026-09-27": Object.freeze({
		ref: "SPD-20260927",
		approval: "C1",
		approved: true,
		approvalStatus: "decision C1, approved by the owner",
		sourceMonth: "2026-09",
		targetMonth: "2026-10",
		sourceInvoice: "INV-SK-2026W39-01",
		invoiceLoads: Object.freeze(["569820951"]),
		ledgerLoad: "569820951",
		truck: "Logisx-#91",
		ownerId: 5,
		why: "Load 569820951's stored Pickup Appointment is Sunday 9/27, but it was dispatched Monday 9/28.",
		noteWhy: "load 569820951 was dispatched Monday 9/28",
		loadsDiffer: "",
	}),
	"2026-09-13": Object.freeze({
		ref: "SPD-20260913",
		approval: "C2",
		approved: false,
		approvalStatus: "decision C2, not approved as of 2026-10-09: dry run only. Applying it needs a reviewed change to this script that marks C2 approved",
		sourceMonth: "2026-09",
		targetMonth: "2026-10",
		sourceInvoice: "INV-SK-2026W37-01",
		invoiceLoads: Object.freeze(["567844619"]),
		ledgerLoad: "567484733",
		truck: "Logisx-#91",
		ownerId: 5,
		why: "Loads 567484733 and 567844619 have a stored Pickup Appointment of Sunday 9/13, but were dispatched Monday 9/14 and Tuesday 9/15.",
		noteWhy: "its loads were dispatched Monday 9/14 and Tuesday 9/15",
		loadsDiffer: "The invoice's Sunday line names load 567844619 and the frozen ledger's day names load 567484733. Both loads have a stored pickup of Sunday 9/13 and both are on the invoice: the invoice lists the loads it billed that day, the ledger names the first load in the sheet that claimed the day. It is one driver-day, paid once on each side.",
	}),
});

// A refusal: nothing was written, exit 2.
class Refusal extends Error {}

// ---------------------------------------------------------------- helpers

const normalizeName = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const toCents = (dollars) => Math.round(Number(dollars || 0) * 100);

function grouped(n) {
	const digits = String(n);
	let out = "";
	for (let i = 0; i < digits.length; i++) {
		if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
		out += digits[i];
	}
	return out;
}

// "+$1,234.56" / "-$300.00": every amount signed, two decimals, grouped by hand
// so no locale can change it.
function usd(cents) {
	const c = Math.round(cents);
	const abs = Math.abs(c);
	return `${c < 0 ? "-" : "+"}$${grouped(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

// An intermediate share before rounding, to three decimals ("+$5,046.105").
function usd3(dollars) {
	const mills = Math.round(dollars * 1000);
	const abs = Math.abs(mills);
	return `${mills < 0 ? "-" : "+"}$${grouped(Math.floor(abs / 1000))}.${String(abs % 1000).padStart(3, "0")}`;
}

// A plain amount for a note or an audit line, unsigned ("300.00"), or signed
// with the routes' own two-decimal shape ("-300.00").
const plain = (cents) => (Math.abs(Math.round(cents)) / 100).toFixed(2);
const signed2 = (cents) => `${cents < 0 ? "-" : "+"}${plain(cents)}`;
// For a note a person reads: "+$150.00" (no grouping, as an admin would type it).
const signedDollars = (cents) => `${cents < 0 ? "-" : "+"}$${plain(cents)}`;

function weekdayOf(day) {
	const [y, m, d] = day.split("-").map(Number);
	return WEEKDAYS[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}
function daysBetween(a, b) {
	const t = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d, 12); };
	return Math.round((t(b) - t(a)) / 86400000);
}
function addDays(day, n) {
	const [y, m, d] = day.split("-").map(Number);
	const x = new Date(Date.UTC(y, m - 1, d + n, 12));
	return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}
const shortDate = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}/${day.slice(0, 4)}`;
const monthDay = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
function monthLabel(month) {
	const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	return `${names[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}
function lastDayOf(month) {
	const [y, m] = month.split("-").map(Number);
	return addDays(`${month}-01`, new Date(Date.UTC(y, m, 0, 12)).getUTCDate() - 1);
}
// The first Saturday on or after the 1st: the first invoice week inside the month.
function firstInvoiceWeek(month) {
	let d = `${month}-01`;
	while (weekdayOf(d) !== "Saturday") d = addDays(d, 1);
	return { start: d, end: addDays(d, 6) };
}
// server.js graceEndsAt(): the last day a month's books stay open.
function graceEndsAt(month, days) {
	return addDays(lastDayOf(month), Math.max(0, Number(days) || 0));
}
const payoutTarget = (ownerId, period) => `${ownerId}:${period}`;

// --day/--db/--approval take a value (--flag=value or --flag value); --dry-run
// and --help take none. Anything else is refused, so a mistyped --dry-run can
// never fall through to an apply.
function parseCli(argv) {
	const VALUE = new Set(["day", "db", "approval"]);
	const BOOL = new Set(["dry-run", "help"]);
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
		const eq = a.indexOf("=");
		const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
		if (BOOL.has(name)) {
			if (eq !== -1) throw new Error(`--${name} takes no value`);
			out[name] = true;
		} else if (VALUE.has(name)) {
			const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
			if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`--${name} needs a value`);
			out[name] = value;
		} else {
			throw new Error(`unknown option --${name}`);
		}
	}
	return out;
}

// ---------------------------------------------------------------- the database's facts

function lockStatus(db, month) {
	const row = db.prepare("SELECT status, finalized_at FROM period_locks WHERE period = ?").get(month);
	return row || null;
}
function locksReadable(db) {
	try { db.prepare("SELECT status FROM period_locks WHERE period = ?").get("1970-01"); return true; } catch { return false; }
}

function graceDays(db) {
	try {
		const row = db.prepare("SELECT value FROM investor_config WHERE owner_id = 0 AND key = 'settlement_grace_days'").get();
		const n = parseInt(row && row.value, 10);
		if (Number.isFinite(n)) return Math.min(28, Math.max(0, n));
	} catch { /* the server's default */ }
	return 7;
}

// The lines this script has applied: its own audit rows' tokens.
function ownLines(db) {
	const rows = db.prepare(
		"SELECT id, timestamp, action, entity, entity_id, details FROM audit_trail WHERE username = ? AND user_id = 0 AND role = 'system' ORDER BY id"
	).all(ACTOR);
	const out = [];
	for (const r of rows) {
		for (const m of String(r.details || "").matchAll(TOKEN_RE)) {
			out.push({ auditId: r.id, timestamp: r.timestamp, ref: m[1], kind: m[2], cents: Math.round(Number(m[3]) * 100), target: m[4] });
		}
	}
	return out;
}

const dayOfRef = (ref) => `${ref.slice(4, 8)}-${ref.slice(8, 10)}-${ref.slice(10, 12)}`;

// The rate on record for a subject on a day: the latest row on or before it,
// else the earliest row (recording began after the day; the seed is the rate
// in force when it began). Informational only.
function rateOnRecord(db, subject, key, day) {
	try {
		const rows = db.prepare("SELECT rate, effective_from, source FROM pay_rate_history WHERE subject = ? AND subject_key = ? ORDER BY effective_from, id").all(subject, key);
		if (!rows.length) return null;
		const before = rows.filter((r) => String(r.effective_from).slice(0, 10) <= day);
		return before.length ? { ...before[before.length - 1], seeded: false } : { ...rows[0], seeded: true };
	} catch {
		return null;
	}
}

// The day as billed on the source invoice, and as paid in the frozen ledger;
// and whether either side already carries a correction.
function readEvidence(db, day, kase) {
	const ev = { problems: [], notes: [] };
	const weekday = weekdayOf(day);
	if (weekday !== "Sunday") ev.problems.push(`${day} is a ${weekday}, not a Sunday.`);

	// The closed month's payout row, read here so a correction already on it
	// stops both lines.
	ev.sourcePayout = db.prepare("SELECT id, amount, adjustment, adjustment_note, adjusted_by FROM investor_payouts WHERE owner_id = ? AND period = ?").get(kase.ownerId, kase.sourceMonth) || null;
	if (ev.sourcePayout && toCents(ev.sourcePayout.adjustment) !== 0) {
		ev.problems.push(`${monthLabel(kase.sourceMonth)}'s payout row ${ev.sourcePayout.id} for investor ${kase.ownerId} already carries an adjustment of ${usd(toCents(ev.sourcePayout.adjustment))}` +
			` (note: ${JSON.stringify(ev.sourcePayout.adjustment_note || "")}, by ${ev.sourcePayout.adjusted_by || "unknown"}): the day may already have been corrected by hand.`);
	}

	const invoices = db.prepare(
		`SELECT id, invoice_number, driver, week_start, week_end, status, paid_at, total_earnings, rate_per_load, adjustment, adjustment_note, adjusted_by, load_ids, render_data, deleted_at
		   FROM invoices WHERE is_manual = 0 AND invoice_number = ?`
	).all(kase.sourceInvoice);
	if (invoices.length !== 1) {
		ev.problems.push(`expected one weekly invoice ${kase.sourceInvoice}, found ${invoices.length}.`);
		return ev;
	}
	const inv = invoices[0];
	ev.invoice = inv;
	ev.driverKey = normalizeName(inv.driver);
	if (String(inv.deleted_at || "").trim()) ev.problems.push(`${kase.sourceInvoice} is deleted (${inv.deleted_at}); what was billed for the day is not certain.`);
	if (inv.status === "Rejected") ev.problems.push(`${kase.sourceInvoice} is Rejected, so the day may never have been paid on it.`);
	if (toCents(inv.adjustment) !== 0) {
		ev.problems.push(`${kase.sourceInvoice} already carries an adjustment of ${usd(toCents(inv.adjustment))}` +
			` (note: ${JSON.stringify(inv.adjustment_note || "")}, by ${inv.adjusted_by || "unknown"}): the day may already have been corrected by hand.`);
	}
	if (!(inv.week_start <= day && day <= inv.week_end)) {
		ev.problems.push(`${kase.sourceInvoice} bills ${inv.week_start} to ${inv.week_end}, which does not include ${day}.`);
		return ev;
	}
	const sameWeek = db.prepare(
		"SELECT id, invoice_number, driver FROM invoices WHERE deleted_at = '' AND is_manual = 0 AND week_start <= ? AND week_end >= ?"
	).all(day, day).filter((r) => normalizeName(r.driver) === ev.driverKey);
	if (sameWeek.length !== 1 || sameWeek[0].invoice_number !== kase.sourceInvoice) {
		ev.problems.push(`the driver has ${sameWeek.length} live weekly invoices covering ${day} (${sameWeek.map((r) => r.invoice_number).join(", ") || "none"}); expected only ${kase.sourceInvoice}.`);
	}
	let render = null;
	try { render = JSON.parse(inv.render_data || "null"); } catch { render = null; }
	const offset = daysBetween(inv.week_start, day);
	if (weekdayOf(inv.week_start) !== "Saturday" || offset < 0 || offset > 6) {
		ev.problems.push(`${kase.sourceInvoice}'s week does not start on a Saturday; its day lines cannot be read by name.`);
		return ev;
	}
	const days = render && render.days && typeof render.days === "object" ? render.days : null;
	if (!days) {
		ev.problems.push(`${kase.sourceInvoice} has no stored day lines (render_data.days).`);
		return ev;
	}
	const line = days[INVOICE_WEEK[offset]];
	if (!line || typeof line !== "object") {
		ev.problems.push(`${kase.sourceInvoice} has no ${INVOICE_WEEK[offset]} line.`);
		return ev;
	}
	ev.dayCents = toCents(line.total);
	ev.dayLoads = String(line.loadBol || "").split(",").map((s) => s.trim()).filter(Boolean);
	if (!line.completed || !(ev.dayCents > 0)) ev.problems.push(`${kase.sourceInvoice}'s ${weekday} line bills nothing (completed ${!!line.completed}, total ${usd(ev.dayCents || 0)}).`);
	const missingLoads = kase.invoiceLoads.filter((l) => !ev.dayLoads.includes(l));
	if (missingLoads.length || ev.dayLoads.length !== kase.invoiceLoads.length) {
		ev.problems.push(`${kase.sourceInvoice}'s ${weekday} line names load(s) ${ev.dayLoads.join(", ") || "none"}; this case expects ${kase.invoiceLoads.join(", ")}.`);
	}
	const sumCents = INVOICE_WEEK.reduce((s, name) => s + toCents(days[name] && days[name].total), 0);
	ev.totalCents = toCents(inv.total_earnings);
	if (sumCents !== ev.totalCents) ev.problems.push(`${kase.sourceInvoice}'s day lines add up to ${usd(sumCents)}, not its total earnings ${usd(ev.totalCents)}.`);
	ev.rateCents = toCents(inv.rate_per_load);
	if (ev.rateCents !== ev.dayCents) ev.problems.push(`${kase.sourceInvoice}'s daily rate is ${usd(ev.rateCents)} but its ${weekday} line bills ${usd(ev.dayCents)}.`);
	let loadIds = [];
	try { loadIds = JSON.parse(inv.load_ids || "[]").map((x) => String(x).replace(/^#/, "").trim()); } catch { loadIds = []; }
	for (const l of new Set([...kase.invoiceLoads, kase.ledgerLoad])) {
		if (!loadIds.includes(l)) ev.problems.push(`load ${l} is not among ${kase.sourceInvoice}'s loads.`);
	}

	const freezes = db.prepare("SELECT freeze_id, source, frozen_at FROM financials_ledger_freezes WHERE period = ? AND released_at = ''").all(kase.sourceMonth);
	if (freezes.length !== 1) {
		ev.problems.push(`${monthLabel(kase.sourceMonth)} has ${freezes.length} active ledger freezes; expected one.`);
		return ev;
	}
	ev.freeze = freezes[0];
	// Only the month's own close freezes the items it settled from. Any other
	// freeze (the one-time freeze of months closed before the ledger existed) was
	// taken later from a recompute, so its items say nothing certain about what
	// was paid.
	if (ev.freeze.source !== "close") {
		ev.problems.push(`${monthLabel(kase.sourceMonth)}'s ledger was frozen by "${ev.freeze.source}", not by the month's own close, so its items are a later recompute rather than what settled.`);
	}
	const items = db.prepare(
		`SELECT id, owner_id, kind, day, cents, load_id, driver, truck, pay_type, freeze_id FROM financials_ledger_items
		  WHERE period = ? AND freeze_id = ? AND kind = 'driver_pay' AND day = ?`
	).all(kase.sourceMonth, ev.freeze.freeze_id, day).filter((i) => normalizeName(i.driver) === ev.driverKey);
	if (items.length !== 1) {
		ev.problems.push(`the frozen ${monthLabel(kase.sourceMonth)} ledger holds ${items.length} driver-pay items for this driver on ${day}; expected one.`);
		return ev;
	}
	const item = items[0];
	ev.item = item;
	if (item.pay_type !== "fixed") ev.problems.push(`ledger item ${item.id} is ${item.pay_type || "unknown"} pay, not a fixed day.`);
	if (item.owner_id !== kase.ownerId) ev.problems.push(`ledger item ${item.id} belongs to owner ${item.owner_id}, not owner ${kase.ownerId}.`);
	if (item.truck !== kase.truck) ev.problems.push(`ledger item ${item.id} names truck ${item.truck || "none"}, not ${kase.truck}.`);
	if (String(item.load_id) !== kase.ledgerLoad) ev.problems.push(`ledger item ${item.id} names load ${item.load_id || "none"}; this case expects ${kase.ledgerLoad}.`);
	if (item.cents !== ev.dayCents) ev.problems.push(`the amounts disagree: ${kase.sourceInvoice} bills the day at ${usd(ev.dayCents)}, the frozen ledger pays it ${usd(item.cents)}.`);

	const truck = (() => {
		try { return db.prepare("SELECT id, owner_id FROM trucks WHERE unit_number = ?").get(kase.truck) || null; } catch { return null; }
	})();
	if (truck && truck.owner_id !== kase.ownerId) ev.notes.push(`truck ${kase.truck} belongs to owner ${truck.owner_id} today (owner ${kase.ownerId} on the frozen ledger).`);
	ev.rates = {
		driver: rateOnRecord(db, "driver", ev.driverKey, day),
		truck: truck ? rateOnRecord(db, "truck", String(truck.id), day) : null,
	};
	return ev;
}

// ---------------------------------------------------------------- the settlement replay

function settleMonth(items, month, splitFraction, deficitIn) {
	const figures = financialsCalc.monthFiguresFromItems(items.map((i) => ({ kind: i.kind, adjusts: i.adjusts, month, cents: i.cents })))[month]
		|| { revenue: 0, driverPay: 0, fixedCosts: 0, tripExpenses: 0, maintFundCost: 0, complianceCost: 0, netProfit: 0 };
	// A known deficit carried in is fed to the payout function as the month
	// before with that loss, so its own carry walk applies it.
	const months = [];
	const frozenShares = new Map();
	if (deficitIn > 0) {
		const before = investorPayoutBasis.addMonths(month, -1);
		months.push({ month: before, netProfit: 0, zeroActivity: false });
		frozenShares.set(before, -deficitIn);
	}
	months.push({ month, netProfit: figures.netProfit, zeroActivity: false });
	const s = investorPayoutBasis.settleInvestorMonths(months, { splitFraction, basis: null, frozenShares })[month];
	return {
		figures,
		exactShare: figures.netProfit * splitFraction,
		share: s.investorEarnings,
		payable: s.payable,
		carriedIn: s.carriedIn,
		deferred: s.deferred,
		deficitOut: deficitIn - s.carriedIn + s.deferred,
	};
}

// The investor line from the two settlements: the payout difference, or why it
// cannot be posted. A change in the loss carried past the month would move
// open months, which are not replayed here.
function compareSettlements(base, next, month) {
	if (base.deficitOut !== next.deficitOut) {
		return { problem: `removing the day changes the loss carried past ${monthLabel(month)} (${usd(base.deficitOut * 100)} to ${usd(next.deficitOut * 100)}), which moves open months this script cannot replay.` };
	}
	return { cents: (next.payable - base.payable) * 100 };
}

// The investor line's amount: the settled payout recomputed without the day,
// minus it recomputed with it (without any day this script already corrected).
function replayInvestor(db, day, kase, ev, own) {
	const out = { problems: [], arithmetic: [] };
	const row = db.prepare("SELECT * FROM investor_payouts WHERE owner_id = ? AND period = ?").get(kase.ownerId, kase.sourceMonth);
	if (!row) { out.problems.push(`investor ${kase.ownerId} has no ${monthLabel(kase.sourceMonth)} payout row.`); return out; }
	out.row = row;
	if (!row.finalized_at) { out.problems.push(`payout row ${row.id} (${monthLabel(kase.sourceMonth)}) was never finalized.`); return out; }
	if (investorPayoutBasis.frozenBreakdownIsLease(row.finalized_breakdown)) {
		out.leaseMonth = true;
		out.cents = 0;
		return out;
	}
	let b = null;
	try { b = JSON.parse(row.finalized_breakdown || "null"); } catch { b = null; }
	if (!b || typeof b !== "object") { out.problems.push(`payout row ${row.id} has no settled breakdown to replay.`); return out; }
	const splitPct = Number(b.splitPct);
	if (!Number.isFinite(splitPct) || splitPct <= 0 || splitPct > 100) { out.problems.push(`payout row ${row.id}'s breakdown has no usable split (${b.splitPct}).`); return out; }
	const splitFraction = splitPct / 100;
	out.splitPct = splitPct;

	const items = db.prepare(
		"SELECT id, kind, adjusts, day, cents, load_id, driver, truck, pay_type FROM financials_ledger_items WHERE period = ? AND owner_id = ? AND freeze_id = ? ORDER BY id"
	).all(kase.sourceMonth, kase.ownerId, ev.freeze.freeze_id);
	out.itemCount = items.length;
	if (!items.some((i) => i.id === ev.item.id)) { out.problems.push(`ledger item ${ev.item.id} is not among investor ${kase.ownerId}'s frozen items.`); return out; }
	// A Settlement adjustment means the settled figures are not the line items:
	// the items then "add up" to the settlement whether or not it counted this
	// day, so removing the day could credit a day the settlement never paid.
	const settlementAdjustments = items.filter((i) => i.kind === "settlement_adjustment");
	if (settlementAdjustments.length) {
		out.problems.push(`the frozen ${monthLabel(kase.sourceMonth)} items for investor ${kase.ownerId} include ${settlementAdjustments.length} Settlement adjustment line(s) (` +
			settlementAdjustments.map((i) => `${i.adjusts || "unknown"} ${usd(i.cents)}`).join(", ") +
			"), so the settled figures are not the line items and whether the settlement paid this day cannot be told from them.");
		return out;
	}

	// The settled carry terms. The deficit carried into the month is known
	// exactly only when the month absorbed less than its whole share.
	const raw = Math.round(Number(b.monthShare));
	const payableSettled = Math.round(Number(row.finalized_amount ?? row.amount));
	const carriedIn = Number.isFinite(Number(b.lossCarriedIn)) ? Math.round(Number(b.lossCarriedIn)) : raw - payableSettled;
	const deferred = Number.isFinite(Number(b.lossDeferred)) ? Math.round(Number(b.lossDeferred)) : 0;
	if (!(raw > 0)) { out.problems.push(`${monthLabel(kase.sourceMonth)} settled a share of ${usd(raw * 100)}; a loss month moves the loss carried into open months, which this script cannot replay.`); return out; }
	if (carriedIn < 0 || carriedIn >= raw) { out.problems.push(`${monthLabel(kase.sourceMonth)} absorbed ${usd(carriedIn * 100)} of earlier losses out of a share of ${usd(raw * 100)}; the loss carried into it is not known exactly.`); return out; }
	const deficitIn = carriedIn;

	const asSettled = settleMonth(items, kase.sourceMonth, splitFraction, deficitIn);
	const mismatches = [];
	for (const [k, label] of [...FIGURE_LABELS, ["netProfit", "net profit"]]) {
		if (toCents(asSettled.figures[k]) !== toCents(b[k])) mismatches.push(`${label} ${usd(toCents(asSettled.figures[k]))} vs settled ${usd(toCents(b[k]))}`);
	}
	if (asSettled.share !== raw) mismatches.push(`share ${usd(asSettled.share * 100)} vs settled ${usd(raw * 100)}`);
	if (asSettled.payable !== payableSettled || Math.round(Number(row.amount)) !== payableSettled) mismatches.push(`payout ${usd(asSettled.payable * 100)} vs settled ${usd(payableSettled * 100)} (amount ${usd(toCents(row.amount))})`);
	if (asSettled.carriedIn !== carriedIn || asSettled.deferred !== deferred) mismatches.push(`carry ${usd(asSettled.carriedIn * 100)} in / ${usd(asSettled.deferred * 100)} deferred vs settled ${usd(carriedIn * 100)} / ${usd(deferred * 100)}`);
	out.asSettled = asSettled;
	out.settledPayout = payableSettled;
	if (mismatches.length) { out.problems.push(`the replay does not reproduce ${monthLabel(kase.sourceMonth)} as settled: ${mismatches.join("; ")}.`); return out; }
	out.reproduced = true;

	// Days this script already corrected on this investor's side come out of
	// the base too, so the corrections add up to the joint replay.
	const mine = own.filter((l) => l.kind === "investor" && l.ref !== kase.ref && l.target.startsWith(`${kase.ownerId}:`));
	const prior = [];
	for (const ref of [...new Set(mine.map((l) => l.ref))]) {
		const pday = dayOfRef(ref);
		const pk = CASES[pday];
		const pItem = pk ? items.find((i) => i.kind === "driver_pay" && i.day === pday && normalizeName(i.driver) === ev.driverKey && String(i.load_id) === pk.ledgerLoad) : null;
		if (!pItem) { out.problems.push(`this script already posted ${ref} on investor ${kase.ownerId}'s side, but its day is not one frozen item of this ledger.`); return out; }
		prior.push({ ref, day: pday, item: pItem });
	}
	out.prior = prior;
	const without = (ids) => items.filter((i) => !ids.includes(i.id));
	const base = prior.length ? settleMonth(without(prior.map((p) => p.item.id)), kase.sourceMonth, splitFraction, deficitIn) : asSettled;
	const next = settleMonth(without([...prior.map((p) => p.item.id), ev.item.id]), kase.sourceMonth, splitFraction, deficitIn);
	out.base = base;
	out.next = next;
	const cmp = compareSettlements(base, next, kase.sourceMonth);
	if (cmp.problem) { out.problems.push(cmp.problem); return out; }
	out.cents = cmp.cents;
	return out;
}

// ---------------------------------------------------------------- the plan

function combineNote(existing, mine) {
	return existing ? `${existing} | ${mine}` : mine;
}

// A target's existing adjustment is combined with this line only when it is
// wholly this script's own earlier lines (amount and references). Any other
// adjustment is skipped: both routes replace an adjustment rather than add to
// it, so writing would erase someone's correction.
function existingAdjustment(targetKey, current, note, own, kind) {
	const curCents = toCents(current);
	if (curCents === 0) return { ok: true, combine: false };
	const mine = own.filter((l) => l.kind === kind && l.target === targetKey);
	const sum = mine.reduce((s, l) => s + l.cents, 0);
	const refsPresent = mine.length > 0 && mine.every((l) => String(note || "").includes(`Ref ${l.ref}`));
	if (mine.length && sum === curCents && refsPresent) return { ok: true, combine: true, refs: mine.map((l) => l.ref) };
	return { ok: false };
}

function driverLine(db, day, kase, ev, own) {
	const line = { kind: "driver", title: `${ev.driverName}'s driver pay`, reasons: [], passedOver: [] };
	line.cents = -ev.dayCents;
	line.note = `${weekdayOf(day)} ${shortDate(day)} is not a pay day: ${kase.noteWhy}. Its $${plain(ev.dayCents)} was paid on ${kase.sourceInvoice}. Ref ${kase.ref}`;
	const done = own.find((l) => l.kind === "driver" && l.ref === kase.ref);
	if (done) {
		const holder = db.prepare("SELECT id, invoice_number, adjustment, adjustment_note FROM invoices WHERE deleted_at = '' AND invoice_number = ?").get(done.target);
		line.cents = done.cents;
		line.status = "applied";
		line.reasons.push(`Already applied: ${usd(done.cents)} on ${done.target} (audit row ${done.auditId}, ${done.timestamp}).` +
			(holder && String(holder.adjustment_note || "").includes(`Ref ${kase.ref}`)
				? ` ${done.target} still carries it (adjustment ${usd(toCents(holder.adjustment))}).`
				: ` ${done.target} no longer carries its note: the line was changed after it was applied. Review it on the Invoices screen; this script writes it only once.`));
		return line;
	}
	const month = kase.targetMonth;
	const candidates = db.prepare(
		`SELECT id, invoice_number, driver, week_start, week_end, status, paid_at, total_earnings, adjustment, adjustment_note, render_data
		   FROM invoices WHERE deleted_at = '' AND is_manual = 0 AND week_start >= ? AND week_end <= ? ORDER BY week_start, id`
	).all(`${month}-01`, lastDayOf(month)).filter((r) => normalizeName(r.driver) === ev.driverKey);
	let home = null;
	for (const r of candidates) {
		if ((r.status === "Draft" || r.status === "Submitted") && !String(r.paid_at || "").trim()) { home = r; break; }
		line.passedOver.push(`${r.invoice_number} (week ${r.week_start} to ${r.week_end}) is ${r.status}${String(r.paid_at || "").trim() ? `, paid ${r.paid_at}` : ""}`);
	}
	if (!home) {
		const w = firstInvoiceWeek(month);
		line.status = "skip";
		line.reasons.push(`Skipped: ${ev.driverName} has no weekly invoice for a week inside ${monthLabel(month)} that is still Draft or Submitted` +
			(line.passedOver.length ? ` (passed over: ${line.passedOver.join("; ")})` : "") + ". " +
			(candidates.length ? "" : `The weekly batch creates each week's invoice on the evening of the Friday that ends it; the first week inside ${monthLabel(month)} is ${w.start} to ${w.end}. `) +
			"Nothing is written for this line; re-run this command once that invoice exists.");
		return line;
	}
	line.home = home;
	const lock = lockStatus(db, month);
	if (lock && lock.status === "locked") {
		line.status = "skip";
		line.reasons.push(`Skipped: ${monthLabel(month)} is closed, so ${home.invoice_number} takes no adjustment. The approval names ${monthLabel(month)}; ask the owner where the correction goes now. Nothing is written for this line.`);
		return line;
	}
	const existing = existingAdjustment(home.invoice_number, home.adjustment, home.adjustment_note, own, "driver");
	if (!existing.ok) {
		line.status = "skip";
		line.reasons.push(`Skipped: ${home.invoice_number} already has an adjustment of ${usd(toCents(home.adjustment))} that this script did not write (note: ${JSON.stringify(home.adjustment_note || "")}). The adjust route replaces an adjustment rather than adding to it, so writing this line would erase it. Nothing is written for this line; post ${usd(line.cents)} by hand on the Invoices screen together with the existing adjustment, or ask.`);
		return line;
	}
	line.combine = existing.combine;
	line.before = { adjustment: toCents(home.adjustment), note: home.adjustment_note || "", totalDue: toCents(home.total_earnings) + toCents(home.adjustment) };
	const newNote = combineNote(existing.combine ? home.adjustment_note : "", line.note);
	const newAdj = line.before.adjustment + line.cents;
	line.after = { adjustment: newAdj, note: newNote, totalDue: toCents(home.total_earnings) + newAdj };
	if (line.after.totalDue < 0) {
		line.status = "skip";
		line.reasons.push(`Skipped: ${usd(line.cents)} would take ${home.invoice_number}'s Total Due from ${usd(line.before.totalDue)} to ${usd(line.after.totalDue)}, below $0. The claw-back is not moved to another invoice. Nothing is written for this line; post it by hand where the owner decides, or ask.`);
		return line;
	}
	if (Math.abs(newAdj) > ADJUST_CAP_CENTS) {
		line.status = "skip";
		line.reasons.push(`Skipped: the adjustment would be ${usd(newAdj)}, beyond the route's $10,000 cap. Nothing is written for this line.`);
		return line;
	}
	if (newNote.length > NOTE_MAX) {
		line.status = "skip";
		line.reasons.push(`Skipped: the combined note would be ${newNote.length} characters, beyond the route's ${NOTE_MAX}. Nothing is written for this line.`);
		return line;
	}
	let render = null;
	try { render = JSON.parse(home.render_data || "null"); } catch { render = null; }
	line.legacyPdf = !(render && render.__templateName);
	line.status = "write";
	return line;
}

function investorLine(db, day, kase, ev, own, ctx) {
	const line = { kind: "investor", title: `investor ${kase.ownerId}'s payout`, reasons: [] };
	const month = kase.targetMonth;
	const targetKey = payoutTarget(kase.ownerId, month);
	const done = own.find((l) => l.kind === "investor" && l.ref === kase.ref && l.target.startsWith(`${kase.ownerId}:`));
	if (done) {
		const holder = db.prepare("SELECT id, adjustment, adjustment_note FROM investor_payouts WHERE owner_id = ? AND period = ?").get(kase.ownerId, done.target.slice(done.target.indexOf(":") + 1));
		line.cents = done.cents;
		line.status = "applied";
		line.reasons.push(`Already applied: ${usd(done.cents)} on investor ${kase.ownerId}'s ${done.target.slice(done.target.indexOf(":") + 1)} payout (audit row ${done.auditId}, ${done.timestamp}).` +
			(holder && String(holder.adjustment_note || "").includes(`Ref ${kase.ref}`)
				? ` The row still carries it (adjustment ${usd(toCents(holder.adjustment))}).`
				: " The row no longer carries its note: the line was changed after it was applied. Review it on the Payouts console; this script writes it only once."));
		return line;
	}
	const replay = replayInvestor(db, day, kase, ev, own);
	line.replay = replay;
	if (replay.problems.length) {
		line.status = "skip";
		line.reasons.push(`Skipped (uncertain): ${replay.problems.join(" ")} Nothing is written for this line.`);
		return line;
	}
	line.cents = replay.cents;
	line.note = `Correction to ${monthLabel(kase.sourceMonth)}: ${weekdayOf(day)} ${monthDay(day)} driver pay ($${plain(ev.dayCents)}, load ${kase.ledgerLoad}, truck ${kase.truck}) removed; your share ${signedDollars(line.cents)}. Ref ${kase.ref}`;
	if (replay.leaseMonth || line.cents === 0) {
		line.status = "nothing";
		line.reasons.push(replay.leaseMonth
			? `Nothing to post: ${monthLabel(kase.sourceMonth)} was settled as a lease, which pays as settled whatever its costs.`
			: "Nothing to post: the payout does not change without the day.");
		return line;
	}
	const row = db.prepare("SELECT * FROM investor_payouts WHERE owner_id = ? AND period = ?").get(kase.ownerId, month);
	const closesAfter = graceEndsAt(month, ctx.graceDays);
	const nextMonthStart = addDays(lastDayOf(month), 1);
	if (!row) {
		line.status = "skip";
		line.reasons.push(`Skipped: investor ${kase.ownerId} has no ${monthLabel(month)} payout row yet. The app creates it, as an owed row, on the first payouts read (a Super Admin opening the Payouts console, or the investor's portal) on or after ${nextMonthStart}, once ${monthLabel(month)} has ended; if nothing reads payouts before the close, the close creates and locks it in one step. This script does not create it: a row for a month still in progress would show on both screens and could be marked paid before the month's own figure exists, and the adjust route never creates a row either. Nothing is written for this line; re-run this command between ${nextMonthStart} and ${closesAfter} (${monthLabel(month)}'s books close after ${closesAfter}, with the ${ctx.graceDays}-day grace).`);
		return line;
	}
	line.home = row;
	const lock = lockStatus(db, month);
	if (lock && lock.status === "locked") {
		line.status = "skip";
		line.reasons.push(`Skipped: ${monthLabel(month)} is closed, so payout row ${row.id} takes no adjustment. The approval names ${monthLabel(month)}; ask the owner where the correction goes now. Nothing is written for this line.`);
		return line;
	}
	if (row.status !== "owed" || String(row.finalized_at || "").trim()) {
		line.status = "skip";
		line.reasons.push(`Skipped: payout row ${row.id} (${monthLabel(month)}) is ${row.status}${row.finalized_at ? `, finalized ${row.finalized_at}` : ""}; the correction has to land before it is settled. Nothing is written for this line.`);
		return line;
	}
	const existing = existingAdjustment(targetKey, row.adjustment, row.adjustment_note, own, "investor");
	if (!existing.ok) {
		line.status = "skip";
		line.reasons.push(`Skipped: payout row ${row.id} already has an adjustment of ${usd(toCents(row.adjustment))} that this script did not write (note: ${JSON.stringify(row.adjustment_note || "")}). The adjust route replaces an adjustment rather than adding to it, so writing this line would erase it. Nothing is written for this line; post ${usd(line.cents)} by hand on the Payouts console together with the existing adjustment, or ask.`);
		return line;
	}
	line.combine = existing.combine;
	const amountCents = toCents(row.amount);
	const before = toCents(row.adjustment);
	const after = before + line.cents;
	const newNote = combineNote(existing.combine ? row.adjustment_note : "", line.note);
	const effective = (adj) => Math.max(0, Math.round((amountCents + adj) / 100)) * 100;
	line.before = { amount: amountCents, adjustment: before, note: row.adjustment_note || "", effective: effective(before) };
	line.after = { amount: amountCents, adjustment: after, note: newNote, effective: effective(after) };
	// The route's rules: whole dollars, the $10,000 cap, never inverted.
	if (after % 100 !== 0 || Math.abs(after) > ADJUST_CAP_CENTS) {
		line.status = "skip";
		line.reasons.push(`Skipped: the adjustment would be ${usd(after)}, which the route would not take (whole dollars, at most $10,000 either way). Nothing is written for this line.`);
		return line;
	}
	if (Math.round(amountCents / 100) * 100 + after < 0) {
		line.status = "skip";
		line.reasons.push(`Skipped: ${usd(after)} would take the ${usd(amountCents)} payout below $0, which the route refuses. Nothing is written for this line.`);
		return line;
	}
	if (newNote.length > NOTE_MAX) {
		line.status = "skip";
		line.reasons.push(`Skipped: the combined note would be ${newNote.length} characters, beyond the route's ${NOTE_MAX}. Nothing is written for this line.`);
		return line;
	}
	line.status = "write";
	return line;
}

function buildPlan(db, day, kase) {
	const plan = { day, kase, lines: [], refused: "" };
	if (!locksReadable(db)) {
		plan.refused = "period_locks could not be read, so no month can be confirmed closed or open.";
		return plan;
	}
	const sourceLock = lockStatus(db, kase.sourceMonth);
	plan.sourceLock = sourceLock;
	if (!sourceLock || sourceLock.status !== "locked") {
		plan.refused = `${monthLabel(kase.sourceMonth)} is not closed (period_locks: ${sourceLock ? sourceLock.status : "no row"}). This fix posts the correction on ${monthLabel(kase.targetMonth)} because ${monthLabel(kase.sourceMonth)} is closed and stays as recorded; with it open, the day would be corrected in ${monthLabel(kase.sourceMonth)} itself.`;
		return plan;
	}
	const ev = readEvidence(db, day, kase);
	ev.driverName = ev.invoice ? ev.invoice.driver.replace(/\b\w/g, (c) => c.toUpperCase()) : "the driver";
	plan.ev = ev;
	plan.graceDays = graceDays(db);
	const own = ownLines(db);
	plan.own = own;
	if (ev.problems.length) {
		const why = `Skipped (uncertain): ${ev.problems.join(" ")} Nothing is written for this line.`;
		plan.lines.push({ kind: "driver", title: `${ev.driverName}'s driver pay`, status: "skip", reasons: [why] });
		plan.lines.push({ kind: "investor", title: `investor ${kase.ownerId}'s payout`, status: "skip", reasons: [why] });
		return plan;
	}
	plan.lines.push(driverLine(db, day, kase, ev, own));
	plan.lines.push(investorLine(db, day, kase, ev, own, { graceDays: plan.graceDays }));
	return plan;
}

// ---------------------------------------------------------------- the writes

function writePlan(db, plan, approval, nowIso) {
	const { kase, ev, day } = plan;
	const audit = db.prepare(
		"INSERT INTO audit_trail (timestamp, user_id, username, role, action, entity, entity_id, details) VALUES (?, 0, ?, 'system', ?, ?, ?, ?)"
	);
	const written = [];
	for (const line of plan.lines) {
		if (line.status !== "write") continue;
		if (line.kind === "driver") {
			const h = line.home;
			const changes = db.prepare(
				`UPDATE invoices SET adjustment = ?, adjustment_note = ?, adjusted_by = ?, adjusted_at = ?
				  WHERE id = ? AND deleted_at = '' AND status IN ('Draft', 'Submitted') AND adjustment IS ? AND adjustment_note IS ?`
			).run(line.after.adjustment / 100, line.after.note, ACTOR, nowIso, h.id, h.adjustment, h.adjustment_note).changes;
			if (changes !== 1) throw new Error(`${h.invoice_number} changed while this run was writing; nothing was written`);
			const details = `${h.invoice_number}: adjustment ${(line.before.adjustment / 100).toFixed(2)} → ${(line.after.adjustment / 100).toFixed(2)} (${line.after.note}). ` +
				`Data fix ${kase.ref}, approval ${approval} (${kase.approvalStatus}): ${weekdayOf(day)} ${day} was not a pay day. ${kase.why} ` +
				`It was billed at $${plain(ev.dayCents)} on ${kase.sourceInvoice} (invoice ${ev.invoice.id}) and paid in the frozen ${monthLabel(kase.sourceMonth)} ledger (item ${ev.item.id}, load ${ev.item.load_id}); ` +
				`${monthLabel(kase.sourceMonth)} stays as recorded, so the day is taken back on this ${monthLabel(kase.targetMonth)} invoice. The PDF was not re-rendered by the script. ` +
				`[${kase.ref} driver ${signed2(line.cents)} ${h.invoice_number}]`;
			const a = audit.run(nowIso, ACTOR, "adjust_invoice", "invoice", String(h.id), details);
			written.push({ line, table: "invoices", id: h.id, auditId: Number(a.lastInsertRowid) });
		} else {
			const r = line.home;
			const changes = db.prepare(
				`UPDATE investor_payouts SET adjustment = ?, adjustment_note = ?, adjusted_by = ?, adjusted_at = ?
				  WHERE id = ? AND status = 'owed' AND COALESCE(finalized_at, '') = '' AND adjustment IS ? AND adjustment_note IS ?`
			).run(line.after.adjustment / 100, line.after.note, ACTOR, nowIso, r.id, r.adjustment, r.adjustment_note).changes;
			if (changes !== 1) throw new Error(`payout row ${r.id} changed while this run was writing; nothing was written`);
			// The route's history row (recordPayoutChange(), kind "adjustment"): the
			// effective payout before and after.
			const oldEff = (line.before.amount + line.before.adjustment) / 100;
			const newEff = (line.after.amount + line.after.adjustment) / 100;
			db.prepare(
				`INSERT INTO investor_payout_history (payout_id, owner_id, period, kind, old_amount, new_amount, delta, detail, breakdown, actor)
				 VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, '', ?)`
			).run(r.id, r.owner_id, r.period, oldEff, newEff, Number((newEff - oldEff).toFixed(2)), `adjustment: ${line.after.note}`, ACTOR);
			const rp = line.replay;
			const details = `owner ${r.owner_id} ${r.period}: adjustment ${(line.before.adjustment / 100).toFixed(2)} -> ${(line.after.adjustment / 100).toFixed(2)} (${line.after.note}). ` +
				`Data fix ${kase.ref}, approval ${approval} (${kase.approvalStatus}): ${monthLabel(kase.sourceMonth)} settled at $${plain(rp.settledPayout * 100)} with ${weekdayOf(day)} ${day}'s $${plain(ev.dayCents)} driver pay ` +
				`(ledger item ${ev.item.id}, load ${ev.item.load_id}); the same settlement without that day pays $${plain(rp.next.payable * 100)} against $${plain(rp.base.payable * 100)}, ` +
				`so ${usd(line.cents)} is posted on ${monthLabel(kase.targetMonth)}. ${monthLabel(kase.sourceMonth)} stays as settled. ` +
				`[${kase.ref} investor ${signed2(line.cents)} ${payoutTarget(r.owner_id, r.period)}]`;
			const a = audit.run(nowIso, ACTOR, "investor_payout_adjust", "investor_payout", String(r.id), details);
			written.push({ line, table: "investor_payouts", id: r.id, auditId: Number(a.lastInsertRowid) });
		}
	}
	// Read back what was written, inside the transaction.
	for (const w of written) {
		const row = db.prepare(`SELECT adjustment, adjustment_note, adjusted_by FROM ${w.table === "invoices" ? "invoices" : "investor_payouts"} WHERE id = ?`).get(w.id);
		if (!row || toCents(row.adjustment) !== w.line.after.adjustment || row.adjustment_note !== w.line.after.note || row.adjusted_by !== ACTOR) {
			throw new Error(`${w.table} row ${w.id} does not read back as written; nothing was written`);
		}
	}
	return written;
}

// The server's closed-month triggers (installPeriodLockTriggers()), lifted from
// this checkout's server.js and installed on this connection: a floor under the
// checks above, never a substitute for them.
function installClosedMonthTriggers(db) {
	const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
	const lifted = closure(src, { roots: ["installPeriodLockTriggers"], provided: [], denied: ["db"] });
	const install = new Function(`"use strict";\n${lifted.text}\nreturn installPeriodLockTriggers;`)();
	install(db);
}

// The handle a run uses: read-only for a dry run, and checked.
function openDatabase(file, { dryRun }) {
	const Database = require("better-sqlite3");
	const db = new Database(file, { readonly: dryRun, fileMustExist: true });
	if (dryRun && !db.readonly) {
		db.close();
		throw new Error("the dry run's database handle is not read-only");
	}
	db.pragma("busy_timeout = 10000");
	return db;
}

// One apply: an approved case only, the closed-month triggers installed first,
// every write in one IMMEDIATE transaction with the plan computed inside it.
// Throws Refusal (nothing written) or an error (rolled back).
function applyCase(db, day, kase, approval, { install = installClosedMonthTriggers, nowIso = new Date().toISOString() } = {}) {
	if (!kase.approved) throw new Refusal(`${day} is not approved (${kase.approvalStatus}); only its dry run may run. Nothing was written.`);
	if (approval !== kase.approval) throw new Refusal(`applying ${day} needs --approval ${kase.approval} (${kase.approvalStatus}). Nothing was written.`);
	try {
		install(db);
	} catch (err) {
		throw new Refusal(`the closed-month triggers could not be installed on this connection (${err.message}); nothing was written`);
	}
	const run = db.transaction(() => {
		const plan = buildPlan(db, day, kase);
		const written = plan.refused ? [] : writePlan(db, plan, approval, nowIso);
		return { plan, written };
	});
	return run.immediate();
}

// ---------------------------------------------------------------- the report

function render(plan, { dbFile, dryRun, readonlyHandle, written, applyCommand }) {
	const { kase, day, ev } = plan;
	const out = [];
	const say = (s = "") => out.push(s);
	say(`Data fix ${kase.ref}: ${weekdayOf(day)} ${day} was not a pay day`);
	say(`Approval: ${kase.approvalStatus}.`);
	say(`Database: ${dbFile}`);
	say(dryRun
		? `Mode: DRY RUN. ${readonlyHandle ? "The database handle is read-only" : "The database handle is NOT read-only"}; nothing is written.`
		: "Mode: APPLY. Every write of this run is one transaction.");
	say();
	say(`Why: ${kase.why}`);
	if (plan.refused) {
		say();
		say(`REFUSED: ${plan.refused} Nothing is written.`);
		return out.join("\n");
	}
	say(`${monthLabel(kase.sourceMonth)} is closed (since ${plan.sourceLock.finalized_at}) and stays exactly as recorded. The corrections post on ${monthLabel(kase.targetMonth)}.`);
	say();
	say("What the day was paid");
	if (ev.invoice) {
		const inv = ev.invoice;
		const paid = String(inv.paid_at || "").trim() ? `paid ${inv.paid_at}` : "not paid";
		if (ev.dayCents !== undefined) {
			say(`- Invoice ${inv.invoice_number} (id ${inv.id}; driver ${ev.driverName}; week ${inv.week_start} to ${inv.week_end}; ${inv.status}, ${paid}) bills ${weekdayOf(day)} ${day} at ${usd(ev.dayCents)} for load ${ev.dayLoads.join(", ") || "none"}. ` +
				`Its seven day lines add up to its total earnings, ${usd(ev.totalCents)}, at a daily rate of ${usd(ev.rateCents)}.`);
		}
	}
	if (ev.item) {
		say(`- The frozen ${monthLabel(kase.sourceMonth)} ledger (freeze ${ev.freeze.freeze_id}, by the ${ev.freeze.source}) holds one driver-pay day for ${ev.driverName} on ${day}: item ${ev.item.id}, ${usd(ev.item.cents)}, ${ev.item.pay_type} pay, load ${ev.item.load_id}, truck ${ev.item.truck}, owner ${ev.item.owner_id}.`);
	}
	if (kase.loadsDiffer) say(`- ${kase.loadsDiffer}`);
	if (!ev.problems.length) say(`- The two agree: the day was paid ${usd(ev.dayCents)}.`);
	if (ev.invoice || ev.sourcePayout) {
		const invAdj = ev.invoice ? `${kase.sourceInvoice} carries an adjustment of ${usd(toCents(ev.invoice.adjustment))}` : `${kase.sourceInvoice} was not found`;
		const payAdj = ev.sourcePayout ? `${monthLabel(kase.sourceMonth)}'s payout row ${ev.sourcePayout.id} for investor ${kase.ownerId} carries an adjustment of ${usd(toCents(ev.sourcePayout.adjustment))}` : `investor ${kase.ownerId} has no ${monthLabel(kase.sourceMonth)} payout row`;
		say(`- Corrections already on record: ${invAdj}; ${payAdj}. Either one non-zero would mean the day may already have been corrected by hand, and nothing would be written.`);
	}
	if (ev.rates) {
		const r = (x) => (x ? `${usd(toCents(x.rate))} a day${x.seeded ? ` (recorded from ${String(x.effective_from).slice(0, 10)}, the rate in force when recording began)` : ` (from ${String(x.effective_from).slice(0, 10)})`}` : "not on record");
		say(`- Rates on record: the driver ${r(ev.rates.driver)}; truck ${kase.truck} ${r(ev.rates.truck)}. For information; the line amounts come from the invoice and the ledger.`);
	}
	for (const n of ev.notes) say(`- Note: ${n}`);
	plan.lines.forEach((line, i) => {
		say();
		say(`Line ${i + 1} of ${plan.lines.length}: ${line.title}${line.cents !== undefined ? `, ${usd(line.cents)}` : ""}`);
		if (line.kind === "driver" && line.cents !== undefined) {
			say(`- Amount: minus what the day was billed, ${usd(line.cents)}.`);
			say(`- Home: ${ev.driverName}'s earliest weekly invoice for a week inside ${monthLabel(kase.targetMonth)} that is still Draft or Submitted (the adjust route's column, invoices.adjustment; the invoice PDF's Total Due, the Invoices screen, the payment report and Financials' invoiced column read total earnings + adjustment).`);
		}
		if (line.kind === "investor" && line.replay && line.replay.asSettled) {
			const rp = line.replay;
			const figs = (f) => FIGURE_LABELS.map(([k, label]) => `${label} ${usd(toCents(f[k]))}`).join(", ");
			const split = (s) => `split ${rp.splitPct}%: ${usd(toCents(s.figures.netProfit))} x ${(rp.splitPct / 100).toFixed(2)} = ${usd3(s.exactShare)}, rounded to ${usd(s.share * 100)}; loss carried in ${usd(s.carriedIn * 100)}, deferred ${usd(s.deferred * 100)}; payout ${usd(s.payable * 100)}`;
			say(`- ${monthLabel(kase.sourceMonth)} as settled (payout row ${rp.row.id}, owner ${kase.ownerId}, from its ${rp.itemCount} frozen line items): ${figs(rp.asSettled.figures)}; net profit ${usd(toCents(rp.asSettled.figures.netProfit))}. ` +
				`The payout function (lib/investor-payout-basis.js settleInvestorMonths()) gives ${split(rp.asSettled)}.` +
				(rp.reproduced ? ` That is the settled row exactly (amount ${usd(toCents(rp.row.amount))}, finalized ${usd(toCents(rp.row.finalized_amount))}).` : ""));
			if (rp.prior && rp.prior.length) {
				say(`- Already corrected by this script on the investor's side: ${rp.prior.map((p) => `${p.day} (${p.ref}, item ${p.item.id})`).join(", ")}. Without ${rp.prior.length === 1 ? "that day" : "those days"}: net profit ${usd(toCents(rp.base.figures.netProfit))}; ${split(rp.base)}.`);
			}
			if (rp.next) {
				say(`- Without ${weekdayOf(day)} ${day}${rp.prior && rp.prior.length ? " as well" : ""} (item ${ev.item.id}, driver pay ${usd(ev.item.cents)}): driver pay ${usd(toCents(rp.next.figures.driverPay))}, net profit ${usd(toCents(rp.next.figures.netProfit))}; ${split(rp.next)}.`);
				if (rp.cents !== undefined) {
					say(`- Difference: ${usd(rp.next.payable * 100)} - ${usd(rp.base.payable * 100)} = ${usd((rp.next.payable - rp.base.payable) * 100)} for investor ${kase.ownerId}. The loss carried past ${monthLabel(kase.sourceMonth)} is ${usd(rp.next.deficitOut * 100)} either way, so no later month's carry-forward moves.`);
				}
			}
			say(`- Home: investor ${kase.ownerId}'s ${monthLabel(kase.targetMonth)} payout row (the adjust route's column, investor_payouts.adjustment; effective payout = amount + adjustment, read by the Payouts console, the investor portal and the month's statement).`);
		}
		if (line.status === "write") {
			if (line.kind === "driver") {
				const h = line.home;
				say(`- Target: ${h.invoice_number} (id ${h.id}; week ${h.week_start} to ${h.week_end}; ${h.status}; not paid).`);
				say(`- Before: adjustment ${usd(line.before.adjustment)}, Total Due ${usd(line.before.totalDue)}. After: adjustment ${usd(line.after.adjustment)}, Total Due ${usd(line.after.totalDue)}.`);
				if (line.combine) say(`- The invoice already carries this script's own earlier line(s); the new adjustment is their sum and the note is appended, as an admin editing it on the Invoices screen would enter it.`);
				say(`- Note: ${JSON.stringify(line.after.note)}`);
				say(`- ${dryRun ? "Would write" : "Written"}: invoices row ${h.id} (adjustment, adjustment_note, adjusted_by "${ACTOR}", adjusted_at), and one audit_trail row (adjust_invoice, system).`);
				say(`- The invoice PDF is not re-rendered by this script${line.legacyPdf ? " (and this invoice has no render snapshot, so the server would add an adjustment page)" : ""}. After the apply, open ${h.invoice_number} on the Invoices screen, choose Edit adjustment and Save adjustment without changing it; the server re-renders the PDF with the adjustment.`);
			} else {
				const r = line.home;
				say(`- Target: payout row ${r.id} (owner ${r.owner_id}, ${monthLabel(r.period)}, ${r.status}, due ${r.due_date}).`);
				say(`- Before: amount ${usd(line.before.amount)}, adjustment ${usd(line.before.adjustment)}, effective payout ${usd(line.before.effective)}. After: amount ${usd(line.after.amount)}, adjustment ${usd(line.after.adjustment)}, effective payout ${usd(line.after.effective)}. The month's own amount keeps tracking its live recompute until it closes; the adjustment stays beside it.`);
				if (line.combine) say("- The row already carries this script's own earlier line(s); the new adjustment is their sum and the note is appended, as an admin editing it on the Payouts console would enter it.");
				say(`- Note (the investor sees it in the portal and on the statement): ${JSON.stringify(line.after.note)}`);
				say(`- ${dryRun ? "Would write" : "Written"}: investor_payouts row ${r.id} (adjustment, adjustment_note, adjusted_by "${ACTOR}", adjusted_at), one investor_payout_history row (adjustment, effective ${usd(line.before.amount + line.before.adjustment)} to ${usd(line.after.amount + line.after.adjustment)}), and one audit_trail row (investor_payout_adjust, system).`);
			}
		}
		for (const reason of line.reasons) say(`- ${reason}`);
	});
	say();
	const toWrite = plan.lines.filter((l) => l.status === "write").length;
	const skipped = plan.lines.filter((l) => l.status === "skip").length;
	const applied = plan.lines.filter((l) => l.status === "applied").length;
	const parts = [];
	if (dryRun) parts.push(`${toWrite} line(s) would be written`);
	else parts.push(`${written.length} line(s) written (audit rows ${written.map((w) => w.auditId).join(", ") || "none"})`);
	if (skipped) parts.push(`${skipped} skipped`);
	if (applied) parts.push(`${applied} already applied`);
	if (plan.lines.some((l) => l.status === "nothing")) parts.push("1 with nothing to post");
	say(`Result: ${parts.join(", ")}.${dryRun ? " Nothing was written." : ""}`);
	if (!kase.approved) {
		say(`This case is not approved, so it has no apply command: ${kase.approvalStatus}.`);
	} else if (dryRun || skipped) {
		say(dryRun ? "Apply command:" : "Re-run command for the skipped line(s):");
		say(`  ${applyCommand}`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------- main

function main() {
	const refuse = (msg) => {
		console.error(`REFUSED: ${msg}`);
		process.exit(2);
	};
	let args;
	try { args = parseCli(process.argv.slice(2)); } catch (err) { refuse(err.message); }
	if (args.help) {
		console.log("Usage: node scripts/data-fix-sunday-pay-days.js --day <YYYY-MM-DD> (--dry-run | --approval <decision>) [--db=app.db]");
		console.log(`Days: ${Object.entries(CASES).map(([d, k]) => `${d} (${k.approval}, ${k.approved ? "approved" : "not approved"})`).join(", ")}`);
		return;
	}
	const day = args.day;
	if (!day) refuse("--day is required");
	const kase = Object.prototype.hasOwnProperty.call(CASES, day) ? CASES[day] : null;
	if (!kase) refuse(`--day ${day} is not a listed case; this script corrects only ${Object.keys(CASES).join(" and ")}`);
	const dryRun = args["dry-run"] === true;
	if (!dryRun && !kase.approved) refuse(`${day} is not approved (${kase.approvalStatus}); only its dry run may run. Nothing was written.`);
	if (!dryRun && args.approval !== kase.approval) {
		refuse(`applying ${day} needs --approval ${kase.approval} (${kase.approvalStatus}); without --dry-run this run would write`);
	}
	let dbFile;
	try { ({ file: dbFile } = dbScope(args.db || path.join(ROOT, "app.db"), ROOT)); } catch (err) { refuse(err.message); }
	if (!fs.existsSync(dbFile)) refuse(`no database at ${dbFile}`);

	const db = openDatabase(dbFile, { dryRun });
	const readonlyHandle = db.readonly;
	const applyCommand = `cd ${ROOT} && ${process.execPath} scripts/data-fix-sunday-pay-days.js --day ${day} --approval ${kase.approval} --db=${dbFile}`;
	let plan;
	let written = [];
	try {
		if (dryRun) plan = buildPlan(db, day, kase);
		else ({ plan, written } = applyCase(db, day, kase, args.approval));
	} catch (err) {
		db.close();
		if (err instanceof Refusal) refuse(err.message);
		throw err;
	}
	db.close();
	console.log(render(plan, { dbFile, dryRun, readonlyHandle, written, applyCommand }));
	if (plan.refused) process.exit(2);
}

if (require.main === module) {
	try {
		main();
	} catch (err) {
		console.error(`ERROR: ${err.message}. Nothing was written.`);
		process.exit(1);
	}
}

module.exports = {
	ACTOR, CASES, Refusal,
	openDatabase, buildPlan, applyCase, settleMonth, compareSettlements, render,
};
