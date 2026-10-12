#!/usr/bin/env node
/**
 * The n8n workflow exports in docs/n8n are public (this repo is public), so
 * nothing in them may work as a key to the live instance.
 *
 *   §1 WEBHOOKS. A webhook-type node (webhook, form, chat or MCP trigger) is a
 *      public endpoint on the n8n instance. An export may carry one only when
 *      it requires authentication AND its path is a placeholder, never the
 *      live path.
 *   §2 SECRETS IN PARAMETERS. A header, query or body parameter whose name
 *      reads like a secret (secret, token, key, password, authorization), and
 *      any parameter field named that way, holds an n8n expression or a
 *      "REDACTED" placeholder, never a literal value.
 *   §3 THE CHECKS CATCH WHAT THEY CLAIM. Each rule refuses a small built-in
 *      example of what it guards against, so an empty pass can't happen.
 *
 * Plain node, no network. Every *.json under docs/n8n is checked.
 * Run: node scripts/test-n8n-exports.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DIR = process.env.N8N_EXPORT_DIR || path.join(__dirname, "..", "docs", "n8n");

let pass = 0;
const failures = [];
function ok(cond, label) { if (cond) pass++; else failures.push(label); }
function section(t) { console.log(`\n${t}`); }

const WEBHOOK_TYPE = /(?:^|\.)(?:webhook|formTrigger|chatTrigger|mcpTrigger)$/i;
const SECRET_NAME = /secret|token|api[-_]?key|password|passwd|authori[sz]ation|^key$/i;
const isExpression = (v) => typeof v === "string" && (v.trim().startsWith("=") || v.includes("{{"));
const isPlaceholder = (v) => typeof v === "string" && /REDACTED/.test(v);

// Problems in one workflow export, as readable strings (empty = clean).
function webhookProblems(wf, file) {
	const out = [];
	for (const n of wf.nodes || []) {
		if (!WEBHOOK_TYPE.test(n.type || "")) continue;
		const p = n.parameters || {};
		const auth = p.authentication || "none";
		if (auth === "none") out.push(`${file}: webhook node "${n.name}" requires no authentication`);
		if (p.path !== undefined && !isPlaceholder(p.path)) out.push(`${file}: webhook node "${n.name}" carries a real path (use a REDACTED placeholder)`);
	}
	return out;
}
function secretProblems(wf, file) {
	const out = [];
	const literal = (v) => typeof v === "string" && v.length > 0 && !isExpression(v) && !isPlaceholder(v);
	const walk = (node, o, where) => {
		if (Array.isArray(o)) { o.forEach((x, i) => walk(node, x, `${where}[${i}]`)); return; }
		if (!o || typeof o !== "object") return;
		// name/value pairs: headerParameters, queryParameters, bodyParameters …
		if (typeof o.name === "string" && "value" in o && SECRET_NAME.test(o.name) && literal(o.value)) {
			out.push(`${file}: node "${node}" sends a literal value for "${o.name}" (${where})`);
		}
		for (const [k, v] of Object.entries(o)) {
			if (k !== "value" && SECRET_NAME.test(k) && literal(v)) out.push(`${file}: node "${node}" has a literal "${k}" (${where}.${k})`);
			walk(node, v, `${where}.${k}`);
		}
	};
	for (const n of wf.nodes || []) walk(n.name, n.parameters || {}, "parameters");
	return out;
}

function exportsSection() {
	section("§1/§2 the tracked exports");
	const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];
	ok(files.length > 0, `§1 there are n8n exports to check in ${DIR}`);
	for (const f of files) {
		let wf;
		try { wf = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { ok(false, `§1 ${f} parses as JSON (${e.message})`); continue; }
		ok(Array.isArray(wf.nodes), `§1 ${f} has a nodes array`);
		const hooks = webhookProblems(wf, f);
		ok(hooks.length === 0, `§1 ${f}: no webhook node without authentication or with a real path${hooks.length ? ":\n        " + hooks.join("\n        ") : ""}`);
		const secrets = secretProblems(wf, f);
		ok(secrets.length === 0, `§2 ${f}: no literal secret in node parameters${secrets.length ? ":\n        " + secrets.join("\n        ") : ""}`);
	}
}

function selfCheckSection() {
	section("§3 the checks catch what they claim");
	const open = { nodes: [{ name: "Hook", type: "n8n-nodes-base.webhook", parameters: { httpMethod: "POST", path: "a1b2c3d4e5" } }] };
	ok(webhookProblems(open, "t").length === 2, "§3 an unauthenticated webhook with a real path is refused twice (auth and path)");
	const authed = { nodes: [{ name: "Hook", type: "n8n-nodes-base.webhook", parameters: { authentication: "headerAuth", path: "REDACTED_PATH" } }] };
	ok(webhookProblems(authed, "t").length === 0, "§3 an authenticated webhook with a placeholder path passes");
	const authedRealPath = { nodes: [{ name: "Hook", type: "n8n-nodes-base.formTrigger", parameters: { authentication: "basicAuth", path: "live-form" } }] };
	ok(webhookProblems(authedRealPath, "t").length === 1, "§3 a form trigger with a real path is refused even when authenticated");
	const header = (value) => ({ nodes: [{ name: "Call", type: "n8n-nodes-base.httpRequest", parameters: { headerParameters: { parameters: [{ name: "x-webhook-secret", value }] } } }] });
	ok(secretProblems(header("s3cr3t-value-123"), "t").length === 1, "§3 a literal secret header is refused");
	ok(secretProblems(header("REDACTED_SET_IN_N8N"), "t").length === 0, "§3 a REDACTED placeholder header passes");
	ok(secretProblems(header("={{ $env.SECRET }}"), "t").length === 0, "§3 an expression header passes");
	const field = { nodes: [{ name: "Api", type: "n8n-nodes-base.httpRequest", parameters: { options: { apiKey: "abc123" } } }] };
	ok(secretProblems(field, "t").length === 1, "§3 a literal apiKey field is refused");
	const harmless = { nodes: [{ name: "Gmail", type: "n8n-nodes-base.gmail", webhookId: "0f2b8454-2949-4e8d-a1c9-910756a8b2ea", parameters: { operation: "getAll", filters: { q: "from:x" } } }] };
	ok(webhookProblems(harmless, "t").length === 0 && secretProblems(harmless, "t").length === 0, "§3 a Gmail node's internal webhookId and ordinary parameters pass");
}

for (const [name, run] of [["§1/§2", exportsSection], ["§3", selfCheckSection]]) {
	try { run(); } catch (e) { failures.push(`${name} threw: ${e && e.stack}`); }
}
console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
