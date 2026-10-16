#!/usr/bin/env node
/**
 * scripts/pending/test-invoice-lines-admin-only.js — the three invoice-lines
 * routes are Super Admin only, and dormant with the flag off.
 *
 * PENDING until the server.js half of B20 lands; then its checks join
 * scripts/test-invoice-draft-admin-only.js (whose list of invoice-draft paths
 * grows by these three in the same change) and this file goes.
 * SERVER_JS=<file> runs it against another copy of server.js.
 *
 *   GET  /api/loads/:loadId/invoice-lines
 *   POST /api/loads/:loadId/invoice-lines
 *   POST /api/loads/:loadId/invoice-lines/:id/void
 *
 * The real requireRole is the FIRST middleware (Dispatcher, Driver and Investor
 * get 403 there, no session 401, before the flag is even read: "Dispatchers get
 * no broker contact data at all", and these lines live on broker invoices). The
 * real brokerInvoiceLinesGate is the SECOND: with BROKER_INVOICE_LINES_ENABLED
 * off it hands the request on with next("route"), so the path answers as it
 * does today. The handler is captured, never run.
 *
 * Pure: no server, no port, no app.db, no network.
 * Run: node scripts/pending/test-invoice-lines-admin-only.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

// The repo root, found from here, so the file runs from scripts/pending/ now and
// from scripts/ once it moves.
function findRoot(start) {
	for (let d = start; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "server.js")) && fs.existsSync(path.join(d, "package.json"))) return d;
		if (path.dirname(d) === d) throw new Error(`no repo root above ${start}`);
	}
}
const ROOT = findRoot(__dirname);
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}

function liftFn(name) {
	const at = SRC.indexOf(`\nfunction ${name}(`);
	if (at < 0) return null;
	const open = SRC.indexOf("{", SRC.indexOf(")", at));
	let depth = 0;
	for (let i = open; i < SRC.length; i++) {
		if (SRC[i] === "{") depth++;
		else if (SRC[i] === "}" && --depth === 0) return SRC.slice(at + 1, i + 1);
	}
	return null;
}
const ROUTES = [
	["get", "/api/loads/:loadId/invoice-lines"],
	["post", "/api/loads/:loadId/invoice-lines"],
	["post", "/api/loads/:loadId/invoice-lines/:id/void"],
];
const lines = SRC.split("\n");
function registration(verb, p) {
	const head = `app.${verb}(${JSON.stringify(p)},`;
	const s = lines.findIndex((l) => l.startsWith(head));
	if (s < 0 || lines.filter((l) => l.startsWith(head)).length !== 1) return null;
	let e = s;
	while (e < lines.length && lines[e] !== ");" && lines[e] !== "});") e++;
	return lines.slice(s, e + 1).join("\n");
}

const roleSrc = liftFn("requireRole");
const gateSrc = liftFn("brokerInvoiceLinesGate");
ok("requireRole is in server.js", !!roleSrc);
ok("brokerInvoiceLinesGate is in server.js (the server.js half of B20 adds it)", !!gateSrc);
const requireRole = roleSrc ? new Function(`${roleSrc}\nreturn requireRole;`)() : null;
const brokerInvoice = require(path.join(ROOT, "lib", "broker-invoice.js"));

const USERS = {
	"Super Admin": { id: 1, role: "Super Admin", username: "super_admin" },
	Dispatcher: { id: 2, role: "Dispatcher", username: "dispatch1" },
	Driver: { id: 3, role: "Driver", username: "LogisX-1001", driverName: "Test Driver" },
	Investor: { id: 4, role: "Investor", username: "investor1" },
};
function build(text, env) {
	const processStub = { env: { ...env } };
	const gate = new Function("brokerInvoice", "process", `${gateSrc}\nreturn brokerInvoiceLinesGate;`)(brokerInvoice, processStub);
	let captured = null;
	const app = { get: (p, ...chain) => { captured = chain; }, post: (p, ...chain) => { captured = chain; } };
	new Function("app", "requireRole", "brokerInvoiceLinesGate", text)(app, requireRole, gate);
	return captured;
}
function call(chain, verb, user) {
	const req = {
		method: verb.toUpperCase(), path: "/api/loads/L-100/invoice-lines", url: "/api/loads/L-100/invoice-lines", originalUrl: "/api/loads/L-100/invoice-lines",
		params: { loadId: "L-100", id: "1" }, query: {}, body: {}, headers: { "x-requested-with": "XMLHttpRequest" },
		route: { path: "/api/loads/:loadId/invoice-lines" }, session: user ? { user: { ...user } } : {},
	};
	const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; }, setHeader() {}, end() { return this; } };
	const steps = [];
	for (const mw of chain.slice(0, -1)) {
		let arg = "stopped";
		mw(req, res, (a) => { arg = a === undefined ? "next" : a; });
		steps.push(arg);
		if (arg !== "next") break;
	}
	return { steps, status: res.statusCode, reached: steps.length === chain.length - 1 && steps.every((s) => s === "next") };
}

for (const [verb, p] of ROUTES) {
	const text = registration(verb, p);
	const label = `${verb.toUpperCase()} ${p}`;
	ok(`${label} is registered once`, !!text);
	if (!text || !requireRole || !gateSrc) continue;
	ok(`${label}: requireRole("Super Admin") first, the flag gate second`, new RegExp(`^app\\.${verb}\\("[^"]+", requireRole\\("Super Admin"\\), brokerInvoiceLinesGate, `).test(text));
	const on = build(text, { BROKER_INVOICE_LINES_ENABLED: "true" });
	const off = build(text, {});
	ok(`${label}: Super Admin reaches the handler with the flag on`, call(on, verb, USERS["Super Admin"]).reached);
	const sa = call(off, verb, USERS["Super Admin"]);
	ok(`${label}: with the flag off, Super Admin is handed on (next("route")) at the gate`, sa.steps.join() === "next,route", sa.steps.join());
	for (const role of ["Dispatcher", "Driver", "Investor"]) {
		for (const [flag, chain] of [["on", on], ["off", off]]) {
			const r = call(chain, verb, USERS[role]);
			ok(`${label}: ${role} gets 403 at the role gate, flag ${flag}`, !r.reached && r.status === 403 && r.steps.length === 1, `${r.status} ${r.steps.join()}`);
		}
	}
	const anon = call(on, verb, null);
	ok(`${label}: no session gets 401`, !anon.reached && anon.status === 401, String(anon.status));
	ok(`${label}: no cost-tier guard (refuseCrossSite) or limiter: a database read or write`, !/refuseCrossSite|Limiter/.test(text.split("\n")[0]));
}
// The gate reads the flag the module's way.
ok("the gate is linesEnabled(process.env) ? next() : next(\"route\")",
	!!gateSrc && /return brokerInvoice\.invoiceLines\.linesEnabled\(process\.env\) \? next\(\) : next\("route"\);/.test(gateSrc));

// DISCRIMINATION: re-admit Dispatcher, require the 403 check to flip.
if (requireRole && gateSrc) {
	for (const [verb, p] of ROUTES) {
		const text = registration(verb, p);
		if (!text) continue;
		const mutated = text.replace('requireRole("Super Admin")', 'requireRole("Super Admin", "Dispatcher")');
		const r = call(build(mutated, { BROKER_INVOICE_LINES_ENABLED: "true" }), verb, USERS.Dispatcher);
		ok(`MUTANT Dispatcher re-admitted to ${verb.toUpperCase()} ${p}: caught`, r.reached);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
