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
 *      is polled until the deadline, then fails; a 4xx read fails at once, but
 *      a 5xx, a 429 or a rate-limited 403 is retried. Its jq filter runs
 *      through real jq: the newest check run by id decides, even one queued
 *      with no start time yet.
 *   §3 .githooks/pre-push against stub npm, fnm and node: it runs
 *      `npm run check` and blocks on failure, skips a deletion-only push,
 *      switches Node through fnm when present, and never passes git's
 *      repository variables on to the runners
 *   §4 source pins: the serves check, the smoke and the CI wait are push-only
 *      steps of the staging job, after its deploy, with nothing allowed to
 *      fail; the serves check's own script refuses a no-op that leaves a newer
 *      build serving; the CI wait outlasts CI's own timeout and takes no
 *      CHECK_NAME or poll override; production needs staging, keeps its
 *      environment, and a manual dispatch passes the dispatch gate and deploys
 *      exactly the commit it checked; every job in every workflow has a
 *      timeout; ci.yml runs on every push to main with no path filter, and a
 *      manual run can never cancel the push run (its group expression is
 *      evaluated per event); the unit runners run once in CI; package.json
 *   §5 mutants of each script, workflow and the dispatch gate, caught above
 *   §6 scripts/deploy/dispatch-gate.js against a fake GitHub API: only a
 *      commit whose push-triggered staging job passed deploys (main pinned to
 *      that commit, any other ref as its SHA); failed, missing, running or
 *      another commit's run is refused unless override, and a ref that names
 *      no commit is refused even then; the CLI end to end
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
	const limited = runWait(script, [
		"1|gh: API rate limit exceeded for installation ID 123. (HTTP 403)",
		"1|gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)",
		`0|completed success ${URL1}`,
	]);
	r.push([limited.code === 0 && limited.calls.length === 3, `${tag}§2 a 403 that names a rate limit is retried, not read as a refusal (exit ${limited.code}, ${limited.calls.length} reads)`]);
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
	// The id decides, not started_at: a re-run still queued has started_at null,
	// which would sort FIRST and let the older run's verdict stand.
	const runAt = (id, t, status, conclusion, slug = "github-actions") => ({ id, started_at: t, status, conclusion, html_url: `u-${id}`, app: { slug } });
	const cases = [
		[{ check_runs: [] }, "none"],
		[{ check_runs: [runAt(1, "2026-10-08T01:00:00Z", "completed", "success", "some-other-app")] }, "none"],
		[{ check_runs: [runAt(1, "2026-10-08T01:00:00Z", "completed", "failure"), runAt(2, "2026-10-08T02:00:00Z", "completed", "success")] }, "completed success u-2"],
		[{ check_runs: [runAt(2, "2026-10-08T02:00:00Z", "completed", "failure"), runAt(1, "2026-10-08T01:00:00Z", "completed", "success")] }, "completed failure u-2"],
		[{ check_runs: [runAt(3, "2026-10-08T03:00:00Z", "in_progress", null)] }, "in_progress none u-3"],
		[{ check_runs: [runAt(1, "2026-10-08T01:00:00Z", "completed", "success"), runAt(2, null, "queued", null)] }, "queued none u-2"],
		[{ check_runs: [runAt(2, null, "queued", null), runAt(1, "2026-10-08T01:00:00Z", "completed", "failure")] }, "queued none u-2"],
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

// The same, comments kept: a run: script as bash will see it.
function rawStepBlocks(jobText) {
	const out = [];
	for (const l of jobText.split("\n")) {
		if (/^ {6}- /.test(l)) out.push("");
		if (out.length) out[out.length - 1] += `${l}\n`;
	}
	return out;
}
// A step's `run: |` block, dedented.
function runText(stepRaw) {
	const lines = stepRaw.split("\n");
	const i = lines.findIndex((l) => /^ {8}run:\s*\|\s*$/.test(l));
	if (i < 0) return "";
	const body = [];
	for (const l of lines.slice(i + 1)) {
		if (l.trim() && !l.startsWith("          ")) break;
		body.push(l.slice(10));
	}
	return `${body.join("\n").replace(/\s+$/, "")}\n`;
}
const envKeys = (step) => {
	const m = /\n {8}env:\n((?: {10}.*\n)+)/.exec(`\n${step}`);
	return m ? m[1].split("\n").map((l) => (/^ {10}([A-Z_]+):/.exec(l) || [])[1]).filter(Boolean).sort() : [];
};
const DEPLOY_YML = path.join(ROOT, ".github/workflows/deploy.yml");
const CI_YML = path.join(ROOT, ".github/workflows/ci.yml");
const ACTION_YML = path.join(ROOT, ".github/actions/vps-deploy/action.yml");
const STAGING_IF = "github.event_name == 'push' || github.event.inputs.target == 'staging'";

function checkDeployGate(deployText, ciText, tag = "") {
	const r = [];
	const jobs = jobBlocks(deployText);
	const staging = jobs.staging || "";
	const steps = stepBlocks(staging);
	const at = (re) => steps.findIndex((s) => re.test(s));
	const iDeploy = at(/uses:\s*\.\/\.github\/actions\/vps-deploy\s*$/m);
	const iServes = at(/- name: Staging serves this run's commit\s*$/m);
	const iSmoke = at(/run:\s*bash scripts\/deploy\/staging-smoke\.sh\s*$/m);
	const iWait = at(/run:\s*bash scripts\/deploy\/wait-for-ci\.sh\s*$/m);
	r.push([iDeploy >= 0 && iServes === iDeploy + 1 && iSmoke === iServes + 1 && iWait === iSmoke + 1 && iWait === steps.length - 1,
		`${tag}§4 the staging job runs its deploy, then checks staging serves this commit, then the smoke, then the CI wait, last (deploy ${iDeploy}, serves ${iServes}, smoke ${iSmoke}, wait ${iWait} of ${steps.length})`]);
	r.push([/^ {6}- id: deploy\s*$/m.test(steps[iDeploy] || ""), `${tag}§4 the staging deploy step has id: deploy, which the serves check reads`]);
	r.push([(/^ {4}if:\s*(.+?)\s*$/m.exec(noComments(staging)) || [])[1] === STAGING_IF, `${tag}§4 the staging job's if: is exactly "${STAGING_IF}"`]);
	r.push([!/continue-on-error/.test(noComments(staging)), `${tag}§4 nothing in the staging job, job or step, has continue-on-error: any failure stops production`]);
	const serves = steps[iServes] || "";
	const smoke = steps[iSmoke] || "";
	const wait = steps[iWait] || "";
	for (const [name, s] of [["serves check", serves], ["smoke", smoke], ["CI wait", wait]]) {
		r.push([stepKey(s, "if") === "github.event_name == 'push'", `${tag}§4 the ${name} runs on every push, and on nothing that could skip it (if: ${stepKey(s, "if")})`]);
	}
	r.push([stepEnv(serves, "RESULT") === "${{ steps.deploy.outputs.result }}" && stepEnv(serves, "TO") === "${{ steps.deploy.outputs.to }}" && stepEnv(serves, "SHA") === "${{ github.sha }}",
		`${tag}§4 the serves check compares the deploy's result and commit with this run's own`]);
	r.push([stepEnv(smoke, "BASE") === "https://staging-app.logisx.com", `${tag}§4 the smoke checks staging's public origin (BASE: ${stepEnv(smoke, "BASE")})`]);
	const smokeT = Number(stepKey(smoke, "timeout-minutes"));
	r.push([smokeT > 0 && smokeT <= 2, `${tag}§4 the smoke step is held under 2 minutes (timeout-minutes: ${smokeT})`]);
	r.push([stepEnv(wait, "SHA") === "${{ github.sha }}" && stepEnv(wait, "REPO") === "${{ github.repository }}" && stepEnv(wait, "GH_TOKEN") === "${{ github.token }}",
		`${tag}§4 the CI wait reads this run's own commit, through env:`]);
	r.push([envKeys(wait).join() === "CI_WAIT_S,GH_TOKEN,REPO,SHA", `${tag}§4 the CI wait's env sets nothing else: no CHECK_NAME or CI_POLL_S override (got ${envKeys(wait).join()})`]);
	const ciTimeout = Number((/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(noComments(jobBlocks(ciText).verify || "")) || [])[1]);
	const waitS = Number(String(stepEnv(wait, "CI_WAIT_S") || "").replace(/"/g, ""));
	const waitT = Number(stepKey(wait, "timeout-minutes"));
	r.push([ciTimeout > 0 && waitS >= ciTimeout * 60 + 120 && waitS <= 1800 && waitT * 60 > waitS,
		`${tag}§4 the CI wait outlasts CI's own ${ciTimeout}-minute timeout plus queue room, at most 30 min, inside its step timeout (CI_WAIT_S ${waitS}, step ${waitT} min)`]);
	const jobT = Number((/^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(noComments(staging)) || [])[1]);
	r.push([jobT >= waitT + smokeT + 10, `${tag}§4 the staging job's timeout (${jobT}) leaves room for the deploy after the CI wait (${waitT}) and the smoke (${smokeT})`]);
	const perms = /\n {4}permissions:\n((?: {6}.*\n)+)/.exec(`\n${noComments(staging)}`);
	const permSet = perms ? perms[1].split("\n").map((l) => l.trim()).filter(Boolean).sort().join(",") : "";
	r.push([permSet === "checks: read,contents: read", `${tag}§4 the staging job's token reads the repo and check runs, nothing more (got ${permSet})`]);

	// Production: needs staging on a push; a manual dispatch passes its own gate.
	const prod = noComments(jobs.production || "");
	r.push([/^ {4}needs:\s*\[\s*staging\s*\]\s*$/m.test(prod), `${tag}§4 production needs the staging job`]);
	r.push([/^ {4}environment:\s*\n {6}name:\s*production\s*$/m.test(prod), `${tag}§4 production keeps environment: production, so its deploys stay recorded`]);
	r.push([!/continue-on-error/.test(prod), `${tag}§4 nothing in the production job has continue-on-error`]);
	const psteps = stepBlocks(jobs.production || "");
	const iGate = psteps.findIndex((s) => /run:\s*node scripts\/deploy\/dispatch-gate\.js\s*$/m.test(s));
	const iProd = psteps.findIndex((s) => /uses:\s*\.\/\.github\/actions\/vps-deploy\s*$/m.test(s));
	const gateStep = psteps[iGate] || "";
	r.push([iGate >= 0 && iProd > iGate && /^ {8}id: gate\s*$/m.test(gateStep) && stepKey(gateStep, "if") === "github.event_name == 'workflow_dispatch'",
		`${tag}§4 a manual dispatch passes the dispatch gate (id: gate) before production deploys (gate ${iGate}, deploy ${iProd})`]);
	r.push([stepEnv(gateStep, "REF") === "${{ github.event.inputs.ref }}" && stepEnv(gateStep, "OVERRIDE") === "${{ github.event.inputs.override }}" && stepEnv(gateStep, "GITHUB_TOKEN") === "${{ github.token }}",
		`${tag}§4 the dispatch gate reads the dispatch's ref and override, through env:`]);
	const pd = psteps[iProd] || "";
	r.push([/^ {10}ref:\s*\$\{\{ github\.event_name == 'push' && 'main' \|\| steps\.gate\.outputs\.ref \}\}\s*$/m.test(pd)
		&& /^ {10}sha:\s*\$\{\{ github\.event_name == 'push' && github\.sha \|\| steps\.gate\.outputs\.sha \}\}\s*$/m.test(pd),
	`${tag}§4 production deploys main's pushed commit, or exactly the commit the dispatch gate checked`]);
	const pperms = /\n {4}permissions:\n((?: {6}.*\n)+)/.exec(`\n${prod}`);
	const ppermSet = pperms ? pperms[1].split("\n").map((l) => l.trim()).filter(Boolean).sort().join(",") : "";
	r.push([ppermSet === "actions: read,checks: read,contents: read", `${tag}§4 the production job's token only reads (got ${ppermSet})`]);
	const override = /\n {6}override:\n((?: {8}.*\n)+)/.exec(noComments(deployText));
	r.push([!!override && /type:\s*boolean/.test(override[1]) && /default:\s*false/.test(override[1]), `${tag}§4 the dispatch has a boolean override input, false by default`]);
	return r;
}

function checkAction() {
	const a = noComments(fs.readFileSync(ACTION_YML, "utf8"));
	ok(/^outputs:\n {2}result:\n(?: {4}.*\n)*? {4}value:\s*\$\{\{ steps\.deploy\.outputs\.result \}\}\s*$/m.test(a)
		&& /^ {2}to:\n(?: {4}.*\n)*? {4}value:\s*\$\{\{ steps\.deploy\.outputs\.to \}\}\s*$/m.test(a),
	"§4 the vps-deploy action exposes the deploy step's result and commit as outputs");
}

// The serves check's own script, run under bash for each answer the deploy step
// can give. noop-newer is the case it exists for: a newer build serving.
const OTHER = "e".repeat(40);
function checkServes(deployText, tag = "") {
	const r = [];
	const steps = rawStepBlocks(jobBlocks(deployText).staging || "");
	const script = runText(steps.find((s) => /- name: Staging serves this run's commit/.test(s)) || "");
	r.push([script.length > 0, `${tag}§4 the serves check has a run: script`]);
	const file = path.join(tmpDir("serves"), "step.sh");
	fs.writeFileSync(file, script);
	const run = (RESULT, TO) => spawnSync("bash", ["-e", file], { encoding: "utf8", env: { PATH: process.env.PATH, RESULT, TO, SHA } });
	for (const [name, result, to, want] of [
		["a deploy of this commit", "deployed", SHA, 0],
		["a no-op that leaves this very commit serving", "noop", SHA, 0],
		["a no-op with a NEWER commit serving", "noop", OTHER, 1],
		["a deploy that reports another commit", "deployed", OTHER, 1],
		["an unproven restart", "unproven", SHA, 1],
		["no result at all", "", "", 1],
	]) {
		const x = run(result, to);
		r.push([x.status === want && (want === 0 || /::error title=Staging (serves another commit|deploy unconfirmed)::/.test(x.stdout)),
			`${tag}§4 the serves check on ${name}: exit ${want} (got ${x.status}: ${(x.stdout || "").trim().slice(0, 160)})`]);
	}
	return r;
}

function checkTimeouts() {
	const dir = path.join(ROOT, ".github/workflows");
	for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
		const jobs = jobBlocks(fs.readFileSync(path.join(dir, f), "utf8"));
		ok(Object.keys(jobs).length > 0, `§4 ${f} has jobs`);
		for (const [id, text] of Object.entries(jobs)) {
			const m = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(noComments(text));
			ok(!!m && Number(m[1]) > 0 && Number(m[1]) <= 45, `§4 ${f} job '${id}' has its own timeout-minutes (1–45), so nothing it holds is held forever (got ${m && m[1]})`);
		}
	}
}

// A small evaluator for the expressions ci.yml's concurrency uses: context
// paths, string literals, ==, && and || with GitHub's value semantics.
function evalExpr(src, ctx) {
	const toks = src.match(/'[^']*'|==|&&|\|\||[()]|[A-Za-z_][A-Za-z0-9_.]*/g) || [];
	let i = 0;
	const primary = () => {
		const t = toks[i++];
		if (t === "(") { const v = or(); i++; return v; }
		if (t[0] === "'") return t.slice(1, -1);
		if (t === "true" || t === "false") return t === "true";
		const v = t.split(".").reduce((o, k) => (o == null ? undefined : o[k]), ctx);
		return v == null ? "" : v;
	};
	const eq = () => { let v = primary(); while (toks[i] === "==") { i++; const w = primary(); v = String(v).toLowerCase() === String(w).toLowerCase(); } return v; };
	const and = () => { let v = eq(); while (toks[i] === "&&") { i++; const w = eq(); v = v ? w : v; } return v; };
	const or = () => { let v = and(); while (toks[i] === "||") { i++; const w = and(); v = v || w; } return v; };
	return or();
}
const evalTemplate = (s, ctx) => s.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => String(evalExpr(e, ctx)));

function checkCi(ciText, tag = "") {
	const r = [];
	const c = noComments(ciText);
	const push = /^ {2}push:\s*\n((?: {4,}.*\n)*)/m.exec(c);
	const pushBody = push ? push[1].split("\n").filter((l) => l.trim()) : [];
	r.push([pushBody.length === 1 && /^ {4}branches:\s*\[\s*main\s*\]\s*$/.test(pushBody[0]),
		`${tag}§4 ci.yml runs on every push to main, with no paths, paths-ignore or other filter: production waits for that run (got ${JSON.stringify(pushBody)})`]);
	const name = (/^ {4}name:\s*(.+?)\s*$/m.exec(jobBlocks(ciText).verify || "") || [])[1];
	const waitDefault = (/^CHECK_NAME=\$\{CHECK_NAME:-(.+)\}$/m.exec(fs.readFileSync(WAIT, "utf8")) || [])[1];
	r.push([name === "check · unit · build" && waitDefault === name, `${tag}§4 the CI wait reads the check ci.yml's job reports (job '${name}', wait '${waitDefault}')`]);
	const group = (/^concurrency:\s*\n {2}group:\s*(.+?)\s*$/m.exec(c) || [])[1] || "";
	const cancel = (/^concurrency:\s*\n(?: {2}.*\n)*? {2}cancel-in-progress:\s*(.+?)\s*$/m.exec(c) || [])[1] || "";
	const ctx = (event, sha, ref) => ({ github: { event_name: event, sha, ref } });
	const A = "a".repeat(40);
	const B = "b".repeat(40);
	const g = (x) => evalTemplate(group, x);
	const k = (x) => String(evalTemplate(cancel, x));
	r.push([g(ctx("push", A, "refs/heads/main")) !== g(ctx("push", B, "refs/heads/main")), `${tag}§4 two merges' push runs never share a group (got ${g(ctx("push", A, "refs/heads/main"))})`]);
	r.push([g(ctx("workflow_dispatch", A, "refs/heads/main")) !== g(ctx("push", A, "refs/heads/main")),
		`${tag}§4 a manual run of the same commit never shares the push run's group, so it cannot cancel the run production waits for (got ${g(ctx("workflow_dispatch", A, "refs/heads/main"))})`]);
	r.push([k(ctx("push", A, "refs/heads/main")) === "false" && k(ctx("workflow_dispatch", A, "refs/heads/main")) === "false",
		`${tag}§4 push and manual runs never cancel anything in progress (got ${k(ctx("push", A, "refs/heads/main"))}, ${k(ctx("workflow_dispatch", A, "refs/heads/main"))})`]);
	r.push([g(ctx("pull_request", A, "refs/pull/7/merge")) === g(ctx("pull_request", B, "refs/pull/7/merge")) && k(ctx("pull_request", A, "refs/pull/7/merge")) === "true",
		`${tag}§4 a PR's new push still cancels its previous run`]);
	r.push([(c.match(/run:\s*npm run test:unit\s*$/gm) || []).length === 1 && !/run:\s*npm run (check|ci)\b/.test(c), `${tag}§4 CI runs the unit runners exactly once (test:unit, never check or ci, which include them)`]);
	r.push([/run:\s*npm run lint\s*$/m.test(c), `${tag}§4 CI runs the syntax check (npm run lint)`]);
	return r;
}

function checkLocal() {
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

// ─────────────────────────────────────────── §6 the manual-dispatch gate
// A fake GitHub API: the commit a ref names, the Deploy runs for a SHA, and
// their jobs. `s` picks the scenario.
function apiAnswer(pathAndQuery, s) {
	const u = new URL(pathAndQuery, "http://x");
	const m = /^\/repos\/o\/r\/commits\/(.+)$/.exec(u.pathname);
	if (m) {
		const ref = decodeURIComponent(m[1]);
		if (s.resolve && Object.prototype.hasOwnProperty.call(s.resolve, ref)) return { status: 200, body: { sha: s.resolve[ref] } };
		return { status: 404, body: { message: "No commit found" } };
	}
	if (u.pathname === "/repos/o/r/actions/workflows/deploy.yml/runs") {
		const sha = u.searchParams.get("head_sha");
		return { status: 200, body: { workflow_runs: (s.runs || []).map((x) => ({ head_sha: sha, ...x })) } };
	}
	const j = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
	if (j) return { status: 200, body: { jobs: (s.jobs && s.jobs[j[1]]) || [] } };
	if (/^\/repos\/o\/r\/check-runs\/\d+\/annotations$/.test(u.pathname)) return { status: 200, body: [] };
	return { status: 404, body: {} };
}
const fakeFetch = (s, calls) => async (url) => {
	calls.push(url);
	const a = apiAnswer(url.replace(/^https?:\/\/[^/]+/, ""), s);
	return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body };
};
const pushRun = (extra = {}) => ({ id: 7, event: "push", status: "completed", conclusion: "success", run_attempt: 1, html_url: "https://x/runs/7", ...extra });
const stagingJob = (conclusion, status = "completed") => ({ id: 70, name: "staging", status, conclusion, html_url: "https://x/jobs/70" });
const SCENARIOS = {
	passed: { resolve: { main: SHA, [SHA]: SHA, "v1.0": SHA, "feat/x": SHA }, runs: [pushRun()], jobs: { 7: [stagingJob("success")] } },
	failed: { resolve: { main: SHA, [SHA]: SHA }, runs: [pushRun({ conclusion: "failure" })], jobs: { 7: [stagingJob("failure")] } },
	noRun: { resolve: { main: SHA, [SHA]: SHA }, runs: [], jobs: {} },
	running: { resolve: { main: SHA }, runs: [pushRun({ status: "in_progress", conclusion: null })], jobs: { 7: [stagingJob(null, "in_progress")] } },
	otherSha: { resolve: { main: SHA }, runs: [pushRun({ head_sha: OTHER })], jobs: { 7: [stagingJob("success")] } },
	badSha: { resolve: { main: "not-a-sha" }, runs: [pushRun()], jobs: { 7: [stagingJob("success")] } },
};

async function checkDispatch(mod, tag = "") {
	const r = [];
	const decide = async (scenario, ref, override = false) => {
		const calls = [];
		const d = await mod.decideDispatch({ repo: "o/r", ref, override, token: "t", apiBase: "https://api.example", fetchImpl: fakeFetch(SCENARIOS[scenario], calls), sleepImpl: async () => {}, backoffMs: [] });
		return { ...d, calls };
	};
	let d = await decide("passed", "main");
	r.push([d.ok && !d.override && d.ref === "main" && d.sha === SHA, `${tag}§6 main, whose commit passed staging, deploys as main pinned to that commit (got ${JSON.stringify([d.ok, d.ref, d.sha])})`]);
	r.push([d.calls.some((u) => u.includes("/actions/workflows/deploy.yml/runs?head_sha=") && u.includes(SHA) && u.includes("event=push")),
		`${tag}§6 …after asking for the push-triggered Deploy runs of exactly that commit`]);
	d = await decide("passed", SHA);
	r.push([d.ok && d.ref === SHA && d.sha === "", `${tag}§6 a rollback to a SHA that passed staging deploys that SHA (got ${JSON.stringify([d.ok, d.ref, d.sha])})`]);
	d = await decide("passed", "v1.0");
	r.push([d.ok && d.ref === SHA && d.sha === "", `${tag}§6 a tag deploys the commit it named when checked, not whatever it names at pull time (got ${JSON.stringify([d.ok, d.ref])})`]);
	d = await decide("passed", "feat/x");
	r.push([d.ok && d.ref === SHA && d.calls[0].endsWith("/repos/o/r/commits/feat/x"), `${tag}§6 a branch with a slash resolves too (got ${d.calls[0]})`]);
	for (const [scenario, ref, verdict] of [["failed", "main", "failed"], ["noRun", "main", "unverified"], ["running", "main", "pending"], ["otherSha", "main", "unverified"]]) {
		d = await decide(scenario, ref);
		r.push([!d.ok && d.verdict === verdict && /has not passed the staging job/.test(d.reason), `${tag}§6 ${scenario}: refused, verdict '${verdict}' (got ${JSON.stringify([d.ok, d.verdict])})`]);
		const o = await decide(scenario, ref, true);
		r.push([o.ok && o.override && o.ref === "main" && o.sha === SHA, `${tag}§6 ${scenario} with override: deploys, marked as an override (got ${JSON.stringify([o.ok, o.override])})`]);
	}
	for (const [scenario, ref] of [["passed", "no-such-branch"], ["badSha", "main"]]) {
		d = await decide(scenario, ref, true);
		r.push([!d.ok && /cannot resolve/.test(d.reason), `${tag}§6 a ref that names no commit is refused even with override (${scenario}, '${ref}')`]);
	}
	for (const ref of ["-main", "a b", "", "x".repeat(101)]) {
		d = await decide("passed", ref, true);
		r.push([!d.ok && d.calls.length === 0, `${tag}§6 the ref ${JSON.stringify(ref.slice(0, 12))} is refused before any API call`]);
	}
	return r;
}

// The CLI end to end against the fake API, served on 127.0.0.1.
async function checkDispatchCli() {
	const r = [];
	for (const [scenario, ref, override, wantCode, wantOut, wantLog] of [
		["passed", "main", "false", 0, `ref=main\nsha=${SHA}\n`, /passed staging/],
		["failed", "main", "false", 1, "", /::error title=Manual production deploy refused::/],
		["failed", SHA, "true", 0, `ref=${SHA}\nsha=\n`, /::warning title=Staging gate overridden::/],
	]) {
		const server = http.createServer((req, res) => {
			const a = apiAnswer(req.url, SCENARIOS[scenario]);
			res.writeHead(a.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(a.body));
		});
		await new Promise((res) => server.listen(0, "127.0.0.1", res));
		const out = path.join(tmpDir("dispatch"), "out");
		fs.writeFileSync(out, "");
		const x = await new Promise((resolve) => {
			const child = spawn(process.execPath, [path.join(ROOT, "scripts/deploy/dispatch-gate.js")], {
				env: { PATH: process.env.PATH, REF: ref, OVERRIDE: override, GITHUB_REPOSITORY: "o/r", GITHUB_TOKEN: "t", GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: out, DISPATCH_GATE_RETRY_MS: "" },
			});
			let log = "";
			child.stdout.on("data", (c) => (log += c));
			child.stderr.on("data", (c) => (log += c));
			child.on("close", (code) => resolve({ code, log }));
		});
		server.close();
		const written = fs.readFileSync(out, "utf8");
		r.push([x.code === wantCode && written === wantOut && wantLog.test(x.log),
			`§6 CLI ${scenario} ref=${ref.slice(0, 7)} override=${override}: exit ${wantCode}, outputs ${JSON.stringify(wantOut)} (got exit ${x.code}, ${JSON.stringify(written)}: ${x.log.trim().slice(0, 200)})`]);
	}
	return r;
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

async function asyncMutants() {
	const m1 = mut(SMOKE, '[[ "$CTYPE" =~ $want ]] ||', "true ||");
	const m2 = mut(SMOKE, "000|5??|\"\")", "000|5??|4??|\"\")");
	const [r1, r2] = await Promise.all([checkSmoke(m1.p, "[mutant] "), checkSmoke(m2.p, "[mutant] ")]);
	ok(r1.some(([c]) => !c), "§5 mutant 'any 200 is a bundle file' must be caught by §1");
	ok(r2.some(([c]) => !c), "§5 mutant 'a 4xx is retried' must be caught by §1");
	// The dispatch gate, loaded from mutated text with its real require().
	const gatePath = path.join(ROOT, "scripts/deploy/dispatch-gate.js");
	const load = (code) => {
		const m = { exports: {} };
		new Function("module", "exports", "require", code.replace(/^#!.*\n/, "\n"))(m, m.exports, require("module").createRequire(gatePath));
		return m.exports;
	};
	for (const [name, from, to] of [
		["any verdict passes", 'if (verdict.verdict === "passed") return', "if (true) return"],
		["override deploys a ref that names no commit", '// Not even override deploys a ref that names no commit.\n\t\treturn refused(', "// Not even override deploys a ref that names no commit.\n\t\tif (!override) return refused("],
		["main deploys unpinned", 'ref === "main" ? { ref: "main", sha }', 'ref === "main" ? { ref: "main", sha: "" }'],
	]) {
		const src = fs.readFileSync(gatePath, "utf8");
		const code = src.split(from).join(to);
		ok(code !== src, `§5 mutant '${name}' must actually differ from dispatch-gate.js`);
		let caught = true;
		try {
			caught = (await checkDispatch(load(code), "[mutant] ")).some(([c]) => !c);
		} catch {
			caught = true;
		}
		ok(caught, `§5 mutant '${name}' must be caught by §6`);
	}
}

function mutants() {
	const m3 = mut(WAIT, '"completed success")', "completed\\ *)");
	ok(checkWait(m3.p, "[mutant] ").some(([c]) => !c), "§5 mutant 'any conclusion passes' must be caught by §2");
	const m3b = mut(WAIT, "&& ! printf '%s' \"$out\" | grep -qiE 'rate limit'", "");
	ok(checkWait(m3b.p, "[mutant] ").some(([c]) => !c), "§5 mutant 'a rate-limited 403 is a refusal' must be caught by §2");
	const m4 = mut(HOOK, "if npm run check; then", "if npm run check || true; then");
	ok(checkHook(m4.text, "[mutant] ").some(([c]) => !c), "§5 mutant 'the hook ignores the check's exit code' must be caught by §3");
	const m5 = mut(HOOK, "unset GIT_DIR", "unset GIT_NOTHING");
	ok(checkHook(m5.text, "[mutant] ").some(([c]) => !c), "§5 mutant 'GIT_DIR reaches the runners' must be caught by §3");
	const deployText = fs.readFileSync(DEPLOY_YML, "utf8");
	const ciText = fs.readFileSync(CI_YML, "utf8");
	const smokeStep = /\n {6}- name: Staging smoke[^\n]*\n(?: {8}.*\n)+/.exec(deployText);
	const gateStep = /\n {6}- name: A manual deploy names a commit that passed staging\n(?: {8}.*\n)+/.exec(deployText);
	ok(!!smokeStep && !!gateStep, "§5 the smoke and dispatch-gate steps can be found in deploy.yml");
	for (const [name, text] of [
		["the staging job without its smoke", smokeStep ? deployText.replace(smokeStep[0], "\n") : deployText],
		["the smoke allowed to fail", deployText.replace("        run: bash scripts/deploy/staging-smoke.sh\n", "        continue-on-error: true\n        run: bash scripts/deploy/staging-smoke.sh\n")],
		["the staging job allowed to fail", deployText.replace("    timeout-minutes: 40\n", "    timeout-minutes: 40\n    continue-on-error: true\n")],
		["the CI wait on dispatches only", deployText.replace("        if: github.event_name == 'push'\n        timeout-minutes: 21\n", "        if: github.event_name == 'workflow_dispatch'\n        timeout-minutes: 21\n")],
		["the CI wait reads another check", deployText.replace('          CI_WAIT_S: "1200"\n', '          CI_WAIT_S: "1200"\n          CHECK_NAME: build\n')],
		["the CI wait polls on its own clock", deployText.replace('          CI_WAIT_S: "1200"\n', '          CI_WAIT_S: "1200"\n          CI_POLL_S: "600"\n')],
		["the CI wait gives up before CI's own timeout", deployText.replace('CI_WAIT_S: "1200"', 'CI_WAIT_S: "720"')],
		["the staging job runs on dispatches of production too", deployText.replace(`if: ${STAGING_IF}`, "if: always()")],
		["production without the dispatch gate", gateStep ? deployText.replace(gateStep[0], "\n") : deployText],
		["production deploys the raw dispatch ref", deployText.replace("ref: ${{ github.event_name == 'push' && 'main' || steps.gate.outputs.ref }}", "ref: ${{ github.event.inputs.ref || 'main' }}")],
		["no override input", deployText.replace("        default: false\n        type: boolean\n", "")],
	]) {
		ok(text !== deployText, `§5 mutant '${name}' must actually differ from deploy.yml`);
		ok(checkDeployGate(text, ciText, "[mutant] ").some(([c]) => !c), `§5 mutant '${name}' must be caught by §4`);
	}
	const servesLoose = deployText.replace('if [ "$TO" != "$SHA" ]; then', "if false; then");
	ok(servesLoose !== deployText && checkServes(servesLoose, "[mutant] ").some(([c]) => !c), "§5 mutant 'the serves check accepts a newer build' must be caught by §4");
	for (const [name, text] of [
		["ci.yml skips docs-only pushes", ciText.replace("  push:\n    branches: [main]\n", "  push:\n    branches: [main]\n    paths-ignore: [\"**.md\"]\n")],
		["a manual run shares the push run's group", ciText.replace("ci-${{ github.event_name }}-${{", "ci-${{")],
		["push runs cancel each other again", ciText.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "cancel-in-progress: true")],
	]) {
		ok(text !== ciText, `§5 mutant '${name}' must actually differ from ci.yml`);
		ok(checkCi(text, "[mutant] ").some(([c]) => !c), `§5 mutant '${name}' must be caught by §4`);
	}
}

(async () => {
	// Everything served from this event loop runs first, together: the stub app
	// for the smoke and the fake API for the dispatch CLI. The synchronous
	// sections after them block the loop.
	const [smoke, dispatch, cli] = await Promise.all([checkSmoke(SMOKE), checkDispatch(require("./deploy/dispatch-gate.js")), checkDispatchCli(), asyncMutants()]);
	for (const [c, m] of [...smoke, ...dispatch, ...cli]) ok(c, m);
	for (const [c, m] of checkWait(WAIT)) ok(c, m);
	checkJq();
	for (const [c, m] of checkHook(fs.readFileSync(HOOK, "utf8"))) ok(c, m);
	const deployText = fs.readFileSync(DEPLOY_YML, "utf8");
	const ciText = fs.readFileSync(CI_YML, "utf8");
	for (const [c, m] of checkDeployGate(deployText, ciText)) ok(c, m);
	for (const [c, m] of checkServes(deployText)) ok(c, m);
	for (const [c, m] of checkCi(ciText)) ok(c, m);
	checkAction();
	checkTimeouts();
	checkLocal();
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
