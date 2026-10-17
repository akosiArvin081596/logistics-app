#!/usr/bin/env node
/**
 * The n8n workflow exports in docs/n8n are public (this repo is public), so
 * nothing in them may work as a key to the live instance or carry real data.
 *
 *   §1 WEBHOOKS. A webhook-type node (webhook, form, chat or MCP trigger) is a
 *      public endpoint on the n8n instance. An export may carry one only when
 *      it requires authentication AND its path is a placeholder, never the
 *      live path.
 *   §2 SECRETS IN PARAMETERS. A header, query or body parameter whose name
 *      reads like a secret (secret, token, key, password, authorization,
 *      cookie, signature, sig, or a name ending -key or _key), and any
 *      parameter field named that way, holds an n8n expression or a
 *      "REDACTED" placeholder, never a literal value. Ordinary names that
 *      merely contain "key" (keyName, sortKey, primaryKey) are not secrets.
 *   §3 THE CHECKS CATCH WHAT THEY CLAIM. Each rule refuses a small built-in
 *      example of what it guards against and passes a clean one, so an empty
 *      pass can't happen.
 *   §4 TOKEN SHAPES. No string anywhere in the file (any field at any depth,
 *      field names included) has the shape of a credential: a Bearer token, a
 *      JWT, a Google API key, a LlamaCloud key, an sk- key, a GitHub token or
 *      a Slack token. A REDACTED placeholder or an n8n expression in its place
 *      is fine.
 *   §5 KEYS IN URLS. No URL anywhere carries a literal key=, api_key=,
 *      apikey=, token=, access_token=, sig= or signature= query value, or a
 *      user:password@ part (expressions and placeholders are fine).
 *   §6 WEBHOOK IDS. A webhookId gives a node an endpoint. Only the Gmail node
 *      and the Gmail trigger carry an internal one; on any other node it is
 *      refused (drop it from the export; n8n assigns a new one on import).
 *   §7 PINNED DATA. pinData is absent, null or an empty object: pinned data
 *      is real execution data (emails, loads).
 *   §8 ONE COPY OF THE NODES. Only the top level has a nodes array. A nested
 *      copy (activeVersion.nodes, or any other object with a nodes array) is
 *      refused, so nothing the rules above check can hide in a second copy.
 *
 * A problem names where it is, never the value it found: CI logs are public.
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
const listed = (problems) => (problems.length ? ":\n        " + problems.join("\n        ") : "");

const WEBHOOK_TYPE = /(?:^|\.)(?:webhook|formTrigger|chatTrigger|mcpTrigger)$/i;
// "key" counts as a secret only as the whole name or after a - or _ (x-functions-key,
// subscription_key), so keyName, sortKey and primaryKey stay ordinary parameters.
const SECRET_NAME = /secret|token|api[-_]?key|password|passwd|authori[sz]ation|cookie|signature|^key$|[-_]key$|(?:^|[-_])sig$/i;
// An n8n expression reads a value at run time ({{ … }}). A field saved in
// expression mode without one ("=abc123") is still the literal abc123.
const isExpression = (v) => typeof v === "string" && v.includes("{{");
// The whole value is the placeholder, so "REDACTED" can't front a real value.
const isPlaceholder = (v) => typeof v === "string" && /^_*REDACTED[A-Z0-9_]*$/.test(v);

// Each shape captures the credential itself, so a placeholder in its place
// passes; an expression ({{ … }}) can't match a token character class at all.
// Quantifiers are bounded: these run over whole Code-node scripts.
const TOKEN_SHAPES = [
	["a Bearer token", /\bBearer\s{1,8}([A-Za-z0-9._~+/=-]{16,512})/gi],
	["a JWT", /\b(eyJ[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{4,4096}\.)/g],
	["a Google API key", /\b(AIza[0-9A-Za-z_-]{30,64})/g],
	["a LlamaCloud key", /\b(llx-[A-Za-z0-9_-]{16,256})/g],
	["an sk- key", /\b(sk-[A-Za-z0-9_-]{16,256})/g],
	["a GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{20,255})/g],
	["a Slack token", /\b(xox[abpr]-[A-Za-z0-9-]{10,255})/g],
];
const URL_KEY_PARAM = /[?&](api[-_]?key|key|access[-_]?token|token|sig|signature)=([A-Za-z0-9._~%+/=-]{1,512})/gi;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/?#@:]{1,256}:([^\s/?#@]{1,256})@/gi;
// A Code node builds values with ${…}; neither that nor {{ … }} is a literal.
const isLiteralSecret = (v) => !/\{\{|\$\{/.test(v) && !isPlaceholder(v);
// Nodes that carry an internal webhookId without serving an endpoint.
const INTERNAL_WEBHOOK_ID_TYPES = new Set(["n8n-nodes-base.gmail", "n8n-nodes-base.gmailTrigger"]);

// Every string in the file, field names included, with the path it sits at.
function eachString(o, where, visit) {
	if (typeof o === "string") { visit(o, where); return; }
	if (Array.isArray(o)) { o.forEach((x, i) => eachString(x, `${where}[${i}]`, visit)); return; }
	if (!o || typeof o !== "object") return;
	for (const [k, v] of Object.entries(o)) {
		const at = where ? `${where}.${k}` : k;
		visit(k, `${at} (the field name)`);
		eachString(v, at, visit);
	}
}
// "nodes[3].parameters.url" reads better as: node "Fetch" (parameters.url).
function place(wf, where) {
	const m = /^nodes\[(\d+)\]\.?(.*)$/.exec(where);
	const n = m && Array.isArray(wf.nodes) ? wf.nodes[Number(m[1])] : null;
	return n && typeof n === "object" ? `node "${n.name}"${m[2] ? ` (${m[2]})` : ""}` : where;
}

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
function tokenProblems(wf, file) {
	const out = [];
	eachString(wf, "", (s, where) => {
		for (const [shape, re] of TOKEN_SHAPES) {
			for (const m of s.matchAll(re)) {
				if (!isPlaceholder(m[1])) out.push(`${file}: ${shape} in ${place(wf, where)}`);
			}
		}
	});
	return out;
}
function urlProblems(wf, file) {
	const out = [];
	eachString(wf, "", (s, where) => {
		for (const m of s.matchAll(URL_KEY_PARAM)) {
			if (isLiteralSecret(m[2])) out.push(`${file}: a URL carries a literal "${m[1]}=" value in ${place(wf, where)}`);
		}
		for (const m of s.matchAll(URL_USERINFO)) {
			if (isLiteralSecret(m[1])) out.push(`${file}: a URL carries a literal user:password@ in ${place(wf, where)}`);
		}
	});
	return out;
}
function webhookIdProblems(wf, file) {
	const out = [];
	for (const n of wf.nodes || []) {
		if (!n || !n.webhookId || INTERNAL_WEBHOOK_ID_TYPES.has(n.type)) continue;
		out.push(`${file}: node "${n.name}" (${n.type}) carries a webhookId, which gives it an endpoint (drop it from the export)`);
	}
	return out;
}
function pinDataProblems(wf, file) {
	const p = wf.pinData;
	if (p === undefined || p === null) return [];
	if (typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) return [];
	return [`${file}: pinData is not empty (pinned data is real execution data; export without it)`];
}
function nestedNodesProblems(wf, file) {
	const out = [];
	const walk = (o, where) => {
		if (Array.isArray(o)) { o.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
		if (!o || typeof o !== "object") return;
		if (where && Array.isArray(o.nodes)) out.push(`${file}: a nested copy of nodes at ${where}.nodes (export only the top-level workflow)`);
		for (const [k, v] of Object.entries(o)) walk(v, where ? `${where}.${k}` : k);
	};
	walk(wf, "");
	return out;
}

function exportsSection() {
	section("§1/§2/§4–§8 the tracked exports");
	const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort() : [];
	ok(files.length > 0, `§1 there are n8n exports to check in ${DIR}`);
	for (const f of files) {
		let wf;
		try { wf = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { ok(false, `§1 ${f} parses as JSON (${e.message})`); continue; }
		ok(Array.isArray(wf.nodes), `§1 ${f} has a nodes array`);
		const hooks = webhookProblems(wf, f);
		ok(hooks.length === 0, `§1 ${f}: no webhook node without authentication or with a real path${listed(hooks)}`);
		const secrets = secretProblems(wf, f);
		ok(secrets.length === 0, `§2 ${f}: no literal secret in node parameters${listed(secrets)}`);
		const tokens = tokenProblems(wf, f);
		ok(tokens.length === 0, `§4 ${f}: no credential-shaped string anywhere in the file${listed(tokens)}`);
		const urls = urlProblems(wf, f);
		ok(urls.length === 0, `§5 ${f}: no URL carries a literal key or user:password${listed(urls)}`);
		const ids = webhookIdProblems(wf, f);
		ok(ids.length === 0, `§6 ${f}: no webhookId outside the Gmail nodes${listed(ids)}`);
		const pins = pinDataProblems(wf, f);
		ok(pins.length === 0, `§7 ${f}: no pinned data${listed(pins)}`);
		const nested = nestedNodesProblems(wf, f);
		ok(nested.length === 0, `§8 ${f}: no nested copy of the nodes${listed(nested)}`);
	}
}

// Fakes are assembled at run time, so this file holds no credential-shaped
// literal of its own.
const fill = (n) => "a1B2c3D4e5".repeat(Math.ceil(n / 10)).slice(0, n);
const FAKE = {
	bearer: "Bearer " + fill(32),
	jwt: ["eyJ" + fill(16), "eyJ" + fill(24), fill(20)].join("."),
	google: "AIza" + fill(35),
	llama: "llx-" + fill(40),
	sk: "sk-" + fill(40),
	github: "ghp_" + fill(36),
	slack: "xoxb-" + fill(12) + "-" + fill(24),
};
const httpNode = (parameters, extra) => ({ name: "Call", type: "n8n-nodes-base.httpRequest", parameters, ...extra });
const wfOf = (...nodes) => ({ nodes });

function selfCheckSection() {
	section("§3 the checks catch what they claim");
	const open = { nodes: [{ name: "Hook", type: "n8n-nodes-base.webhook", parameters: { httpMethod: "POST", path: "a1b2c3d4e5" } }] };
	ok(webhookProblems(open, "t").length === 2, "§3 an unauthenticated webhook with a real path is refused twice (auth and path)");
	const authed = { nodes: [{ name: "Hook", type: "n8n-nodes-base.webhook", parameters: { authentication: "headerAuth", path: "REDACTED_PATH" } }] };
	ok(webhookProblems(authed, "t").length === 0, "§3 an authenticated webhook with a placeholder path passes");
	const authedRealPath = { nodes: [{ name: "Hook", type: "n8n-nodes-base.formTrigger", parameters: { authentication: "basicAuth", path: "live-form" } }] };
	ok(webhookProblems(authedRealPath, "t").length === 1, "§3 a form trigger with a real path is refused even when authenticated");
	const header = (value, name = "x-webhook-secret") => ({ nodes: [{ name: "Call", type: "n8n-nodes-base.httpRequest", parameters: { headerParameters: { parameters: [{ name, value }] } } }] });
	ok(secretProblems(header("s3cr3t-value-123"), "t").length === 1, "§3 a literal secret header is refused");
	ok(secretProblems(header("REDACTED_SET_IN_N8N"), "t").length === 0, "§3 a REDACTED placeholder header passes");
	ok(secretProblems(header("={{ $env.SECRET }}"), "t").length === 0, "§3 an expression header passes");
	ok(secretProblems(header("=s3cr3t-value-123"), "t").length === 1, "§3 a literal saved in expression mode (no {{ }}) is refused");
	ok(secretProblems(header("REDACTED-s3cr3t-value-123"), "t").length === 1, "§3 a real value behind the word REDACTED is refused");
	ok(webhookProblems({ nodes: [{ name: "Hook", type: "n8n-nodes-base.webhook", parameters: { authentication: "headerAuth", path: "REDACTED/live-path" } }] }, "t").length === 1,
		"§3 a real path behind the word REDACTED is refused");
	const field = { nodes: [{ name: "Api", type: "n8n-nodes-base.httpRequest", parameters: { options: { apiKey: "abc123" } } }] };
	ok(secretProblems(field, "t").length === 1, "§3 a literal apiKey field is refused");
	const harmless = { nodes: [{ name: "Gmail", type: "n8n-nodes-base.gmail", webhookId: "00000000-0000-4000-8000-000000000000", parameters: { operation: "getAll", filters: { q: "from:x" } } }] };
	ok(webhookProblems(harmless, "t").length === 0 && secretProblems(harmless, "t").length === 0, "§3 a Gmail node's internal webhookId and ordinary parameters pass");

	// §2, the wider names
	for (const name of ["Cookie", "x-functions-key", "subscription_key", "x-hub-signature-256", "sig"]) {
		ok(secretProblems(header("s3cr3t-value-123", name), "t").length === 1, `§3 a literal "${name}" header is refused`);
		ok(secretProblems(header("REDACTED_SET_IN_N8N", name), "t").length === 0, `§3 a placeholder "${name}" header passes`);
	}
	ok(secretProblems(wfOf(httpNode({ options: { signature: "abc123", sig: "abc123" } })), "t").length === 2, "§3 literal signature and sig fields are refused");
	const ordinary = wfOf({
		name: "Sheet", type: "n8n-nodes-base.googleSheets", parameters: {
			keyName: "Load ID", sortKey: "date", primaryKey: "id", lookupColumn: "key", options: { design: "grid" },
			columns: { mappingMode: "defineBelow", value: { "Load ID": "={{ $json.loadId }}", key: "={{ $json.key }}" }, matchingColumns: ["key"], schema: [{ id: "key", displayName: "key" }] },
		},
	});
	ok(secretProblems(ordinary, "t").length === 0, "§3 keyName, sortKey, primaryKey and a Sheets column mapping on a \"key\" column pass");

	// §4 token shapes, anywhere in the file: parameters, Code, notes, other top-level fields, field names
	const spots = {
		"a non-secret parameter": (s) => wfOf(httpNode({ jsonBody: `{"note":"${s}"}` })),
		"a Code node's script": (s) => wfOf({ name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: `const h = "${s}";` } }),
		"a node's notes": (s) => wfOf(httpNode({}, { notes: `call with ${s}` })),
		"a top-level field": (s) => ({ nodes: [], meta: { hint: s } }),
		"a field name": (s) => wfOf(httpNode({ body: { [s]: "x" } })),
	};
	for (const [label, token] of Object.entries(FAKE)) {
		for (const [spot, build] of Object.entries(spots)) {
			ok(tokenProblems(build(token), "t").length === 1, `§3 a ${label}-shaped token in ${spot} is refused`);
		}
	}
	ok(tokenProblems(wfOf(httpNode({ headerParameters: { parameters: [{ name: "Authorization", value: "Bearer REDACTED_SET_IN_N8N" }] } })), "t").length === 0,
		"§3 a Bearer REDACTED placeholder passes");
	ok(tokenProblems(wfOf(httpNode({ headerParameters: { parameters: [{ name: "Authorization", value: "=Bearer {{ $env.LLAMA_TOKEN }}" }] } })), "t").length === 0,
		"§3 a Bearer expression passes");
	ok(tokenProblems(wfOf({ name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: "const h = 'Bearer ' + token; // risk-assessment task-scheduler, the bearer of the load" } }), "t").length === 0,
		"§3 code that builds a Bearer header, and ordinary words, pass");
	const tokenProblem = tokenProblems(wfOf(httpNode({ url: FAKE.google })), "t")[0] || "";
	ok(!tokenProblem.includes(FAKE.google) && tokenProblem.includes('node "Call"'), "§3 a token problem names its node, never the value");

	// §5 keys in URLs
	const urlIn = (url) => wfOf(httpNode({ url }));
	ok(urlProblems(urlIn("https://maps.example.com/api/geocode?address=x&key=" + fill(39)), "t").length === 1, "§3 a literal key= in a URL is refused");
	for (const p of ["api_key", "apikey", "token", "access_token", "sig", "signature"]) {
		ok(urlProblems(urlIn(`https://api.example.com/v1?${p}=${fill(24)}`), "t").length === 1, `§3 a literal ${p}= in a URL is refused`);
	}
	ok(urlProblems(wfOf({ name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: `fetch("https://api.example.com/v1?token=${fill(24)}")` } }), "t").length === 1,
		"§3 a literal token= in a Code node's URL is refused");
	ok(urlProblems(urlIn("https://admin:" + fill(12) + "@n8n.example.com/api"), "t").length === 1, "§3 a literal user:password@ in a URL is refused");
	for (const url of [
		"=https://maps.example.com/api?key={{ $env.MAPS_KEY }}",
		"https://maps.example.com/api?key=REDACTED_MAPS_KEY",
		"https://sheets.example.com/v4?pageToken=abc&sortKey=asc&page=2",
		"=https://{{ $env.N8N_USER }}:{{ $env.N8N_PASS }}@n8n.example.com/api",
		"https://user:REDACTED_PASSWORD@n8n.example.com/api",
		"https://n8n.example.com:8443/api?token=",
	]) ok(urlProblems(urlIn(url), "t").length === 0, `§3 a URL with an expression, a placeholder or no key passes (${url})`);
	ok(urlProblems(wfOf({ name: "Code", type: "n8n-nodes-base.code", parameters: { jsCode: "const u = `https://api.example.com/v1?key=${key}`; const v = `https://${user}:${pass}@host/`; const t = url.match(/[?&]token=([^&]+)/);" } }), "t").length === 0,
		"§3 Code that builds a URL from variables, or reads a token from one, passes");

	// §6 webhook ids
	ok(webhookIdProblems(wfOf(httpNode({}, { webhookId: "00000000-0000-4000-8000-000000000001" })), "t").length === 1, "§3 a webhookId on an HTTP Request node is refused");
	ok(webhookIdProblems(wfOf({ name: "Hook", type: "n8n-nodes-base.webhook", webhookId: "00000000-0000-4000-8000-000000000002", parameters: { authentication: "headerAuth", path: "REDACTED_PATH" } }), "t").length === 1,
		"§3 a webhookId on an authenticated webhook node is refused");
	ok(webhookIdProblems(wfOf(
		{ name: "Send", type: "n8n-nodes-base.gmail", webhookId: "00000000-0000-4000-8000-000000000003", parameters: {} },
		{ name: "Inbox", type: "n8n-nodes-base.gmailTrigger", webhookId: "00000000-0000-4000-8000-000000000004", parameters: {} },
		httpNode({}),
	), "t").length === 0, "§3 the Gmail node's and Gmail trigger's webhookIds, and a node with none, pass");

	// §7 pinned data
	ok(pinDataProblems({ nodes: [], pinData: { Gmail: [{ json: { from: "someone@example.com", subject: "Rate con" } }] } }, "t").length === 1, "§3 pinned execution data is refused");
	ok(pinDataProblems({ nodes: [], pinData: [{ json: {} }] }, "t").length === 1, "§3 a pinData that is not an object is refused");
	ok([{ nodes: [] }, { nodes: [], pinData: null }, { nodes: [], pinData: {} }].every((wf) => pinDataProblems(wf, "t").length === 0),
		"§3 an absent, null or empty pinData passes");

	// §8 nested copies of the nodes
	ok(nestedNodesProblems({ nodes: [httpNode({})], activeVersion: { versionId: "v1", nodes: [httpNode({})] } }, "t").length === 1, "§3 an activeVersion.nodes copy is refused");
	ok(nestedNodesProblems({ nodes: [], meta: { history: [{ snapshot: { nodes: [] } }] } }, "t").length === 1, "§3 a nodes array nested anywhere is refused, even an empty one");
	ok(nestedNodesProblems({ nodes: [{ ...httpNode({}), name: "nodes" }], connections: { nodes: { main: [[{ node: "Next", type: "main", index: 0 }]] } } }, "t").length === 0,
		"§3 the top-level nodes, and a node that happens to be named \"nodes\", pass");
}

for (const [name, run] of [["§1/§2/§4–§8", exportsSection], ["§3", selfCheckSection]]) {
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
