#!/usr/bin/env node
/**
 * Locks the automatic production gate (deploy.yml) and the local pre-push check.
 *
 * Production deploys with no reviewer once deploy.yml's staging job passed, and
 * that job is the whole gate: the deploy, then the staging smoke, then CI on
 * main for the same commit. Each property below is a way the gate could
 * quietly stop gating:
 *
 *   §1 scripts/deploy/staging-smoke.sh against a local stub of the app: every
 *      check passes on a healthy app and fails on its own fault (no app JSON,
 *      a missing bundle the SPA fallback answers with index.html and a 200, an
 *      API that answers without a session, a handshake that admits a foreign
 *      Origin); only no answer or a 5xx is retried, 3 tries; the deadline holds
 *   §2 scripts/deploy/wait-for-ci.sh against a stub `gh`: only `success`
 *      passes; any other conclusion fails at once; queued, running or absent
 *      is polled until the deadline, then fails; a 4xx read fails at once and
 *      a 5xx read is retried. Its jq filter runs through real jq.
 *   §3 .githooks/pre-push against stub npm, fnm and node: it runs
 *      `npm run check` and blocks on failure, skips a deletion-only push,
 *      switches Node through fnm when present, and never passes git's
 *      repository variables on to the runners
 *   §4 source pins: the smoke and the CI wait are push-only steps of the
 *      staging job, after its deploy; production needs staging and keeps its
 *      environment; every job in every workflow has a timeout; ci.yml keeps its
 *      push trigger, the check name the wait reads, and one group per pushed
 *      commit; the unit runners run once in CI; package.json's check and ci
 *   §5 mutants: a smoke that trusts any 200 for a bundle, a CI wait that takes
 *      any conclusion, a hook that ignores npm's exit code, and a staging job
 *      without its smoke must each be caught above
 *
 * Hermetic: a 127.0.0.1 server on port 0, mkdtemp directories, stubs on PATH;
 * no network, no secrets.
 * Run: node scripts/test-release-gate.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SMOKE = path.join(ROOT, "scripts/deploy/staging-smoke.sh");
const WAIT = path.join(ROOT, "scripts/deploy/wait-for-ci.sh");
const HOOK = path.join(ROOT, ".githooks/pre-push");
const SHA = "c".repeat(40);

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));
let tmpN = 0;
const tmpDir = (name) => { const d = path.join(TMP, `${name}-${++tmpN}`); fs.mkdirSync(d, { recursive: true }); return d; };

// Comment-stripped text. A `#` starts a comment at the start of a line or
// after whitespace, which is how YAML and bash both read it.
const noComments = (s) => s.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");

// bash, asynchronously: the stub server answers on this same event loop.
function bashAsync(script, env, timeoutMs = 30000) {
	return new Promise((resolve) => {
		const child = spawn("bash", [script], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (out += c));
		const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
	});
}

// ─────────────────────────────────────────── §1 the staging smoke
// A stub of the app as staging serves it. `faults` breaks one thing at a time.
const BUNDLE = ["/assets/index-a1.js", "/assets/vendor-b2.js", "/assets/index-c3.css"];
function stubApp(faults = {}) {
	const hits = {};
	const server = http.createServer((req, res) => {
		const u = new URL(req.url, "http://x");
		hits[u.pathname] = (hits[u.pathname] || 0) + 1;
		const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
		const html = faults.html !== undefined ? faults.html
			: `<!doctype html><html><head><script type="module" src="${BUNDLE[0]}"></script><link rel="modulepreload" href="${BUNDLE[1]}"><link rel="stylesheet" href="${BUNDLE[2]}"></head><body><div id="app"></div></body></html>`;
		const spa = () => send(200, "text/html; charset=UTF-8", html);
		if (faults.hang) return;
		if (u.pathname === "/api/config/maintenance") {
			const seq = faults.maintenance || [];
			const step = seq[Math.min(hits[u.pathname] - 1, seq.length - 1)];
			if (step === "html") return send(200, "text/html", "<html>Welcome to nginx!</html>");
			if (step) return send(step, "text/plain", "no");
			return send(200, "application/json; charset=utf-8", '{"enabled":false,"title":"x"}');
		}
		if (u.pathname === "/login" || u.pathname === "/") {
			if (faults.login) return send(faults.login, "text/plain", "no");
			if (faults.loginType) return send(200, faults.loginType, "{}");
			return spa();
		}
		if (u.pathname.startsWith("/assets/")) {
			if (faults.missing === u.pathname) return spa();
			if (faults.assetCode && faults.assetCode[0] === u.pathname) return send(faults.assetCode[1], "text/plain", "no");
			if (faults.empty === u.pathname) return send(200, "application/javascript; charset=UTF-8", "");
			if (u.pathname.endsWith(".css")) return send(200, "text/css; charset=UTF-8", "body{}");
			return send(200, "application/javascript; charset=UTF-8", "export {};");
		}
		if (u.pathname === "/api/tabs") return send(faults.tabs || 401, "application/json", '{"error":"Not authenticated"}');
		if (u.pathname === "/socket.io/") {
			const own = req.headers.origin === `http://127.0.0.1:${server.address().port}`;
			if (own) return send(faults.ownOrigin || 200, "text/plain", "0{}");
			return send(faults.foreignOrigin || 403, "application/json", "{}");
		}
		return spa();
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

async function runSmoke(script, faults, { deadline = 20, base } = {}) {
	const app = await stubApp(faults);
	try {
		const t0 = Date.now();
		const r = await bashAsync(script, { BASE: base || app.base, SMOKE_RETRY_PAUSE_S: "0", SMOKE_DEADLINE_S: String(deadline) });
		return { ...r, hits: app.hits, ms: Date.now() - t0 };
	} finally {
		app.server.close();
	}
}

// Every case has its own stub on its own port, so they all run at once.
async function checkSmoke(script, tag = "") {
	const r = [];
	const refusedBase = await (async () => {
		const probe = http.createServer();
		await new Promise((res) => probe.listen(0, "127.0.0.1", res));
		const port = probe.address().port;
		await new Promise((res) => probe.close(res));
		return `http://127.0.0.1:${port}`;
	})();
	const fails = [
		["no app JSON behind a 200 (an nginx page)", { maintenance: ["html"] }, /without the app's JSON/],
		["the health endpoint answers 404", { maintenance: [404] }, /gave 404 \(want 200\)/],
		["the login page answers 502 every time", { login: 502 }, /login page: \/login gave 502/],
		["the login page is not HTML", { loginType: "application/json" }, /want text\/html/],
		["index.html names no bundle", { html: '<html><body><div id="app"></div></body></html>' }, /names no \/assets bundle/],
		["the page is not the app's index.html", { html: `<html><script src="${BUNDLE[0]}"></script></html>` }, /no #app mount point/],
		["a bundle file is missing (the SPA fallback answers 200 with index.html)", { missing: BUNDLE[1] }, /not its own file/],
		["a bundle file answers 404", { assetCode: [BUNDLE[2], 404] }, /index-c3\.css gave 404/],
		["a bundle file is empty", { empty: BUNDLE[0] }, /is empty/],
		["the API answers without a session", { tabs: 200 }, /gave 200 \(want 401\)/],
		["the API answers 403 instead of 401", { tabs: 403 }, /gave 403 \(want 401\)/],
		["the handshake refuses the app's own Origin", { ownOrigin: 403 }, /own Origin gave 403/],
		["the handshake admits a foreign Origin", { foreignOrigin: 200 }, /foreign Origin gave 200/],
	];
	const [good, flaky, down, definite, refused, hung, badBase, ...failed] = await Promise.all([
		runSmoke(script, {}),
		runSmoke(script, { maintenance: [503, 502, 0] }),
		runSmoke(script, { maintenance: [503] }),
		runSmoke(script, { maintenance: [404] }),
		runSmoke(script, {}, { base: refusedBase }),
		runSmoke(script, { hang: true }, { deadline: 3 }),
		runSmoke(script, {}, { base: "https://staging.example/login" }),
		...fails.map(([, faults]) => runSmoke(script, faults)),
	]);
	r.push([good.code === 0 && /staging smoke OK/.test(good.out) && /3 bundle files 200/.test(good.out), `${tag}§1 a healthy app passes every check (exit ${good.code}): ${good.out.slice(-300)}`]);
	r.push([BUNDLE.every((a) => good.hits[a] === 1) && good.hits["/api/tabs"] === 1 && good.hits["/socket.io/"] === 2,
		`${tag}§1 …and asks each bundle file, the API and both handshakes exactly once (got ${JSON.stringify(good.hits)})`]);
	r.push([/::error/.test(good.out) === false, `${tag}§1 …with no error annotation`]);
	fails.forEach(([name, , re], i) => {
		const x = failed[i];
		r.push([x.code === 1 && re.test(x.out) && /::error title=Staging smoke failed::/.test(x.out), `${tag}§1 fails when ${name} (exit ${x.code}): ${x.out.slice(-240)}`]);
	});

	// Retries: no answer or a 5xx only, 3 tries in all.
	r.push([flaky.code === 0 && flaky.hits["/api/config/maintenance"] === 3, `${tag}§1 two 5xx then a 200 passes on the third try (exit ${flaky.code}, ${flaky.hits["/api/config/maintenance"]} tries)`]);
	r.push([down.code === 1 && down.hits["/api/config/maintenance"] === 3, `${tag}§1 a 5xx every time fails after exactly 3 tries (exit ${down.code}, ${down.hits["/api/config/maintenance"]} tries)`]);
	r.push([definite.hits["/api/config/maintenance"] === 1, `${tag}§1 a definite wrong answer is never retried (${definite.hits["/api/config/maintenance"]} tries)`]);
	r.push([refused.code === 1 && /gave 000/.test(refused.out) && (refused.out.match(/retrying/g) || []).length === 2,
		`${tag}§1 no answer at all is retried twice, then fails as 000 (exit ${refused.code}): ${refused.out.slice(-200)}`]);
	r.push([hung.code === 1 && /out of time/.test(hung.out) && hung.ms < 9000, `${tag}§1 an app that never answers fails on the deadline, not the step timeout (exit ${hung.code}, ${hung.ms} ms)`]);
	r.push([badBase.code === 1 && /bare origin/.test(badBase.out), `${tag}§1 BASE must be a bare origin (exit ${badBase.code})`]);
	return r;
}

// ─────────────────────────────────────────── §2 the CI wait
// The stub answers each call with the next line of $STUB_ANSWERS,
// "<exit code>|<output>", and repeats the last line once they run out.
function ghStub() {
	const dir = tmpDir("gh-stub");
	fs.writeFileSync(path.join(dir, "gh"), [
		"#!/bin/bash",
		"printf '%s\\n' \"$*\" >> \"$STUB_LOG\"",
		"n=$(( $(cat \"$STUB_COUNT\" 2>/dev/null || echo 0) + 1 ))",
		"echo \"$n\" > \"$STUB_COUNT\"",
		"line=$(sed -n \"${n}p\" \"$STUB_ANSWERS\")",
		"[ -n \"$line\" ] || line=$(tail -1 \"$STUB_ANSWERS\")",
		"code=${line%%|*}",
		"out=${line#*|}",
		"if [ \"$code\" = 0 ]; then printf '%s\\n' \"$out\"; else printf '%s\\n' \"$out\" >&2; fi",
		"exit \"$code\"",
		"",
	].join("\n"), { mode: 0o755 });
	return dir;
}
const GH = ghStub();

function runWait(script, answers, { sha = SHA, repo = "o/r", wait = "5", poll = "0" } = {}) {
	const dir = tmpDir("wait");
	fs.writeFileSync(path.join(dir, "answers"), `${answers.join("\n")}\n`);
	const r = spawnSync("bash", [script], {
		encoding: "utf8",
		timeout: 30000,
		env: {
			PATH: `${GH}:${process.env.PATH}`,
			GH_TOKEN: "stub-token",
			REPO: repo,
			SHA: sha,
			CI_WAIT_S: wait,
			CI_POLL_S: poll,
			STUB_LOG: path.join(dir, "log"),
			STUB_COUNT: path.join(dir, "count"),
			STUB_ANSWERS: path.join(dir, "answers"),
		},
	});
	const log = path.join(dir, "log");
	const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls };
}

const URL1 = "https://github.example/o/r/actions/runs/1/job/2";
function checkWait(script, tag = "") {
	const r = [];
	const passed = runWait(script, [`0|completed success ${URL1}`]);
	r.push([passed.code === 0 && passed.calls.length === 1, `${tag}§2 a successful check run passes on the first read (exit ${passed.code}, ${passed.calls.length} reads)`]);
	r.push([passed.calls[0] && passed.calls[0].startsWith(`api -X GET repos/o/r/commits/${SHA}/check-runs -f check_name=check · unit · build -f filter=latest --jq `),
		`${tag}§2 it reads ci.yml's check by name, the newest run, for exactly this commit (got ${passed.calls[0]})`]);
	const later = runWait(script, ["0|none", "0|queued none x", `0|in_progress none ${URL1}`, `0|completed success ${URL1}`]);
	r.push([later.code === 0 && later.calls.length === 4, `${tag}§2 absent, queued and running are polled until success (exit ${later.code}, ${later.calls.length} reads)`]);
	for (const c of ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale", "none"]) {
		const x = runWait(script, [`0|completed ${c} ${URL1}`, `0|completed success ${URL1}`]);
		r.push([x.code === 1 && x.calls.length === 1 && /CI on main failed/.test(x.out) && /Production not deployed/.test(x.out),
			`${tag}§2 a check run concluding '${c}' fails at once, never waits for a better answer (exit ${x.code}, ${x.calls.length} reads)`]);
	}
	const never = runWait(script, [`0|in_progress none ${URL1}`], { wait: "2", poll: "1" });
	r.push([never.code === 1 && /gave no verdict/.test(never.out) && never.calls.length >= 2 && never.calls.length <= 4,
		`${tag}§2 no verdict within CI_WAIT_S fails (exit ${never.code}, ${never.calls.length} reads): ${never.out.slice(-200)}`]);
	const refused = runWait(script, ["1|gh: Resource not accessible by integration (HTTP 403)", `0|completed success ${URL1}`]);
	r.push([refused.code === 1 && refused.calls.length === 1 && /refused the check-run read/.test(refused.out), `${tag}§2 a 4xx read fails at once (exit ${refused.code}, ${refused.calls.length} reads)`]);
	const blip = runWait(script, ["1|gh: Bad Gateway (HTTP 502)", "1|gh: rate limited (HTTP 429)", "1|dial tcp: i/o timeout", `0|completed success ${URL1}`]);
	r.push([blip.code === 0 && blip.calls.length === 4, `${tag}§2 a 5xx, a 429 or a transport failure is retried (exit ${blip.code}, ${blip.calls.length} reads)`]);
	const garbled = runWait(script, ["0|", "0|surprise", `0|completed success ${URL1}`]);
	r.push([garbled.code === 0 && garbled.calls.length === 3, `${tag}§2 an unreadable answer is never a pass; it is read again (exit ${garbled.code})`]);
	for (const [name, opts] of [["a short SHA", { sha: "abc123" }], ["an empty SHA", { sha: "" }], ["a repo with a path", { repo: "o/r/../x" }]]) {
		const x = runWait(script, [`0|completed success ${URL1}`], opts);
		r.push([x.code === 1 && x.calls.length === 0, `${tag}§2 ${name} fails before any read (exit ${x.code}, ${x.calls.length} reads)`]);
	}
	return r;
}

// The --jq filter itself, through real jq (gh's built-in jq takes the same
// language): only GitHub Actions' check runs count, and the newest decides.
function checkJq() {
	const src = fs.readFileSync(WAIT, "utf8");
	const m = /^JQ='([^']+)'$/m.exec(src);
	ok(!!m, "§2 wait-for-ci.sh names its jq filter once (JQ='…')");
	if (!m) return;
	const jq = (body) => spawnSync("jq", ["-r", m[1]], { input: JSON.stringify(body), encoding: "utf8" });
	const probe = jq({ check_runs: [] });
	ok(probe.status === 0, `§2 jq runs the filter (install jq if this fails: ${probe.stderr || probe.error})`);
	const runAt = (t, status, conclusion, slug = "github-actions") => ({ started_at: t, status, conclusion, html_url: `u-${t}`, app: { slug } });
	const cases = [
		[{ check_runs: [] }, "none"],
		[{ check_runs: [runAt("2026-10-08T01:00:00Z", "completed", "success", "some-other-app")] }, "none"],
		[{ check_runs: [runAt("2026-10-08T01:00:00Z", "completed", "failure"), runAt("2026-10-08T02:00:00Z", "completed", "success")] }, "completed success u-2026-10-08T02:00:00Z"],
		[{ check_runs: [runAt("2026-10-08T02:00:00Z", "completed", "failure"), runAt("2026-10-08T01:00:00Z", "completed", "success")] }, "completed failure u-2026-10-08T02:00:00Z"],
		[{ check_runs: [runAt("2026-10-08T03:00:00Z", "in_progress", null)] }, "in_progress none u-2026-10-08T03:00:00Z"],
	];
	for (const [body, want] of cases) {
		const got = jq(body).stdout.trim();
		ok(got === want, `§2 the jq filter turns ${JSON.stringify(body.check_runs.map((c) => [c.app.slug, c.status, c.conclusion]))} into '${want}' (got '${got}')`);
	}
}

// ─────────────────────────────────────────── §3 the pre-push hook
function hookFixture(hookText, { fnm = false, nodeVersion = "v22.23.2" } = {}) {
	const repo = tmpDir("hook-repo");
	fs.mkdirSync(path.join(repo, ".githooks"));
	fs.writeFileSync(path.join(repo, ".githooks/pre-push"), hookText, { mode: 0o755 });
	fs.writeFileSync(path.join(repo, ".nvmrc"), "22.23.2\n");
	const bin = tmpDir("hook-bin");
	const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	stub("npm", 'printf "npm %s|cwd=%s|GIT_DIR=%s|GIT_WORK_TREE=%s|GIT_INDEX_FILE=%s\\n" "$*" "$PWD" "${GIT_DIR-}" "${GIT_WORK_TREE-}" "${GIT_INDEX_FILE-}" >> "$STUB_LOG"\nexit "${STUB_NPM_EXIT:-0}"');
	stub("node", `echo ${nodeVersion}`);
	if (fnm) stub("fnm", 'printf "fnm %s\\n" "$*" >> "$STUB_LOG"\n[ "$1" = env ] && echo "export STUB_FNM_ENV=1"\nexit 0');
	return { repo, bin };
}

function runHook(hookText, { input, npmExit = 0, fnm = false, nodeVersion } = {}) {
	const f = hookFixture(hookText, { fnm, nodeVersion });
	const log = path.join(f.repo, "..", `${path.basename(f.repo)}.log`);
	const r = spawnSync("bash", [path.join(f.repo, ".githooks/pre-push"), "origin", "git@github.com:o/r.git"], {
		encoding: "utf8",
		timeout: 20000,
		input: input === undefined ? `refs/heads/x ${SHA} refs/heads/x ${"d".repeat(40)}\n` : input,
		cwd: os.tmpdir(),
		env: {
			PATH: `${f.bin}:/usr/bin:/bin`,
			STUB_LOG: log,
			STUB_NPM_EXIT: String(npmExit),
			GIT_DIR: "/somewhere/else/.git",
			GIT_WORK_TREE: "/somewhere/else",
			GIT_INDEX_FILE: "/somewhere/else/.git/index",
		},
	});
	const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls, repo: f.repo };
}

function checkHook(hookText, tag = "") {
	const r = [];
	const good = runHook(hookText);
	const npm = good.calls.filter((c) => c.startsWith("npm "));
	r.push([good.code === 0 && npm.length === 1 && npm[0].startsWith("npm run check|"), `${tag}§3 a push runs npm run check once and passes when it passes (exit ${good.code}, calls ${JSON.stringify(good.calls)})`]);
	const cwd = npm[0] ? npm[0].split("|").find((x) => x.startsWith("cwd=")).slice(4) : "";
	r.push([!!cwd && fs.realpathSync(cwd) === fs.realpathSync(good.repo), `${tag}§3 …from the repo root, wherever git started the hook (got ${npm[0]})`]);
	r.push([npm[0] && /\|GIT_DIR=\|GIT_WORK_TREE=\|GIT_INDEX_FILE=$/.test(npm[0]), `${tag}§3 …with git's repository variables unset, so the deploy runners' own git sandboxes stay theirs (got ${npm[0]})`]);
	const bad = runHook(hookText, { npmExit: 1 });
	r.push([bad.code === 1 && /push was blocked/.test(bad.out), `${tag}§3 a failing check blocks the push (exit ${bad.code})`]);
	const deletes = runHook(hookText, { input: `(delete) ${"0".repeat(40)} refs/heads/old ${SHA}\n` });
	r.push([deletes.code === 0 && deletes.calls.length === 0, `${tag}§3 a push that only deletes a branch runs nothing (exit ${deletes.code}, calls ${deletes.calls.length})`]);
	const mixed = runHook(hookText, { input: `(delete) ${"0".repeat(40)} refs/heads/old ${SHA}\nrefs/heads/x ${SHA} refs/heads/x ${"0".repeat(40)}\n` });
	r.push([mixed.calls.some((c) => c.startsWith("npm run check")), `${tag}§3 a deletion beside a real update still runs the check`]);
	const withFnm = runHook(hookText, { fnm: true });
	r.push([withFnm.calls.includes("fnm env --shell bash") && withFnm.calls.includes("fnm use") && withFnm.calls.indexOf("fnm use") < withFnm.calls.findIndex((c) => c.startsWith("npm ")),
		`${tag}§3 with fnm installed it switches to .nvmrc's Node before the check (calls ${JSON.stringify(withFnm.calls)})`]);
	r.push([!good.calls.some((c) => c.startsWith("fnm")), `${tag}§3 without fnm it uses the Node on PATH`]);
	const oldNode = runHook(hookText, { nodeVersion: "v20.20.1" });
	r.push([oldNode.code === 0 && /\.nvmrc wants 22\.23\.2/.test(oldNode.out), `${tag}§3 a Node other than .nvmrc's is named before the check runs (exit ${oldNode.code})`]);
	return r;
}

// ─────────────────────────────────────────── §4 source pins
// Each job under `jobs:` as { id: text }, by indentation.
function jobBlocks(yaml) {
	const lines = yaml.split("\n");
	const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	const out = {};
	let id = null;
	for (let i = start + 1; start >= 0 && i < lines.length; i++) {
		const l = lines[i];
		if (/^[^\s#]/.test(l)) break;
		const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
		if (m) { id = m[1]; out[id] = ""; continue; }
		if (id) out[id] += `${l}\n`;
	}
	return out;
}
// Each step of a job's text, split on the `- ` items under `steps:`.
function stepBlocks(jobText) {
	const out = [];
	for (const l of noComments(jobText).split("\n")) {
		if (/^ {6}- /.test(l)) out.push("");
		if (out.length) out[out.length - 1] += `${l}\n`;
	}
	return out;
}
const stepKey = (step, key) => { const m = new RegExp(`^ {6}(?:- )?\\s*${key}:\\s*(.*?)\\s*$`, "m").exec(step); return m ? m[1] : null; };
const stepEnv = (step, key) => { const m = new RegExp(`^ {10}${key}:\\s*(.*?)\\s*$`, "m").exec(step); return m ? m[1] : null; };

function checkDeployGate(deployText, tag = "") {
	const r = [];
	const jobs = jobBlocks(deployText);
	const staging = jobs.staging || "";
	const steps = stepBlocks(staging);
	const iDeploy = steps.findIndex((s) => /uses:\s*\.\/\.github\/actions\/vps-deploy\s*$/m.test(s));
	const iSmoke = steps.findIndex((s) => /run:\s*bash scripts\/deploy\/staging-smoke\.sh\s*$/m.test(s));
	const iWait = steps.findIndex((s) => /run:\s*bash scripts\/deploy\/wait-for-ci\.sh\s*$/m.test(s));
	r.push([iDeploy >= 0 && iSmoke === iDeploy + 1 && iWait === iSmoke + 1,
		`${tag}§4 the staging job runs its deploy, then the staging smoke, then the CI wait, as its last three steps (deploy ${iDeploy}, smoke ${iSmoke}, wait ${iWait} of ${steps.length})`]);
	r.push([iWait === steps.length - 1, `${tag}§4 nothing follows the CI wait in the staging job`]);
	const smoke = steps[iSmoke] || "";
	const wait = steps[iWait] || "";
	for (const [name, s] of [["smoke", smoke], ["CI wait", wait]]) {
		r.push([stepKey(s, "if") === "github.event_name == 'push'", `${tag}§4 the ${name} runs on every push, and on nothing that could skip it (if: ${stepKey(s, "if")})`]);
		r.push([!/continue-on-error/.test(s), `${tag}§4 a failed ${name} fails the staging job (no continue-on-error)`]);
	}
	r.push([stepEnv(smoke, "BASE") === "https://staging-app.logisx.com", `${tag}§4 the smoke checks staging's public origin (BASE: ${stepEnv(smoke, "BASE")})`]);
	r.push([Number(stepKey(smoke, "timeout-minutes")) > 0 && Number(stepKey(smoke, "timeout-minutes")) <= 2, `${tag}§4 the smoke step is held under 2 minutes (timeout-minutes: ${stepKey(smoke, "timeout-minutes")})`]);
	r.push([stepEnv(wait, "SHA") === "${{ github.sha }}" && stepEnv(wait, "REPO") === "${{ github.repository }}" && stepEnv(wait, "GH_TOKEN") === "${{ github.token }}",
		`${tag}§4 the CI wait reads this run's own commit, through env:`]);
	const waitS = Number(String(stepEnv(wait, "CI_WAIT_S") || "").replace(/"/g, ""));
	r.push([waitS > 0 && waitS <= 720 && Number(stepKey(wait, "timeout-minutes")) * 60 > waitS, `${tag}§4 the CI wait is bounded at 12 min, inside its step timeout (CI_WAIT_S ${waitS}, timeout-minutes ${stepKey(wait, "timeout-minutes")})`]);
	const perms = /\n {4}permissions:\n((?: {6}.*\n)+)/.exec(`\n${noComments(staging)}`);
	const permSet = perms ? perms[1].split("\n").map((l) => l.trim()).filter(Boolean).sort().join(",") : "";
	r.push([permSet === "checks: read,contents: read", `${tag}§4 the staging job's token reads the repo and check runs, nothing more (got ${permSet})`]);
	const prod = noComments(jobs.production || "");
	r.push([/^ {4}needs:\s*\[\s*staging\s*\]\s*$/m.test(prod), `${tag}§4 production needs the staging job, which now includes the smoke and the CI wait`]);
	r.push([/^ {4}environment:\s*\n {6}name:\s*production\s*$/m.test(prod), `${tag}§4 production keeps environment: production, so its deploys stay recorded`]);
	return r;
}

function checkTimeouts() {
	const dir = path.join(ROOT, ".github/workflows");
	for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
		const jobs = jobBlocks(fs.readFileSync(path.join(dir, f), "utf8"));
		ok(Object.keys(jobs).length > 0, `§4 ${f} has jobs`);
		for (const [id, text] of Object.entries(jobs)) {
			const m = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(noComments(text));
			ok(!!m && Number(m[1]) > 0 && Number(m[1]) <= 30, `§4 ${f} job '${id}' has its own timeout-minutes (1–30), so nothing it holds is held forever (got ${m && m[1]})`);
		}
	}
}

function checkCi() {
	const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
	const c = noComments(ci);
	ok(/^ {2}push:\s*\n {4}branches:\s*\[\s*main\s*\]\s*$/m.test(c), "§4 ci.yml still runs on every push to main: production waits for that run");
	const name = (/^ {4}name:\s*(.+?)\s*$/m.exec(jobBlocks(ci).verify || "") || [])[1];
	const waitDefault = (/^CHECK_NAME=\$\{CHECK_NAME:-(.+)\}$/m.exec(fs.readFileSync(WAIT, "utf8")) || [])[1];
	ok(name === "check · unit · build" && waitDefault === name, `§4 the CI wait reads the check ci.yml's job reports (job '${name}', wait '${waitDefault}')`);
	const group = (/^concurrency:\s*\n {2}group:\s*(.+?)\s*$/m.exec(c) || [])[1];
	ok(group === "ci-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
		`§4 ci.yml keys a push run's group on its commit, so a later merge never cancels the run production waits for (got ${group})`);
	ok((c.match(/run:\s*npm run test:unit\s*$/gm) || []).length === 1 && !/run:\s*npm run (check|ci)\b/.test(c), "§4 CI runs the unit runners exactly once (test:unit, never check or ci, which include them)");
	ok(/run:\s*npm run lint\s*$/m.test(c), "§4 CI runs the syntax check (npm run lint)");

	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
	ok(pkg.check === "npm run lint && npm run test:unit", `§4 npm run check is the syntax check plus every unit runner (got ${pkg.check})`);
	ok(pkg.ci === "npm run check && npm run build:client", `§4 npm run ci is the full CI gate: check plus the client build (got ${pkg.ci})`);
	ok(/^ls server\.js lib\/\*\.js scripts\/\*\.js \| xargs -n 1 -P \d+ node --check --$/.test(pkg.lint || ""), `§4 npm run lint is node --check over server.js, lib/*.js and scripts/*.js (got ${pkg.lint})`);
	const harness = fs.readFileSync(path.join(ROOT, "scripts/run-unit-tests.js"), "utf8");
	ok(/Number\(process\.env\.UNIT_TEST_CONCURRENCY\) \|\| 4\)/.test(harness), "§4 run-unit-tests.js runs 4 at a time by default");
	ok(/const alone = toRun\.filter\(\(f\) => TIMING_SENSITIVE\.has\(f\)\)/.test(harness) && /queue = alone;\n\tawait worker\(\);/.test(harness),
		"§4 …and runs the timing-sensitive runners alone, after the pool");
	const mode = fs.statSync(HOOK).mode;
	ok((mode & 0o111) === 0o111, `§4 .githooks/pre-push is executable (mode ${(mode & 0o777).toString(8)})`);
}

// ─────────────────────────────────────────── §5 mutants
function mut(file, from, to) {
	const src = fs.readFileSync(file, "utf8");
	const out = src.split(from).join(to);
	ok(out !== src, `§5 mutant of ${path.basename(file)} must actually differ (update it if the code moved): ${from.slice(0, 60)}`);
	const p = path.join(tmpDir("mutant"), path.basename(file));
	fs.writeFileSync(p, out, { mode: 0o755 });
	return { p, text: out };
}

async function smokeMutants() {
	const m1 = mut(SMOKE, '[[ "$CTYPE" =~ $want ]] ||', "true ||");
	const m2 = mut(SMOKE, "000|5??|\"\")", "000|5??|4??|\"\")");
	const [r1, r2] = await Promise.all([checkSmoke(m1.p, "[mutant] "), checkSmoke(m2.p, "[mutant] ")]);
	ok(r1.some(([c]) => !c), "§5 mutant 'any 200 is a bundle file' must be caught by §1");
	ok(r2.some(([c]) => !c), "§5 mutant 'a 4xx is retried' must be caught by §1");
}

function mutants() {
	const m3 = mut(WAIT, '"completed success")', "completed\\ *)");
	ok(checkWait(m3.p, "[mutant] ").some(([c]) => !c), "§5 mutant 'any conclusion passes' must be caught by §2");
	const m4 = mut(HOOK, "if npm run check; then", "if npm run check || true; then");
	ok(checkHook(m4.text, "[mutant] ").some(([c]) => !c), "§5 mutant 'the hook ignores the check's exit code' must be caught by §3");
	const m5 = mut(HOOK, "unset GIT_DIR", "unset GIT_NOTHING");
	ok(checkHook(m5.text, "[mutant] ").some(([c]) => !c), "§5 mutant 'GIT_DIR reaches the runners' must be caught by §3");
	const deployText = fs.readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8");
	const smokeStep = /\n {6}- name: Staging smoke[^\n]*\n(?: {8}.*\n)+/.exec(deployText);
	ok(!!smokeStep, "§5 the smoke step can be found in deploy.yml");
	for (const [name, text] of [
		["the staging job without its smoke", smokeStep ? deployText.replace(smokeStep[0], "\n") : deployText],
		["the smoke allowed to fail", deployText.replace("        run: bash scripts/deploy/staging-smoke.sh\n", "        continue-on-error: true\n        run: bash scripts/deploy/staging-smoke.sh\n")],
		["the CI wait on dispatches only", deployText.replace("        if: github.event_name == 'push'\n        timeout-minutes: 13\n", "        if: github.event_name == 'workflow_dispatch'\n        timeout-minutes: 13\n")],
	]) {
		ok(text !== deployText, `§5 mutant '${name}' must actually differ from deploy.yml`);
		ok(checkDeployGate(text, "[mutant] ").some(([c]) => !c), `§5 mutant '${name}' must be caught by §4`);
	}
}

(async () => {
	// The smoke cases and their mutants run together first: their stub servers
	// live on this event loop, which the synchronous sections after them block.
	const [smoke] = await Promise.all([checkSmoke(SMOKE), smokeMutants()]);
	for (const [c, m] of smoke) ok(c, m);
	for (const [c, m] of checkWait(WAIT)) ok(c, m);
	checkJq();
	for (const [c, m] of checkHook(fs.readFileSync(HOOK, "utf8"))) ok(c, m);
	for (const [c, m] of checkDeployGate(fs.readFileSync(path.join(ROOT, ".github/workflows/deploy.yml"), "utf8"))) ok(c, m);
	checkTimeouts();
	checkCi();
	mutants();

	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
