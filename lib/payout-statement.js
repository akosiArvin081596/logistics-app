// ============================================================
// Investor Payout Statement (PDF) builder
// ============================================================
// Pure HTML builder for the "download statement" action on a PAID investor
// payout. Kept out of server.js so the layout can be reasoned about (and
// unit-tested) in isolation; server.js fetches the data and pipes the returned
// HTML through lib/pdf-browser.js renderHtmlToPdf().
//
// Nothing here touches the network, the DB, or the filesystem beyond reading
// the logo once at require time.
//
// THE NUMBER THAT MATTERS: a paid payout's figure is FROZEN on the ledger row
// and does NOT always equal netProfit x split%. Two things sit between them —
// loss carry-forward and a manual adjustment (see reconcileInvestorPayouts in
// server.js):
//
//   netProfit x splitPct        -> raw month share   (breakdown.monthShare)
//   raw - lossCarriedIn         -> amount            (frozen at settlement; 0 for
//                                                     a losing month, lossDeferred > 0)
//   max(0, amount + adjustment) -> effectiveAmount   <- WHAT WAS ACTUALLY PAID
//
// The statement prints that entire chain (skipping the carry/adjustment lines
// when they are zero) and states `effectiveAmount` as the amount paid. It must
// never print a recomputed figure as the payment.
//
// Exports:
//   buildPayoutStatementHtml(fields) -> HTML string for renderHtmlToPdf()

"use strict";

const fs = require("fs");
const path = require("path");

const { formatMoney, formatDate, SELLER } = require("./broker-invoice");

// LogisX logo as a data URI so the rendered PDF is self-contained (Puppeteer's
// setContent has no base URL, so a relative src silently fails). Same block as
// lib/broker-invoice.js and lib/policy-renderer.js — duplicated deliberately;
// neither module exports it.
const LOGO_PATH = path.join(__dirname, "..", "logo.png");
const LOGISX_LOGO_URL = fs.existsSync(LOGO_PATH)
	? `data:image/png;base64,${fs.readFileSync(LOGO_PATH).toString("base64")}`
	: "https://app.logisx.com/logo.avif";

// Minimal HTML escape. Mirrors broker-invoice.js's esc (not exported there).
function esc(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// formatMoney renders a negative as "$-970.00"; on a statement that must read
// "−$970.00" like every other figure on the page. Always format through these.
const money = (v) => (num(v) < 0 ? "−" : "") + formatMoney(Math.abs(num(v)));
// A deduction renders as an explicit negative so the investor can SEE money
// coming out; a $0 line stays plain (never "−$0.00"). Mirrors fmtNeg() in
// PayoutsSection.vue so the PDF and the screen read identically.
const negMoney = (v) => (num(v) === 0 ? formatMoney(0) : "−" + formatMoney(Math.abs(num(v))));
// Signed, for an adjustment that can go either way.
const signedMoney = (v) => (num(v) < 0 ? "−" : "+") + formatMoney(Math.abs(num(v)));

// A bare "YYYY-MM-DD" from SQLite parses as UTC midnight, which then renders as
// the PREVIOUS day in any negative-UTC-offset timezone. Parse those as LOCAL so
// a date never slips a calendar box (same guard as fmtDate in PayoutsSection.vue).
function stmtDate(v) {
	if (typeof v === "string") {
		const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (m) return formatDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	}
	return formatDate(v);
}

const sumBy = (arr, key) => (Array.isArray(arr) ? arr : []).reduce((a, x) => a + num(x && x[key]), 0);

// A section's footer total is the SUM OF THE ROWS SHOWN, so the printed list
// always proves its own total. When that disagrees with the frozen headline by
// more than a dollar we say so in print rather than hiding it.
function driftNote(itemsTotal, headline) {
	const diff = num(itemsTotal) - num(headline);
	if (Math.abs(diff) <= 1) return "";
	return `<div class="note">Listed items total ${esc(money(itemsTotal))}, which differs by ${esc(
		money(Math.abs(diff)),
	)} from the ${esc(money(headline))} shown in the summary above. The amount actually paid is the settled figure on page 1 and is unaffected.</div>`;
}

// "pickup → dropoff", city level (the push site in computeInvestorMonthlyEarnings
// reduces both ends via resolveCityState — a street here belongs to the broker's
// customer and must never reach an investor).
// ⚠️ A HALF-KNOWN ROUTE PRINTS THE ARROW AND AN EM DASH, NOT THE LONE END. The old
// `return a || b` rendered one known end as a bare city, so a load whose drop-off
// is genuinely absent (load 550303758's Drop-off Address cell is empty in the
// sheet — a known ingestion gap from the retired LLM-distance path, which no
// parser will ever fill) read as a load with ONE location rather than one with a
// missing end. Mirrors client/src/components/investor/PayoutsSection.vue routeText
// so the PDF and the on-screen drill-down cannot disagree.
function routeText(l) {
	const a = String((l && l.pickup) || "").trim();
	const b = String((l && l.dropoff) || "").trim();
	if (!a && !b) return "—";
	return `${a || "—"} → ${b || "—"}`;
}

// ------------------------------------------------------------
// buildPayoutStatementHtml
// ------------------------------------------------------------
// fields:
//   investorName, investorCompany, periodLabel, period, status,
//   paidAt, paidBy, dueDate,
//   breakdown { revenue, driverPay, fixedCosts, tripExpenses, netProfit,
//               splitPct, monthShare } | null,
//   lossCarriedIn, lossDeferred, adjustment, adjustmentNote,
//   amount, effectiveAmount,
//   detail { revenueLoads[], driverPayRows[], fixedCostItems[], tripExpenseItems[] },
//   statementNo, generatedAt
function buildPayoutStatementHtml(fields = {}) {
	const investorName = esc(fields.investorName || "Investor");
	const investorCompany = esc(fields.investorCompany || "");
	const periodLabel = esc(fields.periodLabel || fields.period || "");
	const statementNo = esc(fields.statementNo || "");
	const generatedAt = esc(formatDate(fields.generatedAt || new Date()));
	const paidAt = esc(stmtDate(fields.paidAt) || "");
	const paidBy = esc(fields.paidBy || "");
	// A correction recorded after the money went out: the net is NOT what was
	// wired, so the pill must not call it "Amount Paid".
	const adjustedAfterPaid = !!fields.adjustedAfterPaid;
	const adjustedAt = esc(stmtDate(fields.adjustedAt) || "");
	const status = esc(String(fields.status || "paid").toUpperCase());

	// TWO MODES, and getting this wrong is the worst bug this file can have.
	//
	// Statements used to be issued only after a payout was marked paid, so every
	// figure on the page could safely be called "Amount Paid". They are now issued
	// when the PERIOD IS FINALIZED — the client's ask: "let's not wait till after
	// it's paid to publish a statement... then a statement is published of what
	// the final number's going to be." So a statement can now legitimately reach
	// an investor BEFORE any money has moved.
	//
	// Mode is driven by paidAt (did money actually move?), never by the period
	// lock — a finalized month whose payout has not been sent yet must not print
	// "Paid on", a paid-on date, or a recorded-by name.
	const isPaid = !!fields.paidAt;
	const finalizedAt = esc(stmtDate(fields.finalizedAt) || "");
	const dueDate = esc(stmtDate(fields.dueDate) || "");

	const b = fields.breakdown || null;
	const lossCarriedIn = num(fields.lossCarriedIn);
	const lossDeferred = num(fields.lossDeferred);
	const adjustment = num(fields.adjustment);
	const amount = num(fields.amount);
	const effectiveAmount = num(fields.effectiveAmount);
	const detail = fields.detail || {};

	// ---- Page 1: the waterfall -------------------------------------------
	// CRITICAL: the composition rows (breakdown / carry-forward) are a LIVE
	// recompute of a historical month, while `amount` was FROZEN at settlement.
	// They normally agree, but they can drift on their own — getMonthlyFixedCosts
	// filters on trucks.status='Active' and splitPct reads the CURRENT config, so
	// retiring a truck or renegotiating the split shifts the recompute of an
	// already-paid month. So we always print the frozen settled amount as its own
	// row (making `amount + adjustment = AMOUNT PAID` literally visible), and
	// disclose the gap in print whenever the recompute no longer lands on it.
	// The settled figure is the one that was paid; it always wins.
	const composed = b ? Math.round(num(b.monthShare) - lossCarriedIn) : null;
	const drifted = composed != null && Math.abs(composed - Math.round(amount)) > 1;

	let waterfallRows = "";
	if (b) {
		const splitPct = num(b.splitPct);
		waterfallRows += `
			<tr><td>Revenue</td><td class="num">${esc(money(b.revenue))}</td></tr>
			<tr><td class="ded">&minus; Driver Pay</td><td class="num ded">${esc(negMoney(b.driverPay))}</td></tr>
			<tr><td class="ded">&minus; Fixed Costs</td><td class="num ded">${esc(negMoney(b.fixedCosts))}</td></tr>
			<tr><td class="ded">&minus; Trip Expenses</td><td class="num ded">${esc(negMoney(b.tripExpenses))}</td></tr>`;
		// Both feed netProfit server-side, so omitting them would make the printed
		// subtraction fail to add up the moment either is ever non-zero.
		if (num(b.maintFundCost) > 0) {
			waterfallRows += `
			<tr><td class="ded">&minus; Maintenance Fund</td><td class="num ded">${esc(negMoney(b.maintFundCost))}</td></tr>`;
		}
		if (num(b.complianceCost) > 0) {
			waterfallRows += `
			<tr><td class="ded">&minus; Compliance / IFTA</td><td class="num ded">${esc(negMoney(b.complianceCost))}</td></tr>`;
		}
		waterfallRows += `
			<tr class="rule"><td class="strong">Net Profit</td><td class="num strong">${esc(money(b.netProfit))}</td></tr>
			<tr><td class="sub">&times; ${esc(String(splitPct))}% investor split</td><td class="num sub"></td></tr>
			<tr><td>Your share of net profit</td><td class="num">${esc(money(b.monthShare))}</td></tr>`;

		if (lossCarriedIn > 0) {
			waterfallRows += `
			<tr><td class="ded">&minus; Earlier loss applied<div class="cap">A shortfall from an earlier month absorbed by this one.</div></td><td class="num ded">${esc(negMoney(lossCarriedIn))}</td></tr>`;
		}
		if (lossDeferred > 0) {
			waterfallRows += `
			<tr><td>Loss carried forward<div class="cap">This month ran at a loss, so nothing is payable. The shortfall is carried against later months rather than billed back to you.</div></td><td class="num">+${esc(formatMoney(lossDeferred))}</td></tr>`;
		}
	}

	// The frozen ledger figure — printed for EVERY statement so the arithmetic
	// that produced the payment is always on the page.
	waterfallRows += `
			<tr class="rule"><td class="strong">Settled amount for ${periodLabel}${
				drifted
					? `<div class="cap">Recorded on the ledger when this period was settled. The composition above reflects our records as of ${generatedAt} and now computes to ${esc(money(composed))}; the settled amount is ${isPaid ? "what was paid" : "the amount payable"}.</div>`
					: ""
			}</td><td class="num strong">${esc(money(amount))}</td></tr>`;
	if (adjustment !== 0) {
		waterfallRows += `
			<tr><td class="${adjustment < 0 ? "ded" : ""}">${adjustment < 0 ? "&minus;" : "+"} Adjustment${
				fields.adjustmentNote ? `<div class="cap">${esc(fields.adjustmentNote)}</div>` : ""
			}</td><td class="num ${adjustment < 0 ? "ded" : ""}">${esc(signedMoney(adjustment))}</td></tr>`;
	}

	// A month that aged out of the live earnings window still has a frozen,
	// truthful settlement — issue the statement, but never invent a composition.
	// Both branches share the settled-amount + adjustment rows appended above.
	const summaryBlock = `<table class="items">
		<thead><tr><th>${b ? "How your share is calculated" : "Settlement"}</th><th class="num">Amount</th></tr></thead>
		<tbody>${waterfallRows}</tbody>
	</table>
	${b ? "" : `<div class="note">This period predates the current earnings window, so its itemized composition is no longer available to re-derive. The amount shown is the settled figure recorded on the payout ledger.</div>`}`;

	// ---- Page 2+: supporting detail ---------------------------------------
	const loads = Array.isArray(detail.revenueLoads) ? detail.revenueLoads : [];
	const payRows = Array.isArray(detail.driverPayRows) ? detail.driverPayRows : [];
	const truckRows = Array.isArray(detail.fixedCostItems) ? detail.fixedCostItems : [];
	const expRows = Array.isArray(detail.tripExpenseItems) ? detail.tripExpenseItems : [];

	const section = (title, count, noun, tableHtml, itemsTotal, headline, totalLabel) => {
		if (!count) {
			// An empty list against a non-zero headline is the single most misleading
			// thing this page can print ("No loads recorded" next to a paid figure),
			// so the drift disclosure runs HERE too — not just on populated sections.
			return `<div class="sect"><h2>${esc(title)}</h2><div class="empty">No ${esc(noun)} recorded for this period.</div>${driftNote(0, headline)}</div>`;
		}
		return `<div class="sect">
			<h2>${esc(title)} <span class="count">${count} ${esc(count === 1 ? noun.replace(/s$/, "") : noun)}</span></h2>
			${tableHtml}
			<div class="sect-total"><span>${esc(totalLabel)}</span><span class="num">${esc(money(itemsTotal))}</span></div>
			${driftNote(itemsTotal, headline)}
		</div>`;
	};

	const revenueTable = `<table class="items detail">
		<thead><tr><th>Load #</th><th>Date</th><th>Driver / Truck</th><th>Route</th><th class="num">Amount</th></tr></thead>
		<tbody>${loads
			.map(
				(l) => `<tr>
			<td class="mono">${esc(l.loadId || "—")}</td>
			<td>${esc(stmtDate(l.date) || "—")}</td>
			<td>${esc(l.driver || "—")}${l.truck ? `<div class="item-sub">#${esc(l.truck)}</div>` : ""}</td>
			<td class="route">${esc(routeText(l))}</td>
			<td class="num">${esc(money(l.amount))}</td>
		</tr>`,
			)
			.join("")}</tbody></table>`;

	const payTable = `<table class="items detail">
		<thead><tr><th>Driver</th><th>Basis</th><th class="num">Pay</th></tr></thead>
		<tbody>${payRows
			.map(
				(r) => `<tr>
			<td>${esc(r.driver || "—")}</td>
			<td>${
				r.payType === "percentage"
					? `${esc(String(num(r.payPercentage)))}% of net revenue`
					: `${esc(String(num(r.activeDays)))} day${num(r.activeDays) === 1 ? "" : "s"} &times; ${esc(money(r.dailyRate))}/day`
			}</td>
			<td class="num">${esc(money(r.pay))}</td>
		</tr>`,
			)
			.join("")}</tbody></table>`;

	const truckTable = `<table class="items detail">
		<thead><tr><th>Truck</th><th class="num">Insurance</th><th class="num">ELD</th><th class="num">Truck Payment</th><th class="num">IRP</th><th class="num">HVUT</th><th class="num">Total</th></tr></thead>
		<tbody>${truckRows
			.map(
				(t) => `<tr>
			<td class="mono">${t.truck ? "#" + esc(t.truck) : "—"}</td>
			<td class="num">${esc(money(t.insurance))}</td>
			<td class="num">${esc(money(t.eld))}</td>
			<td class="num">${esc(money(t.truckPayment))}</td>
			<td class="num">${esc(money(t.irp))}</td>
			<td class="num">${esc(money(t.hvut))}</td>
			<td class="num strong">${esc(money(t.total))}</td>
		</tr>`,
			)
			.join("")}</tbody></table>`;

	const expTable = `<table class="items detail">
		<thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Amount</th></tr></thead>
		<tbody>${expRows
			.map((e) => {
				const meta = [e.driver, [e.city, e.state].filter(Boolean).join(", "), e.truck ? "#" + e.truck : ""]
					.filter(Boolean)
					.join(" · ");
				return `<tr>
			<td>${esc(stmtDate(e.date) || "—")}</td>
			<td>${esc(e.type || "Other")}</td>
			<td>${esc(e.description || "—")}${meta ? `<div class="item-sub">${esc(meta)}</div>` : ""}</td>
			<td class="num">${esc(money(e.amount))}</td>
		</tr>`;
			})
			.join("")}</tbody></table>`;

	// Only itemize when we have the composition this payout was settled on. For an
	// aged-out month the loaders would still return TODAY's truck roster and
	// expense rows, which is not what was settled — page 1 already says the
	// composition can't be re-derived, so an appendix here would contradict it.
	const appendix = !b ? "" : `
	<div class="appendix">
		<h1 class="apx-title">Supporting detail &mdash; ${periodLabel}</h1>
		<p class="apx-intro">Every figure in the summary, itemized. Each section totals the rows listed below it.</p>
		${section("Revenue", loads.length, "loads", revenueTable, sumBy(loads, "amount"), b && b.revenue, "Total Revenue")}
		${section("Driver Pay", payRows.length, "drivers", payTable, sumBy(payRows, "pay"), b && b.driverPay, "Total Driver Pay")}
		${section("Fixed Costs", truckRows.length, "trucks", truckTable, sumBy(truckRows, "total"), b && b.fixedCosts, "Total Fixed Costs")}
		${section("Trip Expenses", expRows.length, "expenses", expTable, sumBy(expRows, "amount"), b && b.tripExpenses, "Total Trip Expenses")}
	</div>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LogisX Payout Statement ${statementNo}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
<style>
@page { size: letter; margin: 0.6in; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font-family: 'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
	color: #1f2937;
	font-size: 13px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
}
.doc { width: 100%; }

/* --- Masthead --- */
.masthead { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; }
.brand img { height: 40px; width: auto; display: block; }
.masthead .meta { text-align: right; }
.masthead .meta .title { font-size: 30px; font-weight: 800; letter-spacing: 2px; color: #0f2847; line-height: 1.1; margin-bottom: 8px; }
.masthead .meta .row { font-size: 12px; color: #475569; }
.masthead .meta .row strong { color: #1f2937; font-weight: 700; }

/* --- Parties --- */
.parties { display: flex; justify-content: space-between; margin-bottom: 22px; }
.parties .block { font-size: 12px; }
.parties .label { font-size: 10px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: #94a3b8; margin-bottom: 6px; }
.parties .name { font-weight: 700; font-size: 14px; color: #0f2847; }
.parties .line { color: #475569; }

/* --- Period band --- */
.band { display: flex; gap: 28px; align-items: center; border-top: 2px solid #0f2847; border-bottom: 1px solid #e2e8f0; padding: 12px 0; margin-bottom: 22px; }
.band .k { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #94a3b8; display: block; }
.band .v { font-size: 13px; font-weight: 700; color: #0f2847; }
.stamp { display: inline-block; padding: 3px 12px; border-radius: 999px; background: #f0fdf4; border: 1px solid #86efac; color: #166534; font-size: 11px; font-weight: 800; letter-spacing: 1px; }

/* --- Tables --- */
table.items { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
table.items thead th {
	background: #0f2847; color: #fff; font-size: 10px; font-weight: 700;
	letter-spacing: 1px; text-transform: uppercase; text-align: left; padding: 10px 14px;
}
table.items thead th.num { text-align: right; }
table.items tbody td { padding: 10px 14px; border-bottom: 1px solid #e2e8f0; vertical-align: top; font-size: 12px; color: #334155; }
table.items tbody td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.items tbody td.ded { color: #b91c1c; }
table.items tbody td.strong { font-weight: 800; color: #0f2847; font-size: 13px; }
table.items tbody tr.rule td { border-top: 2px solid #0f2847; }
table.items tbody td.sub { color: #64748b; font-size: 11px; border-bottom: none; padding-top: 4px; padding-bottom: 4px; }
.cap { color: #64748b; font-size: 10.5px; font-weight: 400; margin-top: 3px; line-height: 1.4; }
.item-sub { color: #64748b; font-size: 10.5px; margin-top: 2px; }
.mono { font-variant-numeric: tabular-nums; }
.route { color: #475569; font-size: 11px; }

/* --- Amount paid --- */
.totals { display: flex; justify-content: flex-end; margin-bottom: 10px; }
.totals .box { width: 300px; }
.totals .pill { display: flex; justify-content: space-between; align-items: center; background: #0f2847; color: #fff; border-radius: 8px; padding: 13px 16px; }
.totals .pill .lbl { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; }
.totals .pill .amt { font-size: 19px; font-weight: 800; font-variant-numeric: tabular-nums; }
.paidmeta { text-align: right; font-size: 11px; color: #475569; margin-bottom: 26px; }

.note { font-size: 10.5px; color: #64748b; font-style: italic; line-height: 1.5; margin-bottom: 14px; }
.foot { border-top: 1px solid #e2e8f0; padding-top: 12px; font-size: 10.5px; color: #94a3b8; line-height: 1.5; }

/* --- Appendix --- */
.appendix { page-break-before: always; }
.apx-title { font-size: 17px; font-weight: 800; color: #0f2847; margin: 0 0 4px; letter-spacing: 0.2px; }
.apx-intro { font-size: 11px; color: #64748b; margin: 0 0 20px; }
.sect { margin-bottom: 26px; page-break-inside: auto; }
.sect h2 { font-size: 12px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; color: #0f2847; margin: 0 0 8px; page-break-after: avoid; }
.sect h2 .count { font-weight: 600; color: #94a3b8; letter-spacing: 0; text-transform: none; font-size: 11px; margin-left: 6px; }
.sect-total { display: flex; justify-content: space-between; padding: 9px 14px; background: #f1f5f9; border-radius: 6px; font-size: 12px; font-weight: 800; color: #0f2847; margin-top: -6px; }
.sect-total .num { font-variant-numeric: tabular-nums; }
.empty { font-size: 11.5px; color: #94a3b8; font-style: italic; padding: 8px 0; }
table.items.detail { margin-bottom: 8px; }
table.items.detail thead th { padding: 8px 12px; font-size: 9px; }
table.items.detail tbody td { padding: 7px 12px; font-size: 11px; }
/* Repeat headers across page breaks and never split a row. */
table.items.detail thead { display: table-header-group; }
table.items.detail tfoot { display: table-footer-group; }
table.items.detail tr { page-break-inside: avoid; }
</style>
</head>
<body>
<div class="doc">

	<div class="masthead">
		<div class="brand"><img src="${LOGISX_LOGO_URL}" alt="LogisX"></div>
		<div class="meta">
			<div class="title">PAYOUT STATEMENT</div>
			<div class="row">Statement # : <strong>${statementNo}</strong></div>
			<div class="row">Issued: <strong>${generatedAt}</strong></div>
		</div>
	</div>

	<div class="parties">
		<div class="block from">
			<div class="label">From</div>
			<div class="name">${esc(SELLER.companyName)}</div>
			<div class="line">${esc(SELLER.email)}</div>
			<div class="line">${esc(SELLER.phone)}</div>
		</div>
		<div class="block to">
			<div class="label">Statement For</div>
			<div class="name">${investorName}</div>
			${investorCompany ? `<div class="line">${investorCompany}</div>` : ""}
		</div>
	</div>

	<div class="band">
		<div><span class="k">Period</span><span class="v">${periodLabel}</span></div>
		<div><span class="k">Status</span><span class="stamp">${isPaid ? status : "FINAL"}</span></div>
		${isPaid
			? `<div><span class="k">Paid on</span><span class="v">${paidAt}</span></div>`
			: `${finalizedAt ? `<div><span class="k">Finalized</span><span class="v">${finalizedAt}</span></div>` : ""}${dueDate ? `<div><span class="k">Payment due</span><span class="v">${dueDate}</span></div>` : ""}`}
	</div>

	${summaryBlock}

	<div class="totals">
		<div class="box">
			<div class="pill"><span class="lbl">${
				!isPaid ? "Final Amount" : adjustedAfterPaid ? "Net Settled" : "Amount Paid"
			}</span><span class="amt">${esc(money(effectiveAmount))}</span></div>
		</div>
	</div>
	<div class="paidmeta">${
		!isPaid
			// Not yet paid: say so plainly. An investor holding this document must
			// not be able to read it as a receipt.
			? `Final settlement for ${periodLabel} &mdash; this is the amount payable.${dueDate ? ` Payment due ${dueDate}.` : ""} This statement is not a receipt; a payment confirmation follows once the payout is sent.`
			: adjustedAfterPaid
				? `${esc(money(amount))} paid on ${paidAt}${adjustedAt ? ` &middot; correction recorded ${adjustedAt}` : ""} &middot; net ${esc(money(effectiveAmount))}`
				: `Paid on ${paidAt}${paidBy ? ` &middot; recorded by ${paidBy}` : ""}`
	}</div>

	${b ? `<div class="note">Your trip expenses are deducted before the split, so the share above is already net of them.</div>` : ""}

	<div class="foot">
		${isPaid
			? "This statement reflects the settled payout recorded on the LogisX investor ledger for the period shown."
			: `This period is closed and its figures are final &mdash; receipts dated in ${periodLabel} that arrive from now on are booked to the current open month. This statement reflects the payout recorded on the LogisX investor ledger for the period shown.`}
		Questions? Contact ${esc(SELLER.email)} or ${esc(SELLER.phone)}.
	</div>

	${appendix}

</div>
</body>
</html>`;
}

module.exports = { buildPayoutStatementHtml };
