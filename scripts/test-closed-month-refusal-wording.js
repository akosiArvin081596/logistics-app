#!/usr/bin/env node
/**
 * No closed-month refusal tells anyone to reopen a month, or shows an API path
 * or an internal code.
 *
 * WHY: closed months are never reopened (standing rule, 2026-10-14), yet the
 * refusals for a closed month told people to "Reopen the period first
 * (POST /api/periods/:period/reopen records a reason)", one sent admins to a
 * delete route that refuses the same loads, and the Data Issues page said an
 * invoice's month "would have to be reopened first". The people reading these
 * are the owner and the dispatchers, not developers.
 *
 * WHAT IS SCANNED: every string literal (quotes and template literals, with
 * their ${…} parts) in server.js, lib/ and the client's src/ (.js, .mjs and the
 * <script> of each .vue), plus the text of each .vue <template>. Comments are
 * skipped. A literal is not user-facing, and is skipped, when it is SQL, a bare
 * route path, or sits inside a console.*() call or an audit-trail writer
 * (logAudit, logAuditRefusal, recordPayoutChange).
 *
 * WHAT FAILS:
 *   1. a user-facing literal that says "reopen" in any case, apart from the
 *      reopen controls themselves and one unrelated use (ALLOWED below, each
 *      with its reason);
 *   2. a user-facing literal that names "/api/periods";
 *   3. a user-facing literal that shows an API path ("/api/") while talking
 *      about a closed, finalized or settled month;
 *   4. a user-facing literal that prints an internal PERIOD_* code inside a
 *      sentence (a literal that IS the code, such as `code: "PERIOD_FINALIZED"`,
 *      is the machine-readable field and passes).
 *
 * Pure: reads source text only.
 * Run: node scripts/test-closed-month-refusal-wording.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Literals that may say "reopen": the reopen feature's own validation and
// failure messages (they name the action a control performs, they advise
// nothing), and one use that is not about months at all. Matched by file and
// exact text, or by the start of the text where it carries ${…}.
const ALLOWED = [
	{ file: "server.js", text: "A reason is required to reopen a settled payout.", why: "the payout Reopen action's own validation" },
	{ file: "server.js", text: "A reason is required to reopen a finalized period.", why: "the month Reopen action's own validation" },
	{ file: "server.js", text: "Failed to reopen period", why: "the month Reopen action's own failure" },
	{ file: "lib/investor-rfi.js", startsWith: "The website's forms have sent ${} emails in the last 24 hours", why: "the public forms reopening after their daily email limit" },
	{ file: "server.js", text: "payable ${}. Nothing was written; the month stays as settled. Reopen ${} to settle it.",
		why: "the details of a system audit row (late_item_closed_month), not a refusal; they are compared verbatim to record each finding once, so new wording would record every past finding again" },
];
// The Payouts console IS the reopen control (Reopen Month, Reopen payout): its
// labels, modals and help text describe that action rather than advise it.
const SKIP_FILES = new Set(["client/src/views/PayoutsView.vue"]);

const NOT_USER_FACING_CALLEE = /(^|\.)(console\.\w+|logAudit|logAuditRefusal|recordPayoutChange|prepare|exec)$/;
// Upper case only: "Create the account…" is a sentence, not SQL.
const SQL = /^\s*(SELECT|UPDATE|INSERT|ALTER|CREATE|DELETE|WITH|PRAGMA|DROP)\s/;
const ROUTE_PATH = /^\/api\/[\w/:.${}-]*$/;
const REGEX_AFTER_WORD = /(^|[^\w$])(return|typeof|case|in|of|void|else|do|throw|delete|new|yield|await)\s*$/;

// Every string literal in `text`, as { text, line, callees }. A template's
// static parts are joined with "${}" where an expression sat; the expression is
// scanned as code. `callees` is the stack of call names the literal sits inside
// ("console.warn", "json" for res.status(409).json(...), …).
function literals(text, baseLine = 1) {
	const out = [];
	let i = 0;
	let line = baseLine;
	const advance = () => { if (text[i] === "\n") line++; i++; };
	const calleeBefore = (pos) => {
		const m = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/.exec(text.slice(Math.max(0, pos - 120), pos));
		return m ? m[1].replace(/\s+/g, "") : "";
	};
	function quoted(q, callees) {
		const startLine = line;
		advance();
		let s = "";
		while (i < text.length && text[i] !== q && text[i] !== "\n") {
			if (text[i] === "\\") { s += text[i + 1] || ""; advance(); advance(); continue; }
			s += text[i];
			advance();
		}
		advance();
		out.push({ text: s, line: startLine, callees: [...callees] });
	}
	function regex() {
		advance();
		let inClass = false;
		while (i < text.length && (inClass || text[i] !== "/") && text[i] !== "\n") {
			if (text[i] === "\\") { advance(); advance(); continue; }
			if (text[i] === "[") inClass = true;
			else if (text[i] === "]") inClass = false;
			advance();
		}
		advance();
		while (/[a-z]/.test(text[i] || "")) advance();
	}
	function template(callees) {
		const startLine = line;
		advance();
		let s = "";
		while (i < text.length && text[i] !== "`") {
			if (text[i] === "\\") { s += text[i + 1] || ""; advance(); advance(); continue; }
			if (text[i] === "$" && text[i + 1] === "{") {
				advance(); advance();
				code([...callees], true);
				advance();
				s += "${}";
				continue;
			}
			s += text[i];
			advance();
		}
		advance();
		out.push({ text: s, line: startLine, callees: [...callees] });
	}
	// Code up to the end of `text`, or, inside a template expression, up to the
	// "}" that closes it (left for the caller to consume).
	function code(callees, inTemplate) {
		let depth = 0;
		let prev = "";
		const regexCanStart = () => prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)
			|| (/[\w$]/.test(prev) && REGEX_AFTER_WORD.test(text.slice(Math.max(0, i - 12), i)));
		while (i < text.length) {
			const ch = text[i];
			if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
			if (ch === "/" && text[i + 1] === "*") {
				const e = text.indexOf("*/", i + 2);
				const stop = e === -1 ? text.length : e + 2;
				while (i < stop) advance();
				continue;
			}
			if (ch === '"' || ch === "'") { quoted(ch, callees); prev = "a"; continue; }
			if (ch === "`") { template(callees); prev = "a"; continue; }
			if (ch === "/" && regexCanStart()) { regex(); prev = "a"; continue; }
			if (ch === "{") depth++;
			else if (ch === "}") { if (inTemplate && depth === 0) return; depth--; }
			else if (ch === "(") callees.push(calleeBefore(i));
			else if (ch === ")") callees.pop();
			if (!/\s/.test(ch)) prev = ch;
			advance();
		}
	}
	code([], false);
	return out;
}

function userFacing(lit) {
	if (SQL.test(lit.text) || ROUTE_PATH.test(lit.text.trim())) return false;
	return !lit.callees.some((c) => NOT_USER_FACING_CALLEE.test(c));
}

const findings = [];
function judge(file, lit) {
	const t = lit.text;
	const where = `${file}:${lit.line}`;
	const snippet = t.length > 160 ? `${t.slice(0, 157)}...` : t;
	const allowed = ALLOWED.some((a) => a.file === file && (a.text === t || (a.startsWith && t.startsWith(a.startsWith))));
	if (/reopen/i.test(t) && !allowed) findings.push(`${where} says "reopen": ${snippet}`);
	if (t.includes("/api/periods")) findings.push(`${where} names /api/periods: ${snippet}`);
	else if (t.includes("/api/") && /finaliz|closed|settled/i.test(t)) {
		findings.push(`${where} shows an API path in a closed-month message: ${snippet}`);
	}
	if (/\bPERIOD_[A-Z_]+/.test(t) && /\s/.test(t.trim())) {
		findings.push(`${where} prints an internal PERIOD_* code in a sentence: ${snippet}`);
	}
}

function scanJs(file, text, baseLine = 1) {
	let n = 0;
	for (const lit of literals(text, baseLine)) {
		n++;
		if (userFacing(lit)) judge(file, lit);
	}
	return n;
}

function scanVue(file, text) {
	let n = 0;
	const script = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
	let m;
	while ((m = script.exec(text))) {
		const baseLine = text.slice(0, m.index + m[0].indexOf(">") + 1).split("\n").length;
		n += scanJs(file, m[1], baseLine);
	}
	const tpl = /<template>([\s\S]*)<\/template>/.exec(text);
	if (tpl) {
		const start = text.slice(0, tpl.index).split("\n").length;
		const body = tpl[1].replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
		body.split("\n").forEach((l, k) => {
			n++;
			judge(file, { text: l.trim(), line: start + k, callees: [] });
		});
	}
	return n;
}

function walk(dir, exts) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name !== "node_modules") out.push(...walk(p, exts)); }
		else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
	}
	return out;
}

let failed = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
}

// The scanner must see the refusals it polices: a lexer that lost track of
// strings would pass everything, or flag comments.
{
	const probe = literals([
		"const re = x.replace(/[\\s']/g, '_');",
		"const t = `${a.replace(/[\\s']/g, '_')} is closed. Reopen it (POST /api/periods/:period/reopen).`;",
		"function f() { return /'/.test(s); }",
		"res.status(409).json({ error: t }); console.warn(\"reopen me\"); app.post(\"/api/periods/:period/reopen\", h);",
		"// a comment that says reopen",
	].join("\n"));
	const flagged = probe.filter(userFacing).map((l) => l.text);
	check("self-test: a refusal template behind a regex with a quote is seen and judged user-facing",
		flagged.some((t) => /is closed\. Reopen it/.test(t)), JSON.stringify(flagged));
	check("self-test: a console.warn literal is not user-facing", !flagged.includes("reopen me"), JSON.stringify(flagged));
	check("self-test: a route path is not user-facing", !flagged.includes("/api/periods/:period/reopen"), JSON.stringify(flagged));
	check("self-test: a comment is not a literal", !probe.some((l) => /comment/.test(l.text)), JSON.stringify(probe.map((l) => l.text)));
	check("self-test: SQL is not user-facing", !userFacing({ text: "UPDATE period_locks SET status = 'reopened'", callees: [] }));
	check("self-test: a sentence starting with a SQL word is user-facing", userFacing({ text: "Create the account, or reopen", callees: [] }));
}

let scanned = 0;
let desynced = 0;
const files = [
	path.join(ROOT, "server.js"),
	...walk(path.join(ROOT, "lib"), [".js", ".mjs", ".cjs"]),
	...walk(path.join(ROOT, "client", "src"), [".js", ".mjs", ".vue"]),
];
for (const abs of files) {
	const rel = path.relative(ROOT, abs).split(path.sep).join("/");
	if (SKIP_FILES.has(rel)) continue;
	const text = fs.readFileSync(abs, "utf8");
	scanned += rel.endsWith(".vue") ? scanVue(rel, text) : scanJs(rel, text);
	if (rel === "server.js") desynced = literals(text).filter((l) => /\n\s*\/\/ /.test(l.text)).length;
}
check("server.js is read in step: no literal swallows a line comment", desynced === 0, String(desynced));
check(`scanned ${files.length} files, ${scanned} literals and template lines`, scanned > 5000, String(scanned));
check("no closed-month refusal says reopen, shows an API path or prints an internal code", findings.length === 0,
	`\n  ${findings.join("\n  ")}`);

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
