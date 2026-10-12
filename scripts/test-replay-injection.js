#!/usr/bin/env node
/**
 * scripts/replay-via-webhook-injection.js puts a temporary webhook into the
 * production n8n workflow. That webhook must not be an open endpoint, and the
 * replay must not disturb the workflow it borrows.
 *
 *   §1 THE INJECTED NODES. The webhook requires the Header Auth credential it is
 *      given, answers at once with no workflow output (onReceived), and its path
 *      is a fresh random UUID; the Gmail node uses the Gmail credential given.
 *   §2 THE PUT BODY never carries staticData (the Gmail trigger's poll state)
 *      and keeps only the settings the API accepts.
 *   §3 UNPUBLISHED EDITS are detected, so a replay can't publish them.
 *   §4 THE REQUEST that fires the webhook presents the secret in x-replay-secret.
 *   §5 THE BACKUP goes to N8N_BACKUP_DIR, else ~/LogisX-replica/n8n-backups.
 *   §6 A WHOLE RUN against a stub n8n on loopback: both PUTs without staticData,
 *      the webhook fired on the injected path with the secret, the workflow put
 *      back as it was, the backup written mode 600 outside the repo, and the
 *      secret never printed.
 *   §7 REFUSALS: unpublished edits stop the run before any backup, PUT or call;
 *      a webhook that refuses the secret still ends with the workflow restored.
 *
 * Plain node; the only network is a stub server on 127.0.0.1.
 * Run: node scripts/test-replay-injection.js
 */
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "replay-via-webhook-injection.js");
const replay = require(SCRIPT);

let pass = 0;
const failures = [];
function ok(cond, label) { if (cond) pass++; else failures.push(label); }
function section(t) { console.log(`\n${t}`); }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const emailInput = { name: "Email Input", type: "n8n-nodes-base.set", position: [1000, 400], parameters: {} };
const fixture = (extra = {}) => ({
	id: "wf-under-test",
	name: "Dispatch fixture",
	active: true,
	nodes: [
		{ name: "Gmail Trigger", type: "n8n-nodes-base.gmailTrigger", position: [0, 0], parameters: {}, credentials: { gmailOAuth2: { id: "gmail-cred", name: "Gmail fixture" } } },
		emailInput,
	],
	connections: { "Gmail Trigger": { main: [[{ node: "Email Input", type: "main", index: 0 }]] } },
	settings: { executionOrder: "v1", errorWorkflow: "err-wf", binaryMode: "separate" },
	staticData: { "node:Gmail Trigger": { lastTimeChecked: 1 } },
	...extra,
});

function nodesSection() {
	section("§1 the injected nodes");
	const p = replay.newWebhookPath();
	const [hook, get] = replay.buildReplayNodes({
		emailInput, messageId: "msg-1", gmailCredential: { id: "gmail-cred", name: "Gmail fixture" }, replayCredentialId: "replay-cred", webhookPath: p,
	});
	ok(hook.type === "n8n-nodes-base.webhook" && hook.name === replay.INJECTED_NAMES[0], "§1 the first node is the replay webhook");
	ok(hook.parameters.authentication === "headerAuth", "§1 the webhook requires Header Auth");
	ok(hook.credentials?.httpHeaderAuth?.id === "replay-cred", "§1 …with the credential it was given");
	ok(hook.parameters.responseMode === "onReceived", "§1 the webhook answers at once, with no workflow output");
	ok(hook.parameters.path === p && UUID.test(p), "§1 its path is the random UUID it was given");
	ok(UUID.test(hook.webhookId) && UUID.test(hook.id) && UUID.test(get.id), "§1 node ids and webhookId are random UUIDs");
	ok(get.type === "n8n-nodes-base.gmail" && get.parameters.messageId === "msg-1", "§1 the Gmail node fetches the named message");
	ok(get.credentials?.gmailOAuth2?.id === "gmail-cred", "§1 …with the Gmail credential it was given");
	const paths = new Set(Array.from({ length: 50 }, () => replay.newWebhookPath()));
	ok(paths.size === 50 && [...paths].every((x) => UUID.test(x)), "§1 every run gets a different random path");
}

function putSection() {
	section("§2 the PUT body");
	const body = replay.buildPutPayload(fixture());
	ok(!("staticData" in body), "§2 no staticData");
	ok(JSON.stringify(Object.keys(body)) === JSON.stringify(["name", "nodes", "connections", "settings"]), "§2 name, nodes, connections and settings only");
	ok(JSON.stringify(body.settings) === JSON.stringify({ errorWorkflow: "err-wf", executionOrder: "v1" }), "§2 settings the API doesn't accept are left out");
}

function unpublishedSection() {
	section("§3 unpublished edits");
	const wf = fixture();
	ok(replay.hasUnpublishedEdits(wf) === false, "§3 no published copy in the reply: nothing to compare");
	ok(replay.hasUnpublishedEdits({ ...wf, activeVersion: { nodes: wf.nodes, connections: wf.connections } }) === false, "§3 draft equal to the published version");
	ok(replay.hasUnpublishedEdits({ ...wf, activeVersion: { nodes: wf.nodes.slice(1), connections: wf.connections } }) === true, "§3 a node differs");
	ok(replay.hasUnpublishedEdits({ ...wf, activeVersion: { nodes: wf.nodes, connections: {} } }) === true, "§3 the connections differ");
}

function requestSection() {
	section("§4 the request that fires the webhook");
	const r = replay.replayRequest("s3cr3t");
	ok(r.method === "POST", "§4 POST");
	ok(replay.REPLAY_HEADER === "x-replay-secret" && r.headers["x-replay-secret"] === "s3cr3t", "§4 the secret goes in x-replay-secret");
}

function backupSection() {
	section("§5 where the backup goes");
	ok(replay.backupDir({ N8N_BACKUP_DIR: "/somewhere/else" }) === "/somewhere/else", "§5 N8N_BACKUP_DIR when set");
	const def = path.join(os.homedir(), "LogisX-replica", "n8n-backups");
	ok(replay.backupDir({}) === def && replay.backupDir({ N8N_BACKUP_DIR: "  " }) === def, "§5 else ~/LogisX-replica/n8n-backups");
	ok(!replay.backupDir({}).startsWith(ROOT), "§5 never inside the repo");
}

// A stub n8n: the workflow API, the executions API and the webhook endpoint.
function stubN8n(wf, { webhookStatus = 200 } = {}) {
	const seen = { puts: [], webhooks: [], keys: new Set(), executionLists: 0 };
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => { raw += c; });
		req.on("end", () => {
			const url = new URL(req.url, "http://stub");
			const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
			if (url.pathname.startsWith("/api/v1/")) seen.keys.add(req.headers["x-n8n-api-key"]);
			if (url.pathname === `/api/v1/workflows/${wf.id}` && req.method === "GET") return send(200, wf);
			if (url.pathname === `/api/v1/workflows/${wf.id}` && req.method === "PUT") { seen.puts.push(JSON.parse(raw)); return send(200, {}); }
			if (url.pathname === "/api/v1/executions") {
				seen.executionLists++;
				return send(200, { data: [seen.executionLists === 1 ? { id: "10" } : { id: "11", status: "success", startedAt: "2026-10-12T00:00:00.000Z" }] });
			}
			if (url.pathname === "/api/v1/executions/11") return send(200, { id: "11", status: "success", data: { resultData: { runData: { "Email Input": [{}] } } } });
			if (url.pathname.startsWith("/webhook/") && req.method === "POST") {
				seen.webhooks.push({ path: url.pathname.slice("/webhook/".length), secret: req.headers["x-replay-secret"] });
				return send(webhookStatus, webhookStatus === 200 ? { message: "Workflow was started" } : { message: "Authorization data is wrong!" });
			}
			return send(404, { message: "not found" });
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function runReplay(base, home, extraEnv = {}) {
	const env = {
		PATH: process.env.PATH, HOME: home, TMPDIR: home,
		N8N_BASE_URL: base, N8N_WORKFLOW_ID: "wf-under-test", N8N_API_KEY: "api-key-under-test",
		N8N_GMAIL_CREDENTIAL_ID: "gmail-cred", N8N_REPLAY_CREDENTIAL_ID: "replay-cred", N8N_REPLAY_SECRET: "replay-secret-under-test",
		...extraEnv,
	};
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [SCRIPT, "msg-under-test"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (c) => { out += c; });
		child.stderr.on("data", (c) => { out += c; });
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
	});
}

async function wholeRunSection(tmp) {
	section("§6 a whole run against a stub n8n");
	const wf = fixture();
	wf.activeVersion = { nodes: wf.nodes, connections: wf.connections };
	const { server, seen, base } = await stubN8n(wf);
	const home = fs.mkdtempSync(path.join(tmp, "run-"));
	const backups = path.join(home, "backups");
	try {
		const r = await runReplay(base, home, { N8N_BACKUP_DIR: backups });
		ok(r.code === 0, `§6 the run ends 0 (got ${r.code}: ${r.out.split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 200)})`);
		ok(seen.puts.length === 2, `§6 two PUTs: inject, then restore (got ${seen.puts.length})`);
		ok(seen.puts.every((b) => !("staticData" in b)), "§6 neither PUT sends staticData");
		const injected = seen.puts[0]?.nodes?.find((n) => n.name === "Replay Webhook");
		ok(injected?.parameters?.authentication === "headerAuth" && injected?.credentials?.httpHeaderAuth?.id === "replay-cred", "§6 the injected webhook requires the named Header Auth credential");
		ok(injected?.parameters?.responseMode === "onReceived" && UUID.test(injected?.parameters?.path || ""), "§6 …answers at once, on a random UUID path");
		ok(seen.webhooks.length === 1 && seen.webhooks[0].path === injected?.parameters?.path, "§6 the webhook was fired once, on the injected path");
		ok(seen.webhooks[0]?.secret === "replay-secret-under-test", "§6 …presenting the secret");
		ok(JSON.stringify(seen.puts[1]) === JSON.stringify(replay.buildPutPayload(wf)), "§6 the restore puts the workflow back exactly as it was");
		const files = fs.existsSync(backups) ? fs.readdirSync(backups) : [];
		const backup = files[0] && path.join(backups, files[0]);
		ok(files.length === 1 && (fs.statSync(backup).mode & 0o777) === 0o600, "§6 one backup, mode 600, in N8N_BACKUP_DIR");
		ok((fs.statSync(backups).mode & 0o777) === 0o700, "§6 the backup folder it made is mode 700");
		ok(backup && fs.readFileSync(backup, "utf8") === JSON.stringify(replay.buildPutPayload(wf), null, 2), "§6 the backup is the restore's PUT body, so it can be PUT by hand");
		ok(!fs.readdirSync(__dirname).some((f) => f.startsWith(".wf-backup-")) && fs.readdirSync(home).every((f) => f === "backups"), "§6 nothing written in the repo's scripts/ or the working directory");
		ok(!r.out.includes("replay-secret-under-test") && !r.out.includes("api-key-under-test"), "§6 neither the secret nor the API key is printed");
		ok(seen.keys.size === 1 && seen.keys.has("api-key-under-test"), "§6 every API call carries the API key");
	} finally {
		server.close();
	}
}

async function refusalSection(tmp) {
	section("§7 refusals");
	{
		const wf = fixture();
		wf.activeVersion = { nodes: wf.nodes.slice(0, 1), connections: {} };
		const { server, seen, base } = await stubN8n(wf);
		const home = fs.mkdtempSync(path.join(tmp, "unpub-"));
		const backups = path.join(home, "backups");
		try {
			const r = await runReplay(base, home, { N8N_BACKUP_DIR: backups });
			ok(r.code === 1 && /unpublished edits/.test(r.out), `§7 unpublished edits: refused, exit 1 (got ${r.code})`);
			ok(seen.puts.length === 0 && seen.webhooks.length === 0 && seen.executionLists === 0, "§7 …before any PUT, webhook or executions call");
			ok(!fs.existsSync(backups), "§7 …and before writing a backup");
		} finally {
			server.close();
		}
	}
	{
		const wf = fixture();
		const { server, seen, base } = await stubN8n(wf, { webhookStatus: 403 });
		const home = fs.mkdtempSync(path.join(tmp, "refused-"));
		try {
			const r = await runReplay(base, home, { N8N_BACKUP_DIR: path.join(home, "backups") });
			ok(r.code === 1 && /answered 403/.test(r.out), `§7 a webhook that refuses the secret ends the run, exit 1 (got ${r.code})`);
			ok(seen.puts.length === 2 && JSON.stringify(seen.puts[1]) === JSON.stringify(replay.buildPutPayload(wf)), "§7 …and the workflow is still put back as it was");
		} finally {
			server.close();
		}
	}
}

(async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay-injection-"));
	try {
		for (const [name, run] of [["§1", nodesSection], ["§2", putSection], ["§3", unpublishedSection], ["§4", requestSection], ["§5", backupSection],
			["§6", () => wholeRunSection(tmp)], ["§7", () => refusalSection(tmp)]]) {
			try { await run(); } catch (e) { failures.push(`${name} threw: ${e && e.stack}`); }
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})();
