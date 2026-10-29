#!/usr/bin/env node
/**
 * T23: every money or fuel figure over receipts reads one of the two shared
 * sources, so a Personal receipt's personal part leaves every view at once.
 *
 *   §1 no query in server.js sums amount or gallons straight from `expenses`,
 *      apart from the named exceptions below (they count receipts as stored on
 *      purpose)
 *   §2 the settlement views read expenseFrom("book"): the payout ledger and
 *      Financials (gatherLedgerScopeFacts), percentage pay
 *      (getDeductibleExpensesByDriverMonth), the investor portal, the tax CSV
 *      and the investor report
 *   §3 the operational views read expenseFrom("world"): Financials' fuel card,
 *      fuel analytics, mileage and its detail, the KPI fuel receipts, the
 *      cost-per-gallon band, the investor's receipt list; lib/expense-analytics.js
 *      reads no table name of its own and server.js hands it the world source
 *   §4 the hygiene readers keep reading receipts as stored (a personal receipt
 *      is still a receipt): duplicates, fuel-event matching, gallons recovery
 *
 * Pure: reads source text only.
 * Run: node scripts/test-expense-book-sources.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();
const { makeChecker } = require("./lib/personal-world");
const { check, section, finish } = makeChecker();

function routeRegion(head) {
	const a = SRC.indexOf(`\n${head}`);
	if (a < 0) return "";
	return SRC.slice(a + 1, SRC.indexOf("\n});\n", a + 1));
}
function fnRegion(name) {
	const needles = [`\nfunction ${name}(`, `\nasync function ${name}(`];
	const n = needles.find((x) => SRC.includes(x));
	if (!n) return "";
	const a = SRC.indexOf(n) + 1;
	return SRC.slice(a, SRC.indexOf("\n}\n", a));
}

// Each prepared statement's SQL: from a `.prepare(` to the matching close paren.
function statements(text) {
	const out = [];
	let i = 0;
	while ((i = text.indexOf(".prepare(", i)) !== -1) {
		let depth = 0;
		let j = i + ".prepare".length;
		for (; j < text.length; j++) {
			const c = text[j];
			if (c === "(") depth++;
			else if (c === ")") { depth--; if (depth === 0) break; }
		}
		out.push({ at: i, sql: text.slice(i, j + 1) });
		i = j;
	}
	return out;
}
const SUMS_RE = /SUM\(\s*(?:COALESCE\(\s*)?(?:\w+\.)?(?:amount|gallons)\b/i;
const PLAIN_RE = /FROM\s+expenses\b/;
const lineOf = (at) => SRC.slice(0, at).split("\n").length;

// Counted as stored on purpose, each for its own reason.
const EXCEPTIONS = [
	// The reopen notice counts the receipts posted forward out of a month, as stored.
	"COALESCE(posted_period,'') != '' AND substr(COALESCE(NULLIF(date,''), created_at), 1, 7) = ?",
];

section("§1 no sum straight from expenses outside the named exceptions");
{
	const offenders = statements(SRC)
		.filter((s) => PLAIN_RE.test(s.sql) && SUMS_RE.test(s.sql))
		.filter((s) => !EXCEPTIONS.some((e) => s.sql.includes(e)))
		.map((s) => `server.js:${lineOf(s.at)}`);
	check("every amount/gallons SUM over receipts reads a shared source", offenders, []);
	check("the source helper exists once", (SRC.match(/\nfunction expenseFrom\(/g) || []).length, 1);
}

section("§2 settlement views read the books");
for (const [label, region] of [
	["the payout ledger and Financials (gatherLedgerScopeFacts)", fnRegion("gatherLedgerScopeFacts")],
	["percentage pay (getDeductibleExpensesByDriverMonth)", fnRegion("getDeductibleExpensesByDriverMonth")],
	["the investor portal (GET /api/investor)", routeRegion('app.get("/api/investor", requireRole("Super Admin", "Investor"), async (req, res) => {')],
	["the tax CSV", routeRegion('app.get("/api/investor/tax-csv", requireRole("Super Admin", "Investor"), investorTaxCsvLimiter, async (req, res) => {')],
	["the investor report", routeRegion('app.get("/api/investor/report", requireRole("Super Admin", "Investor"), investorReportLimiter, async (req, res) => {')],
]) {
	// A receipt sum reads the plain table, expenseFrom("book") itself, or a local
	// holding it (gatherLedgerScopeFacts names it bookFrom).
	const book = /FROM \$\{(?:expenseFrom\("book"\)|bookFrom)\}/;
	const stmts = statements(region).filter((s) => SUMS_RE.test(s.sql) && (PLAIN_RE.test(s.sql) || book.test(s.sql)));
	check(`${label}: every receipt sum reads the books source`,
		[stmts.length > 0, stmts.every((s) => book.test(s.sql) && !PLAIN_RE.test(s.sql)), region.includes('expenseFrom("book")')], [true, true, true]);
}

section("§3 operational views read the world");
for (const [label, region, re] of [
	["Financials' fuel card", routeRegion('app.get("/api/financials", requireRole("Super Admin"), async (req, res) => {'), /COUNT\(\*\) AS fills/],
	["fuel analytics", routeRegion('app.get("/api/expenses/fuel-analytics", requireRole("Super Admin", "Dispatcher"), fuelAnalyticsLimiter, (req, res) => {'), /LOWER\(type\) = 'fuel'/],
	["mileage", SRC.slice(SRC.indexOf('app.get("/api/analytics/mileage",'), SRC.indexOf('app.get("/api/analytics/mileage/detail",')), /LOWER\(type\) = 'fuel'/],
	["mileage detail", SRC.slice(SRC.indexOf('app.get("/api/analytics/mileage/detail",'), SRC.indexOf("\n});\n", SRC.indexOf('app.get("/api/analytics/mileage/detail",'))), /LOWER\(type\) = 'fuel'/],
	["the KPI fuel receipts", fnRegion("kpiGatherDbInputs"), /LOWER\(type\) = 'fuel'/],
	["the cost-per-gallon band", fnRegion("fuelCpgBandFromFleet"), /LOWER\(type\) = 'fuel'/],
	["the investor's receipt list", routeRegion('app.get("/api/investor/expenses", requireRole("Super Admin", "Investor"), async (req, res) => {'), /photo_data/],
]) {
	const hit = region.split("\n").map((l, i) => ({ l, i })).filter((x) => re.test(x.l));
	const window = hit.length ? region.split("\n").slice(Math.max(0, hit[0].i - 4), hit[0].i + 4).join("\n") : "";
	check(`${label}: reads expenseFrom("world"), not the plain table`, [window.includes('expenseFrom("world")'), PLAIN_RE.test(window)], [true, false]);
}
{
	const lib = fs.readFileSync(path.join(ROOT, "lib", "expense-analytics.js"), "utf8");
	check("lib/expense-analytics.js names no table of its own", PLAIN_RE.test(lib), false);
	const analytics = routeRegion('app.get("/api/expenses/analytics", requireRole("Super Admin", "Dispatcher"), (req, res) => {');
	check("GET /api/expenses/analytics hands it the world source", /aggregateExpenses\(db, filters, \{ source: expenseFrom\("world"\) \}\)/.test(analytics), true);
	check("the AI query and the insights hand it the world source",
		[/runQuerySpec\(db, spec, \{ source: expenseFrom\("world"\) \}\)/.test(SRC), /buildInsightsAggregates\(db, APP_TIMEZONE, \{ source: expenseFrom\("world"\) \}\)/.test(SRC)], [true, true]);
}

section("§4 hygiene readers keep receipts as stored");
for (const name of ["findDuplicateReceiptGroups", "runFuelEventMatching"]) {
	const region = fnRegion(name);
	if (!region) continue;
	check(`${name} reads receipts as stored`, region.includes("expenseFrom("), false);
}
check("the close fingerprint still hashes receipts as stored, and the Personal lines beside them",
	[/FROM expenses WHERE \$\{EXPENSE_PERIOD_EXPR\} IN/.test(fnRegion("closingFingerprint")), /expense_personal/.test(fnRegion("closingFingerprint"))], [true, true]);

finish();
