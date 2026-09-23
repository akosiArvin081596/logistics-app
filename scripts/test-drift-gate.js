#!/usr/bin/env node
/**
 * Locks the STAGING GATE on deploy-drift.yml's heal (scripts/deploy/drift-gate.js).
 *
 * WHY IT EXISTS. A drift heal may deploy only a commit whose own staging job
 * passed, and the box cannot see staging's verdict, so the gate asks GitHub.
 * Each property below is a way the gate could quietly stop gating:
 *
 *   §1 the state → action table: only `behind-healable` heals, and anything
 *      unknown (unparseable ssh output) ALARMS rather than heals
 *   §2 refineState(): the staging verdict can only narrow a heal, never create
 *      one, and never override the box's own alarms
 *   §3 stagingVerdict(): success is the ONLY passing verdict; the newest run
 *      wins; a run for some OTHER commit can never approve this one
 *   §4 lookupStaging(): the exact API calls, retry on 5xx/429 only, fatal on 4xx
 *   §5 decide(): every failure path is fail-closed (unverified), never a heal
 *   §6 the CLI end to end against a local fake GitHub API, including the
 *      $GITHUB_OUTPUT contract deploy-drift.yml reads
 *   §7 source pins — the workflow files and the gate agree (job name,
 *      concurrency group, queue: max, the heal's rollback, the retry helper);
 *      no workflow or action puts an expression inside a run: script or uses a
 *      bare `ssh -i`; backup-freshness.yml uses the shared ssh helpers under
 *      its OWN concurrency group and its remote half never takes the deploy lock
 *   §8 mutants — a gate that heals on a staging failure, or trusts a run for
 *      another commit, must be caught by the assertions above
 *
 * Hermetic: no network beyond a 127.0.0.1 server it starts itself, no secrets.
 * Run: node scripts/test-drift-gate.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const GATE_PATH = path.join(__dirname, "deploy", "drift-gate.js");
const gate = require(GATE_PATH);

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const run = (id, extra = {}) => ({ id, event: "push", head_sha: SHA, status: "completed", conclusion: "success", html_url: `https://x/runs/${id}`, ...extra });
const job = (name, status, conclusion) => ({ name, status, conclusion, html_url: `https://x/jobs/${name}` });

// ────────────────────────────────────────────────────── §1 state → action table
function checkActionTable(g, tag = "") {
	const r = [];
	const expect = {
		"in-sync": "none",
		"behind-healable": "heal",
		"behind-staging-pending": "notice",
		"behind-already-attempted": "alarm",
		"behind-and-unhealthy": "alarm",
		"behind-staging-failed": "alarm",
		"behind-staging-unverified": "alarm",
	};
	for (const [state, action] of Object.entries(expect)) {
		r.push([g.actionFor(state) === action, `${tag}§1 ${state} must map to '${action}' (got '${g.actionFor(state)}')`]);
	}
	for (const junk of ["", "behind", "BEHIND-HEALABLE", "behind-healable ", "toString", "__proto__", "constructor"]) {
		r.push([g.actionFor(junk) === "alarm", `${tag}§1 unknown state ${JSON.stringify(junk)} must ALARM, never heal (got '${g.actionFor(junk)}')`]);
	}
	const heals = Object.keys(g.ACTIONS).filter((s) => g.ACTIONS[s] === "heal");
	r.push([heals.length === 1 && heals[0] === "behind-healable", `${tag}§1 exactly one state may heal (got ${JSON.stringify(heals)})`]);
	return r;
}
for (const [c, m] of checkActionTable(gate)) ok(c, m);
for (const s of Object.keys(gate.ACTIONS)) {
	ok(typeof gate.hintFor(s) === "string" && gate.hintFor(s).length > 20, `§1 state ${s} must carry an operator hint`);
}

// ────────────────────────────────────────────────────── §2 refineState
function checkRefine(g, tag = "") {
	const r = [];
	r.push([g.refineState("behind-healable", "passed") === "behind-healable", `${tag}§2 healable + passed stays healable`]);
	r.push([g.refineState("behind-healable", "failed") === "behind-staging-failed", `${tag}§2 healable + staging FAILED must become behind-staging-failed — a rejected commit never heals`]);
	r.push([g.refineState("behind-healable", "pending") === "behind-staging-pending", `${tag}§2 healable + pending must wait, not heal`]);
	for (const v of ["unverified", "", undefined, null, "PASSED", "success"]) {
		r.push([g.refineState("behind-healable", v) === "behind-staging-unverified", `${tag}§2 healable + verdict ${JSON.stringify(v)} must fail closed as unverified`]);
	}
	for (const box of ["in-sync", "behind-already-attempted", "behind-and-unhealthy", ""]) {
		for (const v of ["passed", "failed", "pending", "unverified"]) {
			r.push([g.refineState(box, v) === box, `${tag}§2 box state '${box}' must not be changed by verdict '${v}'`]);
		}
	}
	return r;
}
for (const [c, m] of checkRefine(gate)) ok(c, m);

// ────────────────────────────────────────────────────── §3 stagingVerdict
function checkVerdicts(g, tag = "") {
	const r = [];
	const V = (runs, jobs, sha = SHA) => g.stagingVerdict(runs, jobs, sha).verdict;
	r.push([V([], {}) === "unverified", `${tag}§3 no run at all → unverified`]);
	r.push([V(undefined, undefined) === "unverified", `${tag}§3 garbage input → unverified`]);
	r.push([V([run(1)], { 1: [job("staging", "completed", "success"), job("production", "completed", "failure")] }) === "passed",
		`${tag}§3 staging success passes even when PRODUCTION failed — the transport-failure case must stay healable`]);
	for (const c of ["failure", "cancelled", "timed_out", "skipped", "action_required", "neutral", "stale", null]) {
		r.push([V([run(1)], { 1: [job("staging", "completed", c)] }) === "failed", `${tag}§3 staging concluded ${JSON.stringify(c)} → failed (only 'success' passes)`]);
	}
	r.push([V([run(1, { status: "in_progress", conclusion: null })], { 1: [job("staging", "in_progress", null)] }) === "pending", `${tag}§3 staging still running → pending`]);
	r.push([V([run(1, { status: "queued", conclusion: null })], { 1: [] }) === "pending", `${tag}§3 run queued, no jobs yet → pending`]);
	r.push([V([run(1, { status: "in_progress", conclusion: null })], { 1: [job("staging", "completed", "failure")] }) === "failed",
		`${tag}§3 staging failed while the run is still finishing → failed, not pending`]);
	r.push([V([run(1, { conclusion: "failure" })], { 1: [] }) === "failed", `${tag}§3 completed run with NO staging job (invalid workflow / startup failure) → failed`]);
	r.push([V([run(1)], { 1: [job("Staging", "completed", "success")] }) === "failed", `${tag}§3 the staging job is matched by its exact name`]);
	r.push([V([run(1)], { 1: [job("deploy staging", "completed", "success")] }) === "failed", `${tag}§3 a job merely CONTAINING 'staging' must not count`]);
	r.push([V([run(1, { event: "workflow_dispatch" })], { 1: [job("staging", "completed", "success")] }) === "unverified",
		`${tag}§3 a manual dispatch run is not a staging verdict for this commit`]);
	r.push([V([run(1, { head_sha: OTHER })], { 1: [job("staging", "completed", "success")] }) === "unverified",
		`${tag}§3 a run for ANOTHER commit must never approve this one`]);
	// Newest run wins, in both directions.
	r.push([V([run(1), run(2)], { 1: [job("staging", "completed", "success")], 2: [job("staging", "completed", "failure")] }) === "failed",
		`${tag}§3 an older success must not outvote a newer staging failure for the same commit`]);
	r.push([V([run(2), run(1)], { 1: [job("staging", "completed", "failure")], 2: [job("staging", "completed", "success")] }) === "passed",
		`${tag}§3 a newer success supersedes an older failure (and input order does not matter)`]);
	const detail = g.stagingVerdict([run(7)], { 7: [job("staging", "completed", "failure")] }, SHA);
	r.push([/7/.test(detail.detail) && /failure/.test(detail.detail) && detail.url === "https://x/jobs/staging", `${tag}§3 the verdict names the run, the conclusion and the job URL`]);
	return r;
}
for (const [c, m] of checkVerdicts(gate)) ok(c, m);

// ────────────────────────────────────────────────────── §4 lookupStaging
function fakeFetch(routes) {
	const calls = [];
	const fn = async (url, opts) => {
		calls.push({ url, headers: (opts && opts.headers) || {} });
		for (const [re, handler] of routes) {
			if (re.test(url)) {
				const res = typeof handler === "function" ? handler(url, calls.length) : handler;
				if (res instanceof Error) throw res;
				return {
					status: res.status || 200,
					ok: (res.status || 200) >= 200 && (res.status || 200) < 300,
					json: async () => res.body,
				};
			}
		}
		return { status: 404, ok: false, json: async () => ({}) };
	};
	fn.calls = calls;
	return fn;
}
const noSleep = async () => {};

(async () => {
	{
		const f = fakeFetch([
			[/\/actions\/workflows\/deploy\.yml\/runs\?/, { body: { workflow_runs: [run(42)] } }],
			[/\/actions\/runs\/42\/jobs\?/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, token: "tkn", apiBase: "https://api.example/", fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "passed", `§4 happy path passes (got ${v.verdict})`);
		const u = new URL(f.calls[0].url);
		ok(u.origin === "https://api.example" && u.pathname === "/repos/o/r/actions/workflows/deploy.yml/runs", `§4 lists runs of deploy.yml (got ${f.calls[0].url})`);
		ok(u.searchParams.get("head_sha") === SHA, "§4 filters by head_sha = the target commit");
		ok(u.searchParams.get("event") === "push", "§4 filters to push-triggered runs");
		ok(/\/actions\/runs\/42\/jobs\?/.test(f.calls[1].url) && new URL(f.calls[1].url).searchParams.get("filter") === "latest",
			"§4 reads the newest attempt's jobs (filter=latest)");
		ok(f.calls[0].headers.Authorization === "Bearer tkn", "§4 authenticates with the workflow token");
		ok(f.calls.length === 2, `§4 exactly two API calls (got ${f.calls.length})`);
	}
	{
		// The API ignoring head_sha must not let another commit's success through.
		const f = fakeFetch([
			[/\/runs\?/, { body: { workflow_runs: [run(9, { head_sha: OTHER })] } }],
			[/\/runs\/9\/jobs/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "unverified", `§4 a run for another commit is filtered client-side (got ${v.verdict})`);
		ok(!f.calls.some((c) => /\/jobs\?/.test(c.url)), "§4 …and its jobs are never even fetched");
	}
	{
		// The race the re-look exists for: the drift run reads the box seconds
		// after a push, before GitHub has created that push's Deploy run.
		let lists = 0;
		const slept = [];
		const f = fakeFetch([
			[/\/runs\?/, () => (++lists === 1 ? { body: { workflow_runs: [] } } : { body: { workflow_runs: [run(21)] } })],
			[/\/runs\/21\/jobs/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: async (ms) => { slept.push(ms); } });
		ok(v.verdict === "passed" && lists === 2, `§4 no run on the first look, one on the re-look → passed (verdict ${v.verdict}, looks ${lists})`);
		ok(slept.length === 1 && slept[0] === 20000, `§4 the re-look waits 20 s by default (slept ${JSON.stringify(slept)})`);
	}
	{
		let lists = 0;
		const f = fakeFetch([[/\/runs\?/, () => { lists++; return { body: { workflow_runs: [] } }; }]]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "unverified" && lists === 2, `§4 still no run after ONE re-look → unverified (looks ${lists})`);
		lists = 0;
		await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep, missingRetryMs: 0 });
		ok(lists === 1, "§4 missingRetryMs: 0 disables the re-look");
	}
	{
		let n = 0;
		const f = fakeFetch([
			[/\/runs\?/, () => (++n < 3 ? { status: n === 1 ? 502 : 429, body: {} } : { body: { workflow_runs: [run(5)] } })],
			[/\/runs\/5\/jobs/, { body: { jobs: [job("staging", "completed", "success")] } }],
		]);
		const v = await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep });
		ok(v.verdict === "passed" && n === 3, `§4 5xx and 429 are retried (passed after ${n} calls)`);
	}
	{
		let n = 0;
		const f = fakeFetch([[/\/runs\?/, () => { n++; return { status: 403, body: {} }; }]]);
		let threw = false;
		try { await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep }); } catch { threw = true; }
		ok(threw && n === 1, `§4 a 4xx is fatal and NOT retried (calls=${n})`);
	}
	{
		const f = fakeFetch([[/\/runs\?/, new Error("socket hang up")]]);
		let threw = false;
		try { await gate.lookupStaging({ repo: "o/r", sha: SHA, fetchImpl: f, sleepImpl: noSleep }); } catch { threw = true; }
		ok(threw && f.calls.length === 3, `§4 a network error is retried, then surfaces (calls=${f.calls.length})`);
	}

	// ──────────────────────────────────────────────────── §5 decide(): fail-closed
	{
		const never = fakeFetch([[/./, () => { throw new Error("must not be called"); }]]);
		for (const box of ["in-sync", "behind-already-attempted", "behind-and-unhealthy"]) {
			const d = await gate.decide({ boxState: box, targetSha: SHA, repo: "o/r", fetchImpl: never, sleepImpl: noSleep });
			ok(d.state === box && never.calls.length === 0, `§5 box state ${box} needs no API call and is passed through`);
		}
		const bad = await gate.decide({ boxState: "behind-healable", targetSha: "abc", repo: "o/r", fetchImpl: never, sleepImpl: noSleep });
		ok(bad.action === "alarm" && bad.state === "behind-staging-unverified", "§5 no usable target SHA → unverified alarm, not a heal");
		const norepo = await gate.decide({ boxState: "behind-healable", targetSha: SHA, repo: "", fetchImpl: never, sleepImpl: noSleep });
		ok(norepo.action === "alarm", "§5 no repository → unverified alarm");
		const boom = await gate.decide({ boxState: "behind-healable", targetSha: SHA, repo: "o/r", fetchImpl: fakeFetch([[/./, { status: 500, body: {} }]]), sleepImpl: noSleep });
		ok(boom.action === "alarm" && /API lookup failed/.test(boom.detail), "§5 an API outage → unverified alarm, never a heal");
		const empty = await gate.decide({ boxState: "", targetSha: SHA, repo: "o/r", fetchImpl: never, sleepImpl: noSleep });
		ok(empty.action === "alarm", "§5 an empty box state (unparseable ssh output) alarms");
	}

	// ──────────────────────────────────────────────────── §6 the CLI, end to end
	await cliScenarios();

	// ──────────────────────────────────────────────────── §7 source pins
	sourcePins();

	// ──────────────────────────────────────────────────── §8 mutants
	mutants();

	report();
})().catch((err) => {
	console.error(err);
	process.exit(1);
});

async function cliScenarios() {
	const scenarios = {
		passed: { runs: [run(11)], jobs: { 11: [job("staging", "completed", "success"), job("production", "completed", "failure")] } },
		failed: { runs: [run(12)], jobs: { 12: [job("staging", "completed", "failure"), job("production", "completed", "skipped")] } },
		pending: { runs: [run(13, { status: "in_progress", conclusion: null })], jobs: { 13: [job("staging", "in_progress", null)] } },
		none: { runs: [], jobs: {} },
	};
	let current = "passed";
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push({ url: req.url, auth: req.headers.authorization || "" });
		const sc = scenarios[current];
		let body = null;
		if (/^\/repos\/o\/r\/actions\/workflows\/deploy\.yml\/runs\?/.test(req.url)) body = { workflow_runs: sc.runs };
		const m = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs\?/.exec(req.url);
		if (m) body = { jobs: sc.jobs[m[1]] || [] };
		res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
		res.end(JSON.stringify(body || { message: "Not Found" }));
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const api = `http://127.0.0.1:${server.address().port}`;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drift-gate-"));
	try {
		const cli = async (box, target, scenario) => {
			current = scenario;
			const outFile = path.join(tmp, `out-${Math.random().toString(36).slice(2)}`);
			fs.writeFileSync(outFile, "");
			const env = {
				PATH: process.env.PATH,
				BOX_STATE: box,
				TARGET_SHA: target,
				GITHUB_REPOSITORY: "o/r",
				GITHUB_TOKEN: "cli-token",
				GITHUB_API_URL: api,
				GITHUB_OUTPUT: outFile,
				DRIFT_GATE_MISSING_RETRY_MS: "0",
			};
			const r = await new Promise((resolve) => {
				const child = spawn(process.execPath, [GATE_PATH], { env });
				let out = "";
				child.stdout.on("data", (c) => (out += c));
				child.stderr.on("data", (c) => (out += c));
				child.on("close", (code) => resolve({ code, out }));
			});
			const outputs = Object.fromEntries(
				fs.readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
			);
			return { ...r, outputs };
		};
		let r = await cli("behind-healable", SHA, "passed");
		ok(r.code === 0 && r.outputs.action === "heal" && r.outputs.state === "behind-healable",
			`§6 CLI: staging passed → heal (got ${JSON.stringify(r.outputs)})`);
		ok(seen.some((s) => s.auth === "Bearer cli-token"), "§6 CLI sends GITHUB_TOKEN to the API");
		r = await cli("behind-healable", SHA, "failed");
		ok(r.code === 0 && r.outputs.action === "alarm" && r.outputs.state === "behind-staging-failed",
			`§6 CLI: staging failed → behind-staging-failed alarm (got ${JSON.stringify(r.outputs)})`);
		r = await cli("behind-healable", SHA, "pending");
		ok(r.outputs.action === "notice" && r.outputs.state === "behind-staging-pending", "§6 CLI: staging pending → quiet notice");
		r = await cli("behind-healable", SHA, "none");
		ok(r.outputs.action === "alarm" && r.outputs.state === "behind-staging-unverified", "§6 CLI: no run → unverified alarm");
		const before = seen.length;
		r = await cli("in-sync", SHA, "passed");
		ok(r.outputs.action === "none" && seen.length === before, "§6 CLI: in-sync makes no API call");
		r = await cli("behind-already-attempted", SHA, "passed");
		ok(r.outputs.action === "alarm" && r.outputs.state === "behind-already-attempted", "§6 CLI: the box's own alarm survives a passing staging");
		for (const k of ["state", "action", "verdict", "detail", "hint"]) {
			ok(Object.prototype.hasOwnProperty.call(r.outputs, k), `§6 CLI writes '${k}' to $GITHUB_OUTPUT (deploy-drift.yml reads it)`);
		}
		ok(Object.values(r.outputs).every((v) => !/[\r\n]/.test(v)), "§6 every output value is single-line");
		// API unreachable: the CLI still exits 0 (the workflow branches on action) and alarms.
		const dead = await new Promise((resolve) => {
			const child = spawn(process.execPath, [GATE_PATH], {
				env: { PATH: process.env.PATH, BOX_STATE: "behind-healable", TARGET_SHA: SHA, GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: "http://127.0.0.1:9", DRIFT_GATE_RETRY_MS: "0,0", DRIFT_GATE_MISSING_RETRY_MS: "0" },
			});
			let out = "";
			child.stdout.on("data", (c) => (out += c));
			child.on("close", (code) => resolve({ code, out }));
		});
		ok(dead.code === 0 && /DRIFT_ACTION=alarm/.test(dead.out) && /DRIFT_STATE=behind-staging-unverified/.test(dead.out),
			`§6 CLI: API unreachable → unverified alarm (got: ${dead.out.trim().split("\n").join(" | ")})`);
	} finally {
		server.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

// Every run: script in a workflow or action file, as { line, text }. Indentation
// aware: a script is the run: line's own value plus every following line that
// is blank or indented deeper than the `run` key, which covers `run: |`,
// `run: >-` and a plain one-liner alike. The text is NOT comment-stripped on
// purpose: GitHub substitutes an expression before bash runs, so one inside a
// shell comment is substituted too.
function runScripts(yaml) {
	const lines = yaml.split("\n");
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^(\s*)(-\s+)?run:(.*)$/.exec(lines[i]);
		if (!m) continue;
		const keyCol = m[1].length + (m[2] ? m[2].length : 0);
		const body = [m[3]];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const l = lines[j];
			if (l.trim() !== "" && l.length - l.trimStart().length <= keyCol) break;
			body.push(l);
		}
		out.push({ line: i + 1, text: body.join("\n") });
		i = j - 1;
	}
	return out;
}

function sourcePins() {
	const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
	const deploy = read(".github/workflows/deploy.yml");
	const drift = read(".github/workflows/deploy-drift.yml");
	const action = read(".github/actions/vps-deploy/action.yml");
	const noComments = (s) => s.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

	const stagingName = /\n {2}staging:\n(?:.*\n)*? {4}name:\s*(\S+)/.exec(deploy);
	ok(stagingName && stagingName[1] === gate.STAGING_JOB_NAME,
		`§7 deploy.yml's staging job must be named '${gate.STAGING_JOB_NAME}' — drift-gate.js finds it by name (got ${stagingName && stagingName[1]})`);
	ok(gate.DEPLOY_WORKFLOW_FILE === "deploy.yml" && fs.existsSync(path.join(ROOT, ".github/workflows", gate.DEPLOY_WORKFLOW_FILE)),
		"§7 the gate queries the workflow file that actually exists");

	const conc = (s) => {
		const m = /\nconcurrency:\n((?: {2}.*\n)+)/.exec(noComments(s));
		const block = m ? m[1] : "";
		const g = /group:\s*(\S+)/.exec(block);
		return { group: g && g[1], queueMax: /\bqueue:\s*max\b/.test(block), noCancel: /cancel-in-progress:\s*false/.test(block) };
	};
	const cd = conc(deploy);
	const cr = conc(drift);
	ok(cd.group && cd.group === cr.group, `§7 deploy.yml and deploy-drift.yml must share ONE concurrency group (got ${cd.group} vs ${cr.group})`);
	ok(cd.group && !/\$\{\{/.test(cd.group), "§7 the shared group is a literal, not an expression that could resolve differently per workflow");
	ok(cd.queueMax && cr.queueMax, "§7 both workflows set queue: max — the default cancels a pending run, so a drift tick could cancel a queued deploy");
	ok(cd.noCancel && cr.noCancel, "§7 neither workflow may cancel an in-progress deploy");

	const d = noComments(drift);
	ok(/node scripts\/deploy\/drift-gate\.js/.test(d), "§7 deploy-drift.yml runs the gate");
	ok(/permissions:\s*\n(?: {2}.*\n)*? {2}actions:\s*read/.test(d), "§7 deploy-drift.yml grants actions: read (the gate reads Deploy runs)");
	ok(/uses:\s*\.\/\.github\/actions\/vps-deploy/.test(d), "§7 the heal uses the shared vps-deploy action");
	ok(/rollback_on_failure:\s*"true"/.test(d), "§7 the heal auto-rolls-back on failed verification");
	ok(/sha:\s*\$\{\{\s*needs\.check\.outputs\.remote\s*\}\}/.test(d), "§7 the heal deploys EXACTLY the gated commit");
	ok(/if:\s*needs\.check\.outputs\.action == 'heal'/.test(d), "§7 the heal job runs only on action == heal");
	ok(/environment:\s*\n\s+name:\s*production/.test(d), "§7 the heal runs in the production environment (a re-armed reviewer gates it)");
	ok(/if:\s*steps\.prep\.outputs\.ready == 'yes'/.test(d), "§7 the deploy waits for the heal prep's HEAL_READY=yes");
	ok(!/\bssh\s+-i\b/.test(d) && !/\bssh\s+-i\b/.test(noComments(action)), "§7 no bare `ssh -i` left in a workflow — every connection goes through ssh-retry.sh");
	ok(!/ssh_retry\.sh|RUNNER_TEMP/.test(noComments(action)), "§7 the action no longer carries its own heredoc copy of the retry helper");
	ok((d.match(/scripts\/deploy\/ssh-retry\.sh/g) || []).length >= 2, "§7 the drift check and the heal prep both use ssh-retry.sh");

	const pd = noComments(deploy);
	const shaPins = pd.match(/sha:\s*\$\{\{\s*github\.event_name == 'push' && github\.sha \|\| '' \}\}/g) || [];
	ok(shaPins.length === 2, `§7 both deploy.yml jobs pin a push to github.sha (found ${shaPins.length})`);
	ok(/SHA='\$SHA'/.test(action), "§7 the action forwards SHA to remote-deploy.sh");

	// ── The run: scanner checks itself first. A scanner that silently matches
	// nothing would make every rule below pass vacuously — the quiet inverse of
	// ci.yml's tripwire, which once matched its own comment text.
	const fixture = [
		"jobs:",
		"  j:",
		"    steps:",
		"      - name: bad",
		"        run: |",
		"          echo \"${{ secrets.X }}\"",
		"      - name: good",
		"        env:",
		"          X: ${{ secrets.X }}",
		"        if: steps.a.outputs.b != 'c'",
		"        run: |",
		"          echo \"$X\"",
		"      - run: echo ${{ github.head_ref }}",
		"      - uses: ./x",
		"        with:",
		"          k: ${{ secrets.K }}",
	].join("\n");
	const fxRuns = runScripts(fixture);
	const fxHits = fxRuns.filter((s) => /\$\{\{/.test(s.text)).map((s) => s.line).join(",");
	ok(fxRuns.length === 3 && fxHits === "5,13",
		`§7 the run: scanner flags an expression in a block script and in a one-liner, and nothing in env:/with:/if: (got ${fxRuns.length} scripts, hits at ${fxHits})`);

	// ── Every workflow and composite action. ⚠️ An expression inside a run:
	// script is pasted into the script TEXT before bash parses it: a secret with
	// a quote in it breaks the step, and a value read off the box runs as shell
	// on the runner. Secrets and step outputs reach the shell through env: only.
	const wfFiles = fs.readdirSync(path.join(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`);
	const actionFiles = fs.readdirSync(path.join(ROOT, ".github/actions"))
		.map((a) => `.github/actions/${a}/action.yml`)
		.filter((p) => fs.existsSync(path.join(ROOT, p)));
	const allFiles = [...wfFiles, ...actionFiles];
	ok(allFiles.includes(".github/workflows/backup-freshness.yml") && allFiles.includes(".github/actions/vps-deploy/action.yml") && allFiles.length >= 5,
		`§7 the workflow scan sees every workflow and action (got ${allFiles.join(", ")})`);
	for (const f of allFiles) {
		const text = read(f);
		const hits = runScripts(text).filter((s) => /\$\{\{/.test(s.text)).map((s) => s.line);
		ok(hits.length === 0, `§7 ${f}: no expression inside a run: script — pass it through env: (run: at line ${hits.join(", ")})`);
		ok(!/\bssh\s+-i\b/.test(noComments(text)), `§7 ${f}: no bare \`ssh -i\` — every connection goes through scripts/deploy/ssh-retry.sh`);
	}

	// ── backup-freshness.yml: read-only, so it must never share the deploy
	// queue or the box's deploy lock, and it reaches the box exactly the way a
	// deploy does.
	const backup = read(".github/workflows/backup-freshness.yml");
	const cb = conc(backup);
	ok(cb.group && cb.group !== cd.group && !/\$\{\{/.test(cb.group),
		`§7 backup-freshness.yml keeps its OWN literal concurrency group, never deploy.yml's (got ${cb.group}; deploy group ${cd.group})`);
	ok(cb.noCancel, "§7 backup-freshness.yml never cancels an in-progress check");
	const bRuns = runScripts(backup);
	const bNoComments = noComments(backup);
	ok(/VPS_SSH_KEY:\s*\$\{\{\s*secrets\.VPS_SSH_KEY\s*\}\}/.test(bNoComments)
		&& /VPS_SSH_KNOWN_HOSTS:\s*\$\{\{\s*secrets\.VPS_SSH_KNOWN_HOSTS\s*\}\}/.test(bNoComments)
		&& bRuns.some((s) => /^\s*bash scripts\/deploy\/ssh-setup\.sh\s*$/.test(s.text)),
		"§7 backup-freshness.yml writes its key through ssh-setup.sh, secrets in env: (the host key is pinned and an empty one is refused)");
	const sshRun = bRuns.find((s) => /scripts\/deploy\/ssh-retry\.sh/.test(s.text));
	ok(sshRun && /<\s*scripts\/deploy\/remote-backup-check\.sh/.test(sshRun.text),
		"§7 backup-freshness.yml reaches the box through ssh-retry.sh, piping remote-backup-check.sh");
	ok(!bRuns.some((s) => />\s*~\/\.ssh\//.test(s.text)), "§7 backup-freshness.yml never writes ~/.ssh itself — only ssh-setup.sh does");
	ok(/if:\s*always\(\)\s*\n\s*run:\s*shred -u ~\/\.ssh\/deploy_key/.test(bNoComments), "§7 backup-freshness.yml always shreds the deploy key");
	const remoteCheck = noComments(read("scripts/deploy/remote-backup-check.sh"));
	ok(!/\bflock\b|deploy-lock|DEPLOY_LOCK_DIR|logisx-deploy/.test(remoteCheck),
		"§7 remote-backup-check.sh never takes the deploy lock (a read-only check must not block or queue a deploy)");
	ok(!/\bpm2\b|\bgit\b|(^|[;&|(]\s*|\s)(rm|mv|cp|truncate|tee)\s/m.test(remoteCheck),
		"§7 remote-backup-check.sh stays read-only: no pm2, git, rm, mv, cp, truncate or tee");

	// ── remote-backup-check.sh reads backup.sh's failures, all of them. backup.sh
	// writes two shapes — "[backup] backup FAILED with exit code N" when the
	// snapshot fails, "[backup] FAILED: <why>" when it cannot start — and the check
	// used to grep for the first only, so a run that never started read as fine.
	// The pattern is taken out of the script and run through real `grep -E`.
	const failedRe = (remoteCheck.match(/^FAILED_RE='([^']+)'$/m) || [])[1];
	ok(!!failedRe, "§7 remote-backup-check.sh names its failure pattern once (FAILED_RE)");
	const grepCount = (line) => {
		const r = require("child_process").spawnSync("grep", ["-cE", failedRe || "^$"], { input: `${line}\n`, encoding: "utf8" });
		return Number(String(r.stdout).trim());
	};
	ok(grepCount("[backup] backup FAILED with exit code 1") === 1, "§7 the check sees '[backup] backup FAILED with exit code N'");
	ok(grepCount("[backup] FAILED: no node on this box can load better-sqlite3") === 1, "§7 the check sees '[backup] FAILED: <why>' (a run that never started)");
	ok(grepCount("[backup] completed: Tue Sep 23 02:03:11 UTC 2026") === 0, "§7 …and not a completed run");
	ok(!/\\\]/.test(failedRe || ""), "§7 the pattern spells ']' as []], never \\] (newer GNU grep warns on a stray backslash)");
	// The failure COUNT is per run: a failed snapshot writes backup-db.js's
	// "[backup] FAILED: <why>" AND backup.sh's "backup FAILED with exit code N" into
	// the same run, and counting lines made one bad night read as two.
	const countProg = (remoteCheck.match(/^COUNT_FAILED_RUNS='([^']+)'$/m) || [])[1];
	ok(!!countProg && countProg.includes(failedRe || "\u0000"), "§7 the failed-run count groups by run header and uses the same failure pattern");
	ok(/^FAILS=\$\(awk "\$COUNT_FAILED_RUNS" backup\.log/m.test(remoteCheck), "§7 BACKUP_TOTAL_FAILURES comes from that per-run count");
	const runLog = [
		"[backup] ---- 2026-09-20 02:00:00 UTC ----", "[backup] completed: ok",
		"[backup] ---- 2026-09-21 02:00:00 UTC ----", "[backup] FAILED: integrity_check failed", "[backup] backup FAILED with exit code 1",
		"[backup] ---- 2026-09-22 02:00:00 UTC ----", "[backup] completed: ok",
		"[backup] ---- 2026-09-23 02:00:00 UTC ----", "[backup] FAILED: no node on this box can load better-sqlite3", "[backup]   tried pm2 exec_interpreter",
		"[backup] ---- 2026-09-24 02:00:00 UTC ----", "[backup] backup FAILED with exit code 3",
	].join("\n") + "\n";
	const awkCount = (prog, input) => Number(String(require("child_process").spawnSync("awk", [prog || "BEGIN{print -1}"], { input, encoding: "utf8" }).stdout).trim());
	// Each shape has a night to itself (09-23, 09-24), so missing either one shows.
	ok(awkCount(countProg, runLog) === 3, `§7 three bad nights count 3, not the 4 failure lines they wrote (got ${awkCount(countProg, runLog)})`);
	ok(awkCount(countProg, "[backup] ---- 2026-09-23 02:00:00 UTC ----\n[backup] completed: ok\n") === 0, "§7 …and a clean log counts 0");
	// Age is floored to whole hours. At the 04:00 check a missed 02:00 run is ~25h59m
	// old (25) and the newest healthy one at most ~24 h (a check just before 02:00).
	const maxAge = Number((remoteCheck.match(/^MAX_AGE_H=\$\{MAX_AGE_H:-(\d+)\}[ \t]*$/m) || [])[1]);
	ok(maxAge <= Math.floor((25 * 3600 + 59 * 60) / 3600),
		`§7 a missed night is stale at the very next 04:00 check (limit ${maxAge} h must be ≤ 25)`);
	ok(maxAge > Math.floor((23 * 3600 + 59 * 60) / 3600) && maxAge >= 24,
		`§7 …while a snapshot from last night never is (limit ${maxAge} h must be ≥ 24)`);
}

function mutants() {
	// The shebang is legal only at the top of a FILE, not inside a function body.
	const src = fs.readFileSync(GATE_PATH, "utf8").replace(/^#!.*\n/, "\n");
	const load = (code) => {
		const m = { exports: {} };
		new Function("module", "exports", "require", code)(m, m.exports, require);
		return m.exports;
	};
	const cases = [
		["heals on a staging failure", src.replace('case "failed":\n\t\t\treturn "behind-staging-failed";', 'case "failed":\n\t\t\treturn "behind-healable";'), checkRefine],
		["unknown states heal", src.replace(': "alarm";\n}', ': "heal";\n}'), checkActionTable],
		["trusts runs for other commits", src.replace('(!sha || r.head_sha === sha)', "true"), checkVerdicts],
		["any conclusion passes", src.replace('if (staging.conclusion === "success") {', "if (true) {"), checkVerdicts],
		["oldest run wins", src.replace(".sort((a, b) => Number(b.id || 0) - Number(a.id || 0));\n\tif (candidates", ".sort((a, b) => Number(a.id || 0) - Number(b.id || 0));\n\tif (candidates"), checkVerdicts],
	];
	for (const [name, code, suite] of cases) {
		ok(code !== src, `§8 mutant '${name}' must actually differ from the source (update the mutant if the code moved)`);
		const results = suite(load(code), "[mutant] ");
		ok(results.some(([c]) => !c), `§8 mutant '${name}' must be caught by the assertions above`);
	}
}

function report() {
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
}
