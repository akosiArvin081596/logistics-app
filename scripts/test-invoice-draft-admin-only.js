#!/usr/bin/env node
/**
 * scripts/test-invoice-draft-admin-only.js — invoice drafting is Super Admin only
 * (owner, 2026-09-26).
 *
 * A draft is addressed to the rate con's documents email, names the broker, and
 * on ?dryRun=1 returns the rate con's own bytes. Every invoice-draft route
 * therefore answers anyone but Super Admin at its first middleware, before any
 * read, limiter or cross-site check:
 *   POST /api/loads/:loadId/draft-invoice   (and its alias …/draft-bison-invoice,
 *                                           ?dryRun=1 included)
 *   POST /api/loads/:loadId/invoice-preview
 *   GET  /api/loads/:loadId/invoice-draft
 * and the dashboard offers them to nobody else: CompletedLoadsTab.vue shows the
 * Draft Invoice button, the approved-draft line and its Review link to Super
 * Admin only, and asks GET …/invoice-draft for nobody else.
 *
 * WHAT IS REAL. Each registration is lifted from server.js whole and executed
 * against a capturing `app`, with the real requireRole (self-contained by
 * design, see the CSRF note in server.js). What follows it (refuseCrossSite, the
 * limiters) is a counting pass-through stub, and the handler is never run: the
 * question is who reaches it. §1 finds the routes by scanning EVERY registration
 * for an /api/loads/… draft or invoice path, so a new one fails this runner until
 * it is gated and listed here.
 *
 * DISCRIMINATION: §3 re-admits Dispatcher on each registration in turn, and
 * breaks each client gate in turn, and requires the matching assertion to flip.
 *
 * Pure: no server, no port, no app.db, no network.
 * Run: node scripts/test-invoice-draft-admin-only.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const TAB_PATH = path.join(ROOT, "client", "src", "components", "dashboard", "CompletedLoadsTab.vue");
const TAB = fs.readFileSync(TAB_PATH, "utf8");

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ""}`); }
}
function fatal(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

// --- lifting ---------------------------------------------------------------
// A bracket matcher that skips strings, template literals and comments, so a
// bracket or `;` inside one cannot end a lift early.
function skipString(src, i) {
	const q = src[i];
	for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
	return i;
}
function closeOf(src, open) {
	const want = { "(": ")", "[": "]", "{": "}" };
	const stack = [];
	for (let i = open; i < src.length; i++) {
		const c = src[i], n = src[i + 1];
		if (c === "/" && n === "/") { i = src.indexOf("\n", i); continue; }
		if (c === "/" && n === "*") { i = src.indexOf("*/", i) + 1; continue; }
		if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue; }
		if (want[c]) stack.push(want[c]);
		else if (c === ")" || c === "]" || c === "}") {
			if (stack.pop() !== c) fatal(`unbalanced ${c} at offset ${i}`);
			if (!stack.length) return i + 1;
		}
	}
	return fatal("unterminated bracket");
}
function liftFn(name) {
	const at = SRC.indexOf(`\nfunction ${name}(`);
	if (at < 0) fatal(`could not locate function ${name} in server.js`);
	const bodyOpen = SRC.indexOf("{", closeOf(SRC, SRC.indexOf("(", at)));
	return SRC.slice(at + 1, closeOf(SRC, bodyOpen));
}
const requireRole = new Function(`${liftFn("requireRole")}\nreturn requireRole;`)();

// Every route registration in server.js — `app.<verb>(` at a line start — with
// the path literals of its FIRST argument (a string, or an array of strings).
// Only that argument is parsed: a handler body holds regex literals a bracket
// matcher cannot read. The registration itself is lifted by lines, from its
// first line to the `);` / `});` that closes it at column 0 (the file's shape).
function registrations(src) {
	const out = [];
	const lines = src.split("\n");
	lines.forEach((line, i) => {
		const m = line.match(/^app\.(get|post|put|patch|delete|all)\(/);
		if (!m) return;
		const rest = [line.slice(m[0].length), ...lines.slice(i + 1, i + 4)].join("\n").trimStart();
		let argText = "";
		if (rest[0] === '"') argText = rest.slice(0, skipString(rest, 0) + 1);
		else if (rest[0] === "[") {
			let j = 1;
			for (; j < rest.length && rest[j] !== "]"; j++) if (rest[j] === '"') j = skipString(rest, j);
			argText = rest.slice(0, j + 1);
		}
		const paths = (argText.match(/"(\/[^"]*)"/g) || []).map((q) => q.slice(1, -1));
		let end = i;
		while (end < lines.length && lines[end] !== ");" && lines[end] !== "});") end++;
		out.push({ verb: m[1], paths, lift: () => lines.slice(i, end + 1).join("\n") });
	});
	return out;
}
const IS_DRAFT_PATH = (p) => /^\/api\/loads\/.*(draft|invoice)/.test(p);
const draftRegs = (src) => registrations(src).filter((r) => r.paths.some(IS_DRAFT_PATH))
	.map((r) => ({ verb: r.verb, paths: r.paths, text: r.lift() }));

// Execute one registration against a capturing app. The middleware after the
// role gate is a counting pass-through; the handler is captured, never run.
const stubs = { calls: 0 };
const passThrough = (req, res, next) => { stubs.calls++; next(); };
function build(reg) {
	let captured = null;
	const app = { [reg.verb]: (p, ...chain) => { captured = { paths: [].concat(p), chain }; } };
	new Function("app", "requireRole", "refuseCrossSite", "draftInvoiceLimiter", "invoicePreviewLimiter", reg.text)(
		app, requireRole, passThrough, passThrough, passThrough);
	if (!captured) fatal(`the lifted registration for ${reg.paths.join(", ")} did not register`);
	return captured;
}
// Walk the chain up to the handler, the way Express does. `reached` is whether
// every middleware handed on, i.e. whether the handler would have run.
function call(route, verb, user, query = {}) {
	stubs.calls = 0;
	const req = {
		method: verb.toUpperCase(),
		path: route.paths[0], url: route.paths[0], originalUrl: route.paths[0],
		params: { loadId: "L-100" }, query, body: {},
		headers: { "x-requested-with": "XMLHttpRequest" },
		route: { path: route.paths[0] },
		session: user ? { user: { ...user } } : {},
	};
	const res = {
		statusCode: 200, body: undefined,
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
		setHeader() {}, end() { return this; },
	};
	let reached = true;
	for (const mw of route.chain.slice(0, -1)) {
		let next = false;
		mw(req, res, () => { next = true; });
		if (!next) { reached = false; break; }
	}
	return { reached, status: res.statusCode, stubCalls: stubs.calls };
}

const USERS = {
	"Super Admin": { id: 1, role: "Super Admin", username: "super_admin" },
	Dispatcher: { id: 2, role: "Dispatcher", username: "dispatch1" },
	Driver: { id: 3, role: "Driver", username: "LogisX-1001", driverName: "Deshorn King" },
	Investor: { id: 4, role: "Investor", username: "investor1" },
};

// Who reaches each registration's handler. [] when nothing unexpected happened.
function gateViolations(src) {
	const v = [];
	for (const reg of draftRegs(src)) {
		const route = build(reg);
		const label = `${reg.verb.toUpperCase()} ${reg.paths.join(" + ")}`;
		const sa = call(route, reg.verb, USERS["Super Admin"]);
		if (!sa.reached) v.push(`${label}: Super Admin does not reach the handler (${sa.status})`);
		for (const role of ["Dispatcher", "Driver", "Investor"]) {
			for (const query of [{}, { dryRun: "1" }]) {
				const r = call(route, reg.verb, USERS[role], query);
				if (r.reached || r.status !== 403) v.push(`${label}${query.dryRun ? "?dryRun=1" : ""}: ${role} gets ${r.reached ? "the handler" : r.status}`);
				else if (r.stubCalls) v.push(`${label}: ${role}'s refusal ran ${r.stubCalls} middleware after the gate`);
			}
		}
		const anon = call(route, reg.verb, null);
		if (anon.reached || anon.status !== 401) v.push(`${label}: no session gets ${anon.reached ? "the handler" : anon.status}`);
		const first = route.chain[0] && route.chain[0].toString();
		if (!first || !/roles\.includes/.test(first)) v.push(`${label}: the role gate is not the first middleware`);
	}
	return v;
}

// --- the client ------------------------------------------------------------
// Is `at` inside a `<template v-if="auth.isSuperAdmin">` … `</template>` block,
// or inside a tag that carries that v-if itself?
function gatedAt(src, at) {
	const tagStart = src.lastIndexOf("<", at);
	const tagEnd = src.indexOf(">", at);
	if (/\bv-if="auth\.isSuperAdmin"/.test(src.slice(tagStart, tagEnd))) return true;
	const OPEN = '<template v-if="auth.isSuperAdmin">';
	for (let s = src.indexOf(OPEN); s >= 0 && s < at; s = src.indexOf(OPEN, s + 1)) {
		let depth = 0;
		const re = /<template\b|<\/template>/g;
		re.lastIndex = s;
		for (let m; (m = re.exec(src));) {
			depth += m[0] === "</template>" ? -1 : 1;
			if (depth === 0) { if (m.index > at) return true; break; }
		}
	}
	return false;
}
function clientViolations(src) {
	const v = [];
	const all = (needle) => { const out = []; for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) out.push(i); return out; };
	const clicks = all('@click="draftInvoice"');
	if (clicks.length !== 2) v.push(`expected the Draft Invoice button and the Review link, found ${clicks.length} draftInvoice click(s)`);
	clicks.forEach((i) => { if (!gatedAt(src, i)) v.push(`a draftInvoice control at offset ${i} is not Super Admin only`); });
	const line = all("approvedDraft.recipient");
	if (!line.length) v.push("the approved-draft line was not found");
	line.forEach((i) => { if (!gatedAt(src, i)) v.push("the approved-draft line (recipient) is not Super Admin only"); });
	const gets = all("/invoice-draft`");
	if (gets.length !== 2) v.push(`expected two GET …/invoice-draft call sites, found ${gets.length}`);
	for (const i of gets) {
		const fnStart = Math.max(src.lastIndexOf("\nasync function ", i), src.lastIndexOf("\nfunction ", i));
		if (!src.slice(fnStart, i).includes("auth.isSuperAdmin")) v.push(`the GET …/invoice-draft at offset ${i} is not skipped for other roles`);
	}
	if (!/async function draftInvoice\(\) \{\n\s*if \(!auth\.isSuperAdmin\b/.test(src)) v.push("draftInvoice() does not refuse a non-Super-Admin first");
	return v;
}

// ===========================================================================
console.log("\n§1  every invoice-draft route admits Super Admin alone");
// ===========================================================================
const regs = draftRegs(SRC);
const paths = regs.flatMap((r) => r.paths.map((p) => `${r.verb.toUpperCase()} ${p}`)).sort();
ok(`the invoice-draft registrations are exactly the known four paths (${paths.join(", ")})`,
	paths.join() === [
		"GET /api/loads/:loadId/invoice-draft",
		"POST /api/loads/:loadId/draft-bison-invoice",
		"POST /api/loads/:loadId/draft-invoice",
		"POST /api/loads/:loadId/invoice-preview",
	].join());
for (const reg of regs) {
	const route = build(reg);
	const label = `${reg.verb.toUpperCase()} ${reg.paths.join(" + ")}`;
	const sa = call(route, reg.verb, USERS["Super Admin"]);
	ok(`${label}: Super Admin reaches the handler`, sa.reached, `status ${sa.status}`);
	for (const role of ["Dispatcher", "Driver", "Investor"]) {
		const r = call(route, reg.verb, USERS[role]);
		ok(`${label}: ${role} is refused 403 at the gate, before the cross-site check and the limiter`,
			!r.reached && r.status === 403 && r.stubCalls === 0, `reached ${r.reached}, status ${r.status}, after-gate calls ${r.stubCalls}`);
	}
	ok(`${label}: no session is refused 401`, !call(route, reg.verb, null).reached);
}
{
	const draft = regs.find((r) => r.paths.includes("/api/loads/:loadId/draft-invoice"));
	const r = call(build(draft), "post", USERS.Dispatcher, { dryRun: "1" });
	ok("?dryRun=1 (the preview that returns the rate con's bytes) is refused to a Dispatcher the same way",
		!r.reached && r.status === 403, `status ${r.status}`);
}
ok("no gate violation anywhere (the list §3 checks against)", gateViolations(SRC).length === 0, gateViolations(SRC).join("; "));

// ===========================================================================
console.log("\n§2  the dashboard offers drafting to Super Admin alone");
// ===========================================================================
const cv = clientViolations(TAB);
ok("CompletedLoadsTab.vue: the Draft Invoice button, the approved-draft line and its Review link are Super Admin only, and GET …/invoice-draft is asked for nobody else",
	cv.length === 0, cv.join("; "));
{
	const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(p);
		return /\.(vue|js|ts|html)$/.test(e.name) ? [p] : [];
	});
	const files = [...walk(path.join(ROOT, "client", "src")), ...walk(path.join(ROOT, "public"))];
	const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
	const callers = files.filter((f) => /\/(draft-invoice|draft-bison-invoice|invoice-preview|invoice-draft)\b/.test(
		fs.readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l)).join("\n"))).map(rel).sort();
	ok(`the draft routes are called only by CompletedLoadsTab.vue and the preview modal (${callers.join(", ")})`,
		callers.join() === "client/src/components/dashboard/CompletedLoadsTab.vue,client/src/components/dashboard/InvoiceDraftPreviewModal.vue");
	const mounts = files.filter((f) => /<InvoiceDraftPreviewModal\b/.test(fs.readFileSync(f, "utf8"))).map(rel);
	ok("...and the preview modal is mounted only by CompletedLoadsTab.vue, which opens it only from draftInvoice()",
		mounts.join() === "client/src/components/dashboard/CompletedLoadsTab.vue" &&
		(TAB.match(/previewData\.value = (?!null)/g) || []).length === 1 &&
		TAB.indexOf("previewData.value = r") > TAB.indexOf("async function draftInvoice()"));
}

// ===========================================================================
console.log("\n§3  DISCRIMINATION: re-open each gate, require an assertion to flip");
// ===========================================================================
for (const reg of regs) {
	const label = `${reg.verb.toUpperCase()} ${reg.paths.join(" + ")}`;
	const from = 'requireRole("Super Admin")';
	if (reg.text.split(from).length - 1 !== 1) { ok(`mutant anchor found once in ${label}`, false); continue; }
	const mutated = SRC.replace(reg.text, reg.text.replace(from, 'requireRole("Super Admin", "Dispatcher")'));
	const v = gateViolations(mutated);
	ok(`MUTANT Dispatcher re-admitted to ${label}: caught (${v.length} violation(s), e.g. "${v[0] || "none"}")`,
		v.some((s) => s.startsWith(label) && s.includes("Dispatcher gets the handler")));
}
for (const [name, from, to] of [
	["the Draft Invoice button shows to every role", '<button v-if="auth.isSuperAdmin" type="button" :disabled="drafting" :style="draftBtnStyle"', '<button type="button" :disabled="drafting" :style="draftBtnStyle"'],
	["the approved-draft line and Review link show to every role", '<template v-if="auth.isSuperAdmin">\n            <div v-if="draftResult"', '<template v-if="true">\n            <div v-if="draftResult"'],
	["openDetail asks every role for GET …/invoice-draft", "if (lid && auth.isSuperAdmin) p.push(api.get(`/api/loads/${encodeURIComponent(lid)}/invoice-draft`)", "if (lid) p.push(api.get(`/api/loads/${encodeURIComponent(lid)}/invoice-draft`)"],
]) {
	if (TAB.split(from).length - 1 !== 1) { ok(`client mutant anchor found once: ${name}`, false); continue; }
	ok(`MUTANT ${name}: caught`, clientViolations(TAB.replace(from, to)).length > 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
