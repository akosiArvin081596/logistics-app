#!/usr/bin/env node
/**
 * GET /api/investor/report and GET /api/investor/tax-csv are rate-limited per
 * user (2026-09-30).
 *
 * Each request re-reads the sheet and recomputes a document, and the report also
 * reconciles the payouts ledger; neither route had a limiter. They now have one
 * each, built by investorDocumentLimiter(): statementLimiter's window and cap
 * (20 per 15 minutes), keyed on the session user rather than the IP, and mounted
 * after requireRole so a caller without a session spends nothing.
 *
 * WHAT IS PROVED HERE
 *   §1  source: both routes mount their limiter directly after requireRole, and
 *       the factory's window and cap are statementLimiter's
 *   §2  the factory as it ships, built with the real express-rate-limit: a user's
 *       21st request in the window is 429 with the route's message; a second user
 *       behind the SAME address is not; and the report's bucket is not the tax
 *       CSV's
 *   §3  MUTANTS: the factory keyed on the address (no keyGenerator) throttles the
 *       second user too; a route with its limiter before requireRole fails §1
 *
 * WHY IT LOADS THE CODE OUT OF server.js SOURCE INSTEAD OF require()-ING IT:
 * server.js opens SQLite, reads a service-account key and listens on import.
 * The limiter is driven with plain request and response objects; nothing listens.
 *
 * Run: node scripts/test-investor-document-limits.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
let mutantsCaught = 0;
const failures = [];
function ok(cond, label) {
	if (cond) { pass++; return; }
	failures.push(label);
	console.error(`  ✗ ${label}`);
}
function eq(actual, expected, label) {
	ok(JSON.stringify(actual) === JSON.stringify(expected),
		`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }

function once(haystack, needle, what) {
	const n = haystack.split(needle).length - 1;
	if (n !== 1) throw new Error(`expected ${what} exactly once, found ${n}`);
	return haystack.indexOf(needle);
}
function balancedFrom(src, open) {
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}") { depth--; if (depth === 0) return j + 1; }
	}
	throw new Error("unbalanced braces");
}

const FACTORY_AT = once(SRC, "\nfunction investorDocumentLimiter(", "investorDocumentLimiter()") + 1;
const FACTORY = SRC.slice(FACTORY_AT, balancedFrom(SRC, SRC.indexOf("{", FACTORY_AT)));
const REPORT_LIMITER = SRC.slice(once(SRC, "\nconst investorReportLimiter = ", "investorReportLimiter") + 1).split("\n")[0];
const TAX_LIMITER = SRC.slice(once(SRC, "\nconst investorTaxCsvLimiter = ", "investorTaxCsvLimiter") + 1).split("\n")[0];
const STATEMENT_AT = once(SRC, "\nconst statementLimiter = rateLimit({", "statementLimiter");
const STATEMENT = SRC.slice(STATEMENT_AT, SRC.indexOf("});", STATEMENT_AT));
const ROUTES = {
	report: 'app.get("/api/investor/report", requireRole("Super Admin", "Investor"), investorReportLimiter, async (req, res) => {',
	taxCsv: 'app.get("/api/investor/tax-csv", requireRole("Super Admin", "Investor"), investorTaxCsvLimiter, async (req, res) => {',
};

function build(factorySrc) {
	return new Function("rateLimit", "ipKeyGenerator", `
		${factorySrc}
		${REPORT_LIMITER}
		${TAX_LIMITER}
		return { investorReportLimiter, investorTaxCsvLimiter };
	`)(rateLimit, ipKeyGenerator);
}
// One request through a limiter, as requireRole leaves it: a session user, and
// every user behind the same address.
function hit(limiter, userId) {
	return new Promise((resolve, reject) => {
		const req = { ip: "203.0.113.7", session: { user: { id: userId, role: "Investor" } }, headers: {}, method: "GET", url: "/api/investor/report", app: { get: () => false } };
		const res = {
			statusCode: 200,
			headers: {},
			setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
			getHeader(k) { return this.headers[k.toLowerCase()]; },
			status(s) { this.statusCode = s; return this; },
			send(body) { resolve({ status: this.statusCode, body }); return this; },
			json(body) { resolve({ status: this.statusCode, body }); return this; },
			on() {},
			once() {},
		};
		Promise.resolve(limiter(req, res, (err) => (err ? reject(err) : resolve({ status: 200, body: null })))).catch(reject);
	});
}
async function burst(limiter, userId, n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(await hit(limiter, userId));
	return out;
}

(async () => {
	// ======================================================= §1 source pins
	section("§1 each route's limiter sits directly after requireRole, shaped like statementLimiter");
	const pins = (src) => [once(src, ROUTES.report, "the report route"), once(src, ROUTES.taxCsv, "the tax CSV route")];
	{
		ok(pins(SRC).every((i) => i > 0), "GET /api/investor/report and GET /api/investor/tax-csv: requireRole, then the route's own limiter");
		ok(SRC.indexOf(FACTORY) < SRC.indexOf(ROUTES.taxCsv) && SRC.indexOf(REPORT_LIMITER) < SRC.indexOf(ROUTES.taxCsv), "…both limiters are defined before either route");
		const shape = (s) => [(s.match(/windowMs: ([^,\n]+),/) || [])[1], (s.match(/max: ([^,\n]+),/) || [])[1]];
		eq(shape(FACTORY), shape(STATEMENT), "the factory's window and cap are statementLimiter's (15 minutes, 20)");
		ok(/keyGenerator: \(req\) => \{\s*const id = req\.session\?\.user\?\.id;\s*return id \? `u:\$\{id\}` : `ip:\$\{ipKeyGenerator\(req\.ip\)\}`;/.test(FACTORY),
			"…keyed on the session user (the address only without one)");
	}

	// ============================================== §2 the limiter, driven
	section("§2 per user, per route");
	{
		const L = build(FACTORY);
		const a = await burst(L.investorReportLimiter, 5, 21);
		eq(a.slice(0, 20).map((r) => r.status), Array(20).fill(200), "a user's first 20 report requests in the window pass");
		eq([a[20].status, a[20].body], [429, { error: "Too many report downloads. Try again in a few minutes." }], "…the 21st is 429 with the report's message");
		eq((await hit(L.investorReportLimiter, 41)).status, 200, "a second user behind the same address is not throttled");
		eq((await hit(L.investorTaxCsvLimiter, 5)).status, 200, "the first user's tax CSV has its own bucket");
		const t = await burst(L.investorTaxCsvLimiter, 42, 21);
		eq([t[20].status, t[20].body], [429, { error: "Too many tax document downloads. Try again in a few minutes." }], "the tax CSV's 21st is 429 with its own message");
	}

	// ============================================================ §3 mutants
	section("§3 MUTANTS");
	{
		const KEY = /\n\t\tkeyGenerator: \(req\) => \{[\s\S]*?\n\t\t\},/;
		const byAddress = FACTORY.replace(KEY, "");
		ok(byAddress !== FACTORY, "the address-keyed mutant applied");
		const M = build(byAddress);
		await burst(M.investorReportLimiter, 5, 20);
		const second = await hit(M.investorReportLimiter, 41);
		const caught = second.status === 429;
		ok(caught, "MUTANT caught: keyed on the address, one user's downloads throttle another behind the same address");
		if (caught) mutantsCaught++;

		const before = SRC.replace(ROUTES.report, 'app.get("/api/investor/report", investorReportLimiter, requireRole("Super Admin", "Investor"), async (req, res) => {');
		let refused = false;
		try { pins(before); } catch { refused = true; }
		ok(refused, "MUTANT caught: the report's limiter mounted before requireRole fails the source pin");
		if (refused) mutantsCaught++;
	}

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		for (const f of failures) console.log(`  ✗ ${f}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`PASS — ${pass} assertions passed (${mutantsCaught} mutants caught)`);
})().catch((e) => {
	console.error("FAIL  runner crashed:", e);
	process.exit(1);
});
