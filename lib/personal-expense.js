"use strict";
// "PERSONAL" RECEIPTS — the pure core.
//
// A Super Admin marks all or part of a driver's receipt Personal: the purchase
// was the driver's, not the company's. The receipt row and its amount never
// change; the money lives in an append-only ledger beside it, expense_personal
// (SCHEMA_SQL below), one row per deduction ("deduct") or reversal ("reverse"),
// in integer cents. Two things follow from a live row:
//   1. the driver repays it on a weekly invoice (or the week's correction): a
//      line "Personal expense, <merchant>, <receipt date>: -$X" (lineEntries());
//   2. the personal part is not a company cost: every expense total reads one of
//      the two sources expenseSourceSql() builds instead of the plain table.
//
// THE TWO SOURCES.
//   "book"  (settlement figures: payout ledger, Financials, investor portal, tax,
//           percentage pay) — every receipt with its in-place lines taken off its
//           amount, plus one CREDIT row per line booked outside the receipt's own
//           month (in_place = 0: the receipt's month was closed when it was
//           marked). A credit row carries the receipt's columns with
//           amount = -cents (a deduction) or +cents (a reversal), posted_period =
//           the line's cost month and date = its book date, so EXPENSE_PERIOD_EXPR
//           and investorExpenseScopeSql() place it with no change of their own.
//   "world" (operational figures: fuel spend, gallons, KPI, cost per gallon, the
//           investor's receipt list) — the first half only: a closed month's
//           receipt is never lowered after the fact.
// A receipt whose live in-place lines cover all of it leaves both sources (it
// is no company cost and no fill); a partial line keeps the receipt's gallons
// and lowers only its dollars. With no live row both sources give the receipts
// exactly: every column passes through and amount - 0.0 is the same double.
//
// THE RECEIPT'S WEEK (PERSONAL_RECEIPT_WEEK_ENABLED, off unless exactly
// "true"; server.js's PERSONAL RECEIPTS section). With it on, a line belongs to
// the week of its receipt date (no valid date, or one after today: the week it
// is marked in). When that week's invoice is Approved, Processing or Paid, in a
// finalized month, too small, one of two, without render data, or still missing
// once the week's sweep is due, the line is CARRIED (needs_correction_since then
// reads "carried since") to the driver's oldest open weekly invoice after its
// week, in an open month, with room: oldest line first, never below $0, never
// split (fitLines()), printed with its own receipt date. No correction invoice
// is made. A line on an approved invoice is final (no Undo, no Reverse); a line
// reversed while on no invoice, and its reversal, never go on one. The books
// are the same either way: nothing here keys on the week.
//
// THE OWNER-OPERATOR SHARE. A percentage driver's pay is p x (revenue - fuel and
// maintenance receipts). A Personal receipt comes out of that base and is
// deducted once in full. When the invoice that counted the receipt already
// exists, its pay is frozen with the receipt inside the base, so the line
// carries share_cents = p x A, printed as "<type> share returned ... +$X"
// beside the deduction (shareCents()).
//
// Pure: no I/O, no requires, no environment reads.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS expense_personal (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	expense_id INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK(kind IN ('deduct', 'reverse')),
	reverses_id INTEGER,
	cents INTEGER NOT NULL CHECK(cents > 0),
	receipt_cents INTEGER NOT NULL,
	merchant TEXT NOT NULL DEFAULT '',
	receipt_date TEXT NOT NULL DEFAULT '',
	cost_period TEXT NOT NULL,
	in_place INTEGER NOT NULL CHECK(in_place IN (0, 1)),
	book_date TEXT NOT NULL,
	week_start TEXT NOT NULL,
	invoice_id INTEGER,
	reversed_by_id INTEGER,
	share_cents INTEGER NOT NULL DEFAULT 0 CHECK(share_cents >= 0),
	base_invoice_id INTEGER,
	needs_correction_since TEXT NOT NULL DEFAULT '',
	reason TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_by_id INTEGER NOT NULL,
	created_role TEXT NOT NULL,
	voided_at TEXT NOT NULL DEFAULT '',
	voided_by TEXT NOT NULL DEFAULT '',
	void_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_personal_live ON expense_personal(expense_id)
	WHERE kind = 'deduct' AND voided_at = '' AND reversed_by_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_personal_rev ON expense_personal(reverses_id)
	WHERE kind = 'reverse' AND voided_at = '';
CREATE INDEX IF NOT EXISTS idx_expense_personal_expense ON expense_personal(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_personal_invoice ON expense_personal(invoice_id);
CREATE INDEX IF NOT EXISTS idx_expense_personal_week ON expense_personal(week_start);
CREATE TABLE IF NOT EXISTS personal_sweep_runs (
	week_start TEXT PRIMARY KEY,
	ran_at TEXT NOT NULL,
	attached INTEGER NOT NULL DEFAULT 0,
	flagged INTEGER NOT NULL DEFAULT 0,
	failed INTEGER NOT NULL DEFAULT 0,
	summary TEXT NOT NULL DEFAULT ''
);
`;

// The drill-down label of a credit row, on the admin side and on the investor's.
// The investor's never names the driver's purchase (docs/investor-portal-copy.md).
const CREDIT_LABEL = "Personal expense (driver repays)";
const REVERSAL_CREDIT_LABEL = "Personal expense reversed";
const INVESTOR_CREDIT_LABEL = "Receipt credit (not a truck cost)";

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// At most seven whole digits and two decimals, no sign, no exponent.
const AMOUNT_RE = /^\d{1,7}(?:\.\d{1,2})?$/;

// A stored REAL amount in integer cents.
function receiptCents(amount) {
	const n = Number(amount);
	return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function refusal(code, error) {
	return { code, error };
}

// The Personal amount a request asks for, in cents of a receipt worth `max`
// cents: absent (undefined, null, "") is the whole receipt; anything else is a
// positive dollar amount with at most two decimals, no more than the receipt.
function parseAmountCents(input, max) {
	const invalid = refusal("PERSONAL_AMOUNT_INVALID", "Enter the Personal amount in dollars, more than $0 and with at most two decimals.");
	if (!(Number.isInteger(max) && max > 0)) return refusal("PERSONAL_AMOUNT_INVALID", "This receipt has no amount to mark Personal.");
	if (input === undefined || input === null || input === "") return { cents: max };
	let text;
	if (typeof input === "number") {
		if (!Number.isFinite(input)) return invalid;
		text = String(input);
	} else if (typeof input === "string") {
		text = input.trim();
	} else {
		return invalid;
	}
	if (!AMOUNT_RE.test(text)) return invalid;
	const [whole, frac = ""] = text.split(".");
	const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
	if (!(cents > 0)) return invalid;
	if (cents > max) {
		return refusal("PERSONAL_AMOUNT_TOO_LARGE", `The Personal amount can be at most the receipt's ${formatMoney(max)}.`);
	}
	return { cents };
}

// The merchant an invoice line names: the vendor, else its normalized name, the
// description, the receipt type, or "Receipt".
function merchantOf(e) {
	const pick = [e && e.vendor, e && e.vendor_normalized, e && e.description, e && e.type]
		.map((v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim())
		.find(Boolean);
	return (pick || "Receipt").slice(0, 60);
}

// "Oct 12, 2026" for a calendar day "2026-10-12", read at 12:00 UTC so it is
// the same day in every zone; "" for anything that is not a real day.
function formatDay(day) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
	if (!m) return "";
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
	const d = new Date(ms);
	if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return "";
	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d);
}

// "$1,234.56" for 123456 cents (the sign is the caller's).
function formatMoney(cents) {
	const abs = Math.abs(Math.round(Number(cents) || 0)) / 100;
	return `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function signedMoney(cents) {
	return `${cents < 0 ? "-" : "+"}${formatMoney(cents)}`;
}

function entry(row, kind, label, cents) {
	return { rowId: row.id, kind, label, cents, amount: signedMoney(cents), text: `${label}: ${signedMoney(cents)}` };
}

// The invoice lines one expense_personal row prints, the share first:
//   deduct   "<type> share returned, M, D: +$s" (owner-operator only), then
//            "Personal expense, M, D: -$A"
//   reverse  "<type> share taken back, M, D: -$s", then
//            "Personal expense reversed, M, D: +$A"
// `cents` on each entry is what it does to the driver's total due.
function lineEntries(row, receiptType) {
	const where = [row.merchant || "Receipt", formatDay(row.receipt_date)].filter(Boolean).join(", ");
	const share = Number(row.share_cents) || 0;
	const type = String(receiptType || "").trim() || "Fuel";
	const cents = Number(row.cents) || 0;
	const out = [];
	if (row.kind === "deduct") {
		if (share > 0) out.push(entry(row, "share", `${type} share returned, ${where}`, share));
		out.push(entry(row, "personal", `Personal expense, ${where}`, -cents));
	} else {
		if (share > 0) out.push(entry(row, "share_back", `${type} share taken back, ${where}`, -share));
		out.push(entry(row, "personal_reversed", `Personal expense reversed, ${where}`, cents));
	}
	return out;
}

// Every line a set of rows prints, in row id order, and the invoice's two
// columns: personalTotalCents (repayments, net of reversal credits) and
// shareTotalCents (share returned, net of shares taken back). `typeOf(row)` is
// the receipt type behind a row.
function invoiceLines(rows, typeOf) {
	const sorted = [...(rows || [])].sort((a, b) => a.id - b.id);
	let personalTotalCents = 0;
	let shareTotalCents = 0;
	const lines = [];
	for (const r of sorted) {
		const sign = r.kind === "deduct" ? 1 : -1;
		personalTotalCents += sign * (Number(r.cents) || 0);
		shareTotalCents += sign * (Number(r.share_cents) || 0);
		lines.push(...lineEntries(r, typeOf ? typeOf(r) : ""));
	}
	return { lines, personalTotalCents, shareTotalCents };
}

// An owner-operator's share of a Personal amount: p% of the cents, to the cent.
function shareCents(percentage, cents) {
	const p = Number(percentage);
	if (!Number.isFinite(p) || p <= 0) return 0;
	return Math.round((p * (Number(cents) || 0)) / 100);
}

// What a row does to the total due, in cents: a deduction costs its amount less
// any share returned; a reversal credits its amount less the share taken back.
function netCents(row) {
	const cents = Number(row.cents) || 0;
	const share = Number(row.share_cents) || 0;
	return row.kind === "deduct" ? share - cents : cents - share;
}

// Which rows a weekly invoice can carry without its total due going below $0:
// oldest first; a row that would take the running total below zero is left for
// the week's correction, or carried to the next weekly invoice with the
// receipt's week on (no row is ever split). baseCents is the invoice's pay plus
// its adjustment, in cents.
function fitLines(baseCents, candidates) {
	const sorted = [...(candidates || [])].sort((a, b) => a.id - b.id);
	let running = Math.round(Number(baseCents) || 0);
	const fit = [];
	const flagged = [];
	for (const r of sorted) {
		const net = netCents(r);
		if (net >= 0 || running + net >= 0) {
			running += net;
			fit.push(r);
		} else {
			flagged.push(r);
		}
	}
	return { fit, flagged, totalCents: running };
}

// fitLines() keeping each reversal with its charge when both are candidates (the
// receipt's week rule): a charge and the rows reversing it fit, or wait, as one,
// oldest charge first, so a credit never stays on an invoice its charge left.
function fitLinePairs(baseCents, candidates) {
	const rows = [...(candidates || [])].sort((a, b) => a.id - b.id);
	const ids = new Set(rows.map((r) => r.id));
	const units = new Map();
	for (const r of rows) {
		const key = r.kind === "reverse" && r.reverses_id != null && ids.has(r.reverses_id) ? r.reverses_id : r.id;
		if (!units.has(key)) units.set(key, []);
		units.get(key).push(r);
	}
	let running = Math.round(Number(baseCents) || 0);
	const fit = [];
	const flagged = [];
	for (const [, members] of [...units].sort((a, b) => a[0] - b[0])) {
		const net = members.reduce((s, r) => s + netCents(r), 0);
		if (net >= 0 || running + net >= 0) {
			running += net;
			fit.push(...members);
		} else {
			flagged.push(...members);
		}
	}
	const byId = (a, b) => a.id - b.id;
	return { fit: fit.sort(byId), flagged: flagged.sort(byId), totalCents: running };
}

// An invoice row's total due in cents: earnings + adjustment + share returned -
// repayments + correction lines (server.js invoiceTotalDue()).
function totalDueCents(row) {
	const r = row || {};
	return Math.round(((r.total_earnings || 0) + (r.adjustment || 0) + (r.personal_share_total || 0) - (r.personal_total || 0) + (r.correction_lines_total || 0)) * 100);
}

// Give a percentage invoice's frozen base back the cents a mark had left out of
// it (an undo before approval). snapshot is the invoice's render data: its
// grossRevenue, deductible, payPercentage, fuelMaintExpenses ({ expenseId,
// date, type, description, amount }) and personalBase ({ expenseId: cents left
// out }). receipt is the line's receipt, to put its row back on the table when
// the mark had taken all of it off. Returns the new snapshot and its pay.
function restoreOwnerOpBase(snapshot, { expenseId, cents, receipt }) {
	const out = JSON.parse(JSON.stringify(snapshot || {}));
	const base = out.personalBase && typeof out.personalBase === "object" ? out.personalBase : {};
	const leftOut = Number(base[expenseId]) || 0;
	const restore = Math.min(Number(cents) || 0, leftOut);
	if (restore <= 0) return { snapshot: out, totalEarnings: Number(out.totalEarnings) || 0, restoredCents: 0 };
	const rows = Array.isArray(out.fuelMaintExpenses) ? out.fuelMaintExpenses : [];
	const row = rows.find((r) => r && Number(r.expenseId) === Number(expenseId));
	if (row) {
		row.amount = (Math.round((Number(row.amount) || 0) * 100) + restore) / 100;
	} else {
		rows.push({ expenseId: Number(expenseId), date: receipt.date || "", type: receipt.type || "", description: receipt.description || "", amount: restore / 100 });
		rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || (Number(a.expenseId) || 0) - (Number(b.expenseId) || 0));
	}
	out.fuelMaintExpenses = rows;
	const remaining = leftOut - restore;
	if (remaining > 0) base[expenseId] = remaining;
	else delete base[expenseId];
	out.personalBase = base;
	out.deductible = (Math.round((Number(out.deductible) || 0) * 100) + restore) / 100;
	out.net = Math.max(0, (Number(out.grossRevenue) || 0) - out.deductible);
	out.totalEarnings = Math.round((out.net * (Number(out.payPercentage) || 0) / 100) * 100) / 100;
	return { snapshot: out, totalEarnings: out.totalEarnings, restoredCents: restore };
}

// "Expenses (ref)" of a weekly invoice (the Invoices screen and its CSV): the
// receipts total it stored, less the Personal part of each of its receipts, in
// dollars. A Personal amount is the driver's, not a company cost. parts: one
// { personalCents, receiptCents } per receipt of the invoice with live in-place
// lines (IN_PLACE_SQL's adj_cents and the receipt's amount in cents); each counts
// at most its receipt, and a part of 0 or less counts nothing. With nothing to
// take off it returns storedTotal itself, untouched. Never below $0.
function expensesRefTotal(storedTotal, parts) {
	let off = 0;
	for (const p of parts || []) {
		const personal = Math.round(Number(p && p.personalCents) || 0);
		const receipt = Math.max(0, Math.round(Number(p && p.receiptCents) || 0));
		if (personal > 0) off += Math.min(personal, receipt);
	}
	if (!(off > 0)) return storedTotal;
	return Math.max(0, Math.round((Number(storedTotal) || 0) * 100) - off) / 100;
}

// Each receipt's live in-place Personal cents (deductions less reversals, voided
// rows left out), as adj_cents by expense_id: what both sources take off the
// receipt's own amount, and what "Expenses (ref)" leaves out.
const IN_PLACE_SQL = "SELECT expense_id, SUM(CASE WHEN kind = 'deduct' THEN cents ELSE -cents END) AS adj_cents"
	+ " FROM expense_personal WHERE voided_at = '' AND in_place = 1 GROUP BY expense_id";

// The SQL of one of the two sources over `columns` (expenses' own columns, from
// PRAGMA table_info, in order). The caller wraps it as "(<sql>) AS expenses".
// Column names are checked to be plain identifiers: they come from the schema,
// never from a request.
function expenseSourceSql(kind, columns) {
	if (kind !== "book" && kind !== "world") throw new Error(`unknown expense source ${JSON.stringify(kind)}`);
	const cols = (columns || []).map(String);
	for (const c of cols) {
		if (!IDENT_RE.test(c)) throw new Error(`expense column ${JSON.stringify(c)} is not a plain identifier`);
	}
	if (!cols.includes("amount") || !cols.includes("id")) throw new Error("the expenses columns must include id and amount");
	const inPlace = IN_PLACE_SQL;
	const firstCols = cols.map((c) => (c === "amount" ? "(e.amount - COALESCE(p.adj_cents, 0) / 100.0) AS amount" : `e.${c} AS ${c}`)).join(", ");
	const first = `SELECT ${firstCols}, 0 AS is_credit, NULL AS personal_id FROM expenses e LEFT JOIN (${inPlace}) p ON p.expense_id = e.id`
		+ " WHERE NOT (COALESCE(p.adj_cents, 0) > 0 AND p.adj_cents >= CAST(ROUND(e.amount * 100) AS INTEGER))";
	if (kind === "world") return first;
	const replaced = {
		amount: "(CASE WHEN ep.kind = 'deduct' THEN -ep.cents ELSE ep.cents END) / 100.0",
		posted_period: "ep.cost_period",
		date: "ep.book_date",
		gallons: "0",
		odometer: "0",
		description: `(CASE WHEN ep.kind = 'deduct' THEN '${CREDIT_LABEL}' ELSE '${REVERSAL_CREDIT_LABEL}' END)`,
		photo_data: "''",
		receipt_hash: "''",
		receipt_details: "''",
	};
	const creditCols = cols.map((c) => `${replaced[c] !== undefined ? replaced[c] : `e.${c}`} AS ${c}`).join(", ");
	const credit = `SELECT ${creditCols}, 1 AS is_credit, ep.id AS personal_id FROM expense_personal ep JOIN expenses e ON e.id = ep.expense_id`
		+ " WHERE ep.voided_at = '' AND ep.in_place = 0";
	return `${first} UNION ALL ${credit}`;
}

module.exports = {
	SCHEMA_SQL,
	CREDIT_LABEL,
	REVERSAL_CREDIT_LABEL,
	INVESTOR_CREDIT_LABEL,
	receiptCents,
	parseAmountCents,
	merchantOf,
	formatDay,
	formatMoney,
	signedMoney,
	lineEntries,
	invoiceLines,
	shareCents,
	netCents,
	fitLines,
	fitLinePairs,
	totalDueCents,
	restoreOwnerOpBase,
	expensesRefTotal,
	IN_PLACE_SQL,
	expenseSourceSql,
};
