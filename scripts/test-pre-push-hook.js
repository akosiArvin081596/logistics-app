#!/usr/bin/env node
/**
 * Pins .githooks/pre-push: WHICH worktree it checks, and HOW it runs the
 * check (one sandboxed child, a scrubbed environment, a fail-closed verdict).
 *
 * WHY IT EXISTS. core.hooksPath is often an absolute path to one checkout's
 * .githooks, and every linked worktree of that repository shares it. The hook
 * used to find the code to check from its own file's location, so a push from
 * a linked worktree checked the other checkout: a broken worktree pushed
 * green, and a broken main checkout blocked a clean worktree.
 *
 *   §1 a real `git push` from a linked worktree checks that worktree, not the
 *      checkout the hook file lives in: it passes while that checkout is
 *      broken, and a broken worktree blocks the push and leaves the remote
 *      where it was
 *   §2 a push from the main checkout still checks the main checkout
 *   §3 a push that only deletes a branch runs nothing
 *   §4 run by hand: from a subdirectory of a worktree it checks that
 *      worktree; outside any worktree it refuses and runs nothing; given
 *      git's repository variables (as git hands them to a hook) it checks the
 *      worktree they name
 *   §5 git's repository variables still never reach the check
 *   §6 mutants of the hook, each caught above: the root taken from the hook
 *      file's location (the old line), and the root read after the variables
 *      are unset
 *   §7 the check runs as ONE child under the absolute sandbox-exec, with the
 *      hook's own profile and the real, regex-quoted home and worktree, as
 *      `node scripts/run-unit-tests.js --lint --budget-ms 115000
 *      --changed-list ... --changed-count ... --server-diff ...`;
 *      LOGISX_PREPUSH=full passes --full instead, still sandboxed; any other
 *      value blocks (no off switch)
 *   §8 a sandbox that can't start blocks the push with the D6 message (exit
 *      71, or sandbox-exec missing); off macOS it runs unsandboxed and says so;
 *      the platform comes from /usr/bin/uname, so a `uname` on PATH that
 *      names the other platform changes nothing
 *   §9 the child's environment is the allowlist (GH_TOKEN, SSH_AUTH_SOCK,
 *      UNIT_TEST_SHARD, UNIT_TEST_SKIP_TIMING and the rest never reach it),
 *      and its stdin is /dev/null, never the hook's
 *   §10 the changed list: every pushed ref's files against its merge-base
 *      with origin/main, plus dirty and untracked files; --changed-count
 *      agrees with it; on macOS the hook keeps it (and its log) in a folder
 *      under ~/Library/Caches, outside the temp space the child may write
 *   §11 (= §3) a deletion-only push still runs nothing
 *   §12 the exit contract: it passes only on exit 0 AND the exact PASS
 *      verdict as the last line. It blocks on a selection failure, lint
 *      failing while every runner passed (exit 0 or 1), a failed merge-base,
 *      no folder to work in (~/Library/Caches on macOS, temp space elsewhere),
 *      exit 71, a profile parse error (65), a signal,
 *      exit 0 without the verdict, and the PASS verdict with a non-zero exit.
 *      It passes with runners "not run for time" and with a times-cache note.
 *      Mutants: a missing verdict read as a pass, a non-zero exit ignored,
 *      only the runners' result checked
 *   §13 (D12) a worktree whose run-unit-tests.js predates the pre-push mode
 *      gets lint and the whole suite (`npm run check`), still sandboxed,
 *      never nothing
 *   §14 tier 0 past the deadline: the harness's job, pinned for real in
 *      scripts/test-test-selection.js §8 and §10 (here the child is a stub)
 *
 * Hermetic: a mkdtemp sandbox, local git only (the remote is a bare repo in
 * it, global and system git config ignored). The hook copies have their
 * absolute /usr/bin/sandbox-exec rewritten to a stub and their platform read
 * as Darwin; the stub records its argv, cwd, environment, stdin and changed
 * list in files (the hook empties its environment, so nothing can be passed
 * in), and answers per a scenario file. Stub node and fnm first on PATH. No
 * network.
 * Run: node scripts/test-pre-push-hook.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK_TEXT = fs.readFileSync(path.join(__dirname, "..", ".githooks/pre-push"), "utf8");
const PROFILE = (/<<'SANDBOX_PROFILE' \|\| true\n([\s\S]*?)\nSANDBOX_PROFILE\n/.exec(HOOK_TEXT) || [])[1];

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-hook-")));
process.on("exit", () => fs.rmSync(T, { recursive: true, force: true }));

const M = path.join(T, "main");
const W = path.join(T, "wt");
const W2 = path.join(T, "wt2");
const R = path.join(T, "remote.git");
const OUTSIDE = path.join(T, "outside");
const BIN = path.join(T, "bin");
const HOME = path.join(T, "ho.me");
const CALLS = path.join(T, "calls");
const SCENARIO = path.join(T, "scenario");
for (const d of [OUTSIDE, BIN, HOME, CALLS]) fs.mkdirSync(d);
const CACHES = path.join(HOME, "Library", "Caches");
fs.mkdirSync(CACHES, { recursive: true });
const EMPTY_GITCONFIG = path.join(HOME, "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");

// The runner's own git variables (set when it runs under a hook that kept
// them) would point the sandbox's git commands back at this repository.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("UNIT_TEST_") && k !== "LOGISX_PREPUSH"));
Object.assign(ENV, {
	PATH: `${BIN}:${process.env.PATH}`,
	HOME,
	XDG_CONFIG_HOME: path.join(HOME, ".config"),
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
	GIT_CEILING_DIRECTORIES: T,
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
	GH_TOKEN: "fake-not-a-token", SSH_AUTH_SOCK: "/nonexistent/agent.sock",
	UNIT_TEST_SHARD: "1/3", UNIT_TEST_SKIP_TIMING: "1", UNIT_TEST_TIMEOUT_MS: "90000", SOMETHING_ELSE: "x",
});

function git(cwd, ...args) {
	const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr}`);
	return r.stdout.trim();
}
const remoteRef = (b) => spawnSync("git", ["--git-dir", R, "rev-parse", "--verify", "-q", `refs/heads/${b}`], { env: ENV, encoding: "utf8" }).stdout.trim();

// Stubs. The child stub records each call in its own folder under CALLS and
// answers per SCENARIO; it fails in a tree holding BROKEN. sandbox-exec, node
// (other than -v) and npm all hand over to it, saying which they were.
const stub = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
stub("child", `as=$1; shift
d=${CALLS}/$$
mkdir -p "$d"
printf '%s' "$as" > "$d/as"
printf '%s\\0' "$@" > "$d/argv"
pwd -P > "$d/cwd"
/usr/bin/env > "$d/env"
if [ /dev/fd/0 -ef /dev/null ]; then echo null > "$d/stdin"; else echo other > "$d/stdin"; fi
prev=""
for a in "$@"; do
	[ "$prev" = "--changed-list" ] && /bin/cp "$a" "$d/list"
	prev=$a
done
pass_line="pre-push verdict: lint=pass selection=pass runners=pass"
case "$(/bin/cat ${SCENARIO} 2>/dev/null)" in
	exit71) echo "sandbox-exec: sandbox_apply: Operation not permitted"; exit 71 ;;
	exit65) echo "sandbox-exec: profile syntax error"; exit 65 ;;
	signal) kill -9 $$ ;;
	noverdict) echo "all done"; exit 0 ;;
	lintfail0) echo "pre-push verdict: lint=fail selection=pass runners=pass"; exit 0 ;;
	lintfail1) echo "pre-push verdict: lint=fail selection=pass runners=pass"; exit 1 ;;
	selfail) echo "pre-push verdict: lint=pass selection=fail runners=skipped"; exit 1 ;;
	passexit1) echo "$pass_line"; exit 1 ;;
	notrun) echo "Not run for time (CI runs them): test-x.js"; echo "Ran 1 of 2 picked runners in 1.0 s; 1 not run for time (CI runs them). Full suite: npm run check."; echo "$pass_line"; exit 0 ;;
	cachenote) echo "note: times cache unreadable (x); every runner counts as the median"; echo "$pass_line"; exit 0 ;;
esac
if [ -e BROKEN ]; then echo "pre-push verdict: lint=pass selection=pass runners=fail"; exit 1; fi
echo "$pass_line"
exit 0`);
stub("sandbox-exec", `exec ${BIN}/child sandbox-exec "$@"`);
stub("node", `[ "\${1:-}" = "-v" ] && { echo v22.23.2; exit 0; }\nexec ${BIN}/child node "$@"`);
stub("npm", `exec ${BIN}/child npm "$@"`);
stub("fnm", "exit 0");

// A hook copy: the stub in place of /usr/bin/sandbox-exec, the platform read
// as Darwin (so the sandboxed path runs on Linux CI too) or as given; null
// keeps the hook's own platform line.
const PLATFORM_LINE = "platform=$(/usr/bin/uname -s)\n";
function adapt(text, { sandboxExec = `${BIN}/sandbox-exec`, platform = "Darwin" } = {}) {
	const out = text.replace("SANDBOX_EXEC=/usr/bin/sandbox-exec\n", `SANDBOX_EXEC=${sandboxExec}\n`);
	return platform === null ? out : out.replace(PLATFORM_LINE, `platform=${platform}\n`);
}
ok(adapt(HOOK_TEXT) !== HOOK_TEXT && adapt(HOOK_TEXT).includes(`SANDBOX_EXEC=${BIN}/sandbox-exec`) && adapt(HOOK_TEXT).includes("platform=Darwin\n"),
	"§7 the hook names /usr/bin/sandbox-exec and reads the platform from /usr/bin/uname, on lines a copy can rewrite");

// The sandbox: a main checkout M whose .githooks every worktree uses through
// an ABSOLUTE core.hooksPath, linked worktrees W and W2, a bare remote R with
// main, so origin/main exists.
const HARNESS_STUB = "// const PREPUSH_PROTOCOL = 1;\n";
git(T, "init", "-q", "--bare", R);
git(T, "init", "-q", "-b", "main", M);
fs.writeFileSync(path.join(M, ".nvmrc"), "22.23.2\n");
fs.mkdirSync(path.join(M, "sub"));
fs.writeFileSync(path.join(M, "sub/file.txt"), "x\n");
fs.mkdirSync(path.join(M, "scripts"));
fs.writeFileSync(path.join(M, "scripts/run-unit-tests.js"), HARNESS_STUB);
git(M, "add", ".");
git(M, "commit", "-q", "-m", "init");
git(M, "remote", "add", "origin", R);
git(M, "push", "-q", "origin", "main");
git(M, "worktree", "add", "-q", "-b", "feature", W);
git(M, "worktree", "add", "-q", "-b", "other", W2);
const W_GIT_DIR = git(W, "rev-parse", "--absolute-git-dir");

let hookN = 0;
function hooksDir(text) {
	const dir = path.join(M, `.githooks-${++hookN}`);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "pre-push"), text, { mode: 0o755 });
	return dir;
}

// The calls the child stub recorded since the last run.
function takeCalls() {
	const out = [];
	for (const id of fs.readdirSync(CALLS)) {
		const d = path.join(CALLS, id);
		const read = (f) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), "utf8") : null);
		const env = Object.fromEntries((read("env") || "").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
		const list = read("list");
		out.push({ as: read("as"), argv: (read("argv") || "").split("\0").slice(0, -1), cwd: (read("cwd") || "").trim(), env, list: list === null ? null : list.split("\0").filter(Boolean), stdin: (read("stdin") || "").trim() });
		fs.rmSync(d, { recursive: true, force: true });
	}
	return out;
}
function run(cmd, args, cwd, env, input) {
	takeCalls();
	const r = spawnSync(cmd, args, { cwd, env: { ...ENV, ...env }, encoding: "utf8", timeout: 30000, input, stdio: input === undefined ? ["ignore", "pipe", "pipe"] : "pipe" });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls: takeCalls() };
}
const push = (cwd, hooks, args, env = {}) => run("git", ["-c", `core.hooksPath=${hooks}`, "push", ...args], cwd, env);
const byHand = (hooks, cwd, env = {}) => run("bash", [path.join(hooks, "pre-push")], cwd, env);
const scenario = (s) => fs.writeFileSync(SCENARIO, s);
const ranIn = (r, dir) => r.calls.length === 1 && r.calls[0].as === "sandbox-exec" && r.calls[0].cwd === dir;
const where = (r) => JSON.stringify(r.calls.map((c) => `${c.as}@${c.cwd}`));
const noGitVars = (r) => r.calls.length > 0 && r.calls.every((c) => !Object.keys(c.env).some((k) => k.startsWith("GIT_")));
const broken = (dir, on) => (on ? fs.writeFileSync(path.join(dir, "BROKEN"), "") : fs.rmSync(path.join(dir, "BROKEN"), { force: true }));

let branchN = 0;
function battery(hooks, tag = "") {
	const r = [];
	const b = `b${++branchN}`;
	scenario("");

	// §1 the hook's own checkout is broken, the worktree is clean: it pushes.
	git(W, "commit", "-q", "--allow-empty", "-m", `${b} one`);
	const first = git(W, "rev-parse", "HEAD");
	broken(M, true);
	const clean = push(W, hooks, ["-q", "origin", `HEAD:refs/heads/${b}`]);
	broken(M, false);
	r.push([clean.code === 0 && ranIn(clean, W), `${tag}§1 a push from a linked worktree checks that worktree, not the hook's own checkout (exit ${clean.code}, checked ${where(clean)}, want ["sandbox-exec@${W}"]): ${clean.out.slice(-200)}`]);
	r.push([remoteRef(b) === first, `${tag}§1 …and the push lands`]);

	// §1 the worktree is broken, the hook's own checkout is clean: blocked.
	git(W, "commit", "-q", "--allow-empty", "-m", `${b} two`);
	broken(W, true);
	const blocked = push(W, hooks, ["-q", "origin", `HEAD:refs/heads/${b}`]);
	r.push([blocked.code !== 0 && /push was blocked/.test(blocked.out) && ranIn(blocked, W), `${tag}§1 a broken linked worktree blocks its own push (exit ${blocked.code}, checked ${where(blocked)})`]);
	r.push([remoteRef(b) === first, `${tag}§1 …and the remote keeps its old commit`]);
	r.push([noGitVars(clean) && noGitVars(blocked), `${tag}§5 git's repository variables never reach the check`]);

	// §3 deleting a branch runs nothing, even from the broken worktree.
	const deleted = push(W, hooks, ["-q", "origin", "--delete", b]);
	r.push([deleted.code === 0 && deleted.calls.length === 0 && /only branch deletions/.test(deleted.out) && remoteRef(b) === "",
		`${tag}§3 a push that only deletes a branch runs nothing (exit ${deleted.code}, checked ${where(deleted)})`]);
	broken(W, false);

	// §2 the main checkout still checks itself.
	const fromMain = push(M, hooks, ["-q", "origin", `HEAD:refs/heads/${b}-main`]);
	r.push([fromMain.code === 0 && ranIn(fromMain, M) && noGitVars(fromMain), `${tag}§2 a push from the main checkout checks the main checkout (exit ${fromMain.code}, checked ${where(fromMain)})`]);

	// §4 by hand.
	const sub = byHand(hooks, path.join(W, "sub"));
	r.push([sub.code === 0 && ranIn(sub, W), `${tag}§4 run by hand in a worktree's subdirectory, it checks that worktree (exit ${sub.code}, checked ${where(sub)})`]);
	const outside = byHand(hooks, OUTSIDE);
	r.push([outside.code === 1 && outside.calls.length === 0 && /not inside a git worktree/.test(outside.out),
		`${tag}§4 run by hand outside any worktree, it refuses and runs nothing (exit ${outside.code}, checked ${where(outside)})`]);
	const vars = byHand(hooks, OUTSIDE, { GIT_DIR: W_GIT_DIR, GIT_WORK_TREE: W, GIT_INDEX_FILE: path.join(W_GIT_DIR, "index") });
	r.push([vars.code === 0 && ranIn(vars, W) && noGitVars(vars),
		`${tag}§4 given git's repository variables, it checks the worktree they name and unsets them before the check (exit ${vars.code}, checked ${where(vars)})`]);
	return r;
}

// The exit contract, per scenario: [scenario, passes?, what the output must say].
const CONTRACT = [
	["", true, /pre-push: passed in/],
	["notrun", true, /pre-push: passed in/],
	["cachenote", true, /pre-push: passed in/],
	["selfail", false, /reported lint=pass selection=fail/],
	["lintfail0", false, /reported lint=fail selection=pass runners=pass \(exit 0\)/],
	["lintfail1", false, /reported lint=fail/],
	["exit71", false, /can't start its sandbox \(already inside one\?\)\. Push with plain `git push` from the worktree\./],
	["exit65", false, /sandbox profile didn't parse/],
	["signal", false, /killed by signal 9/],
	["noverdict", false, /exited 0 without its verdict line/],
	["passexit1", false, /reported lint=pass selection=pass runners=pass \(exit 1\)/],
];
function contract(hooks, tag = "") {
	const r = [];
	for (const [s, passes, says] of CONTRACT) {
		scenario(s);
		const h = byHand(hooks, W);
		const verdict = passes ? h.code === 0 : h.code === 1 && /push was blocked/.test(h.out);
		r.push([verdict && says.test(h.out), `${tag}§12 scenario '${s || "all green"}' ${passes ? "passes" : "blocks"} and says why (exit ${h.code}): ${h.out.trim().split("\n").slice(-2).join(" | ")}`]);
	}
	scenario("");
	return r;
}

try {
	const hooks = hooksDir(adapt(HOOK_TEXT));
	for (const [c, m] of battery(hooks)) ok(c, m);

	// §7 the invocation.
	scenario("");
	const inv = byHand(hooks, W);
	const call = inv.calls[0] || { argv: [], env: {} };
	const a = call.argv;
	const dParam = (k) => { const i = a.indexOf(`${k}=${(a.find((x) => x.startsWith(`${k}=`)) || "").slice(k.length + 1)}`); return i > 0 && a[i - 1] === "-D" ? a[i].slice(k.length + 1) : null; };
	const realHome = fs.realpathSync(HOME);
	ok(inv.code === 0 && inv.calls.length === 1 && call.as === "sandbox-exec", `§7 the check runs as one child under the absolute sandbox-exec (exit ${inv.code}, calls ${where(inv)})`);
	ok(!!PROFILE && a[0] === "-p" && a[1] === PROFILE, "§7 …with the profile kept in the hook itself");
	ok(dParam("HOME") === realHome && dParam("WORK") === W, `§7 …the real home and worktree as HOME and WORK (got ${dParam("HOME")}, ${dParam("WORK")})`);
	ok(dParam("HOME_RE") === realHome.replace(/\./g, "\\.") && dParam("WORK_RE") === W.replace(/\./g, "\\."), `§7 …and the same quoted for a regex as HOME_RE and WORK_RE (got ${dParam("HOME_RE")})`);
	const cmd = a.slice(a.lastIndexOf("-D") + 2);
	ok(cmd[0] === path.join(BIN, "node") && cmd[1] === "scripts/run-unit-tests.js" && cmd.includes("--lint") && cmd[cmd.indexOf("--budget-ms") + 1] === "115000"
		&& cmd.includes("--changed-list") && cmd.includes("--changed-count") && cmd.includes("--server-diff") && !cmd.includes("--full"),
	`§7 …running node scripts/run-unit-tests.js --lint --budget-ms 115000 with the changed list, its count and the server.js diff (got ${JSON.stringify(cmd)})`);
	const full = byHand(hooks, W, { LOGISX_PREPUSH: "full" });
	const fullCmd = (full.calls[0] || { argv: [] }).argv;
	ok(full.code === 0 && full.calls.length === 1 && full.calls[0].as === "sandbox-exec" && fullCmd.includes("--full") && fullCmd.includes("--lint") && !fullCmd.includes("--changed-list"),
		`§7 LOGISX_PREPUSH=full runs every runner, still sandboxed (exit ${full.code}, argv ${JSON.stringify(fullCmd.slice(-4))})`);
	const off = byHand(hooks, W, { LOGISX_PREPUSH: "off" });
	ok(off.code === 1 && off.calls.length === 0 && /not a mode/.test(off.out), `§7 any other LOGISX_PREPUSH value blocks: there is no off switch (exit ${off.code})`);

	// §8 no sandbox.
	const missing = byHand(hooksDir(adapt(HOOK_TEXT, { sandboxExec: path.join(T, "no-such-sandbox-exec") })), W);
	ok(missing.code === 1 && missing.calls.length === 0 && /can't start its sandbox: .* is missing/.test(missing.out), `§8 on macOS a missing sandbox-exec blocks the push (exit ${missing.code})`);
	const linux = byHand(hooksDir(adapt(HOOK_TEXT, { platform: "Linux" })), W);
	ok(linux.code === 0 && linux.calls.length === 1 && linux.calls[0].as === "node" && /no sandbox on Linux; the checks run with your full rights/.test(linux.out)
		&& !Object.keys(linux.calls[0].env).includes("GH_TOKEN"),
	`§8 off macOS it runs the same check unsandboxed, environment still scrubbed, and says so (exit ${linux.code}, calls ${where(linux)})`);
	// The hook's own platform line, with a `uname` first on PATH that names the
	// other platform: the branch follows /usr/bin/uname.
	const real = spawnSync("/usr/bin/uname", ["-s"], { encoding: "utf8" });
	const realPlatform = real.status === 0 ? real.stdout.trim() : "";
	stub("uname", `echo ${realPlatform === "Darwin" ? "Linux" : "Darwin"}`);
	const lied = byHand(hooksDir(adapt(HOOK_TEXT, { platform: null })), W);
	fs.rmSync(path.join(BIN, "uname"));
	const wantBranch = realPlatform === "Darwin" ? "sandbox-exec" : "node";
	ok(lied.code === 0 && lied.calls.length === 1 && lied.calls[0].as === wantBranch,
		`§8 a uname on PATH naming the other platform doesn't change the branch (this is ${realPlatform || "not macOS"}: want ${wantBranch}, got ${where(lied)}): ${lied.out.trim().split("\n").slice(-2).join(" | ")}`);

	// §9 the environment.
	const BASH_OWN = new Set(["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"]);
	const ALLOW = new Set(["PATH", "NODE_ENV", "HOME", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL", "TERM", "UNIT_TEST_TIMEOUT_MS", "UNIT_TEST_CONCURRENCY"]);
	const keys = Object.keys(call.env).filter((k) => !BASH_OWN.has(k));
	ok(keys.length > 0 && keys.every((k) => ALLOW.has(k)), `§9 the child's environment holds only the allowlist (extra: ${keys.filter((k) => !ALLOW.has(k)).join(", ")})`);
	ok(call.env.PATH === `${BIN}:/usr/bin:/bin` && call.env.NODE_ENV === "test" && call.env.HOME === HOME && call.env.UNIT_TEST_TIMEOUT_MS === "90000",
		`§9 …PATH is this Node's folder plus /usr/bin:/bin, NODE_ENV=test, HOME kept, UNIT_TEST_TIMEOUT_MS passed through (got ${call.env.PATH}, ${call.env.NODE_ENV})`);
	ok(!["GH_TOKEN", "SSH_AUTH_SOCK", "UNIT_TEST_SHARD", "UNIT_TEST_SKIP_TIMING", "SOMETHING_ELSE", "GIT_CONFIG_GLOBAL"].some((k) => k in call.env),
		"§9 …and GH_TOKEN, SSH_AUTH_SOCK, UNIT_TEST_SHARD, UNIT_TEST_SKIP_TIMING and everything else never reach it");
	// The hook's stdin is a pipe here (a terminal when run by hand from one).
	const piped = run("bash", [path.join(hooks, "pre-push")], W, {}, "");
	const pipedCall = piped.calls[0] || {};
	ok(piped.code === 0 && piped.calls.length === 1 && pipedCall.stdin === "null",
		`§9 …and its stdin is /dev/null, never the hook's own (exit ${piped.code}, got ${pipedCall.stdin})`);

	// §10 the changed list, several refs at once.
	fs.writeFileSync(path.join(W, "a.txt"), "a\n");
	git(W, "add", "a.txt");
	git(W, "commit", "-q", "-m", "a");
	fs.writeFileSync(path.join(W2, "b.txt"), "b\n");
	git(W2, "add", "b.txt");
	git(W2, "commit", "-q", "-m", "b");
	fs.writeFileSync(path.join(W, "sub/file.txt"), "dirty\n");
	fs.writeFileSync(path.join(W, "c.txt"), "untracked\n");
	const both = push(W, hooks, ["-q", "origin", "feature", "other"]);
	const lc = both.calls[0] || { list: null, argv: [] };
	const got = [...new Set(lc.list || [])].sort();
	ok(both.code === 0 && JSON.stringify(got) === JSON.stringify(["a.txt", "b.txt", "c.txt", "sub/file.txt"]),
		`§10 the changed list holds both refs' files against the merge-base, the dirty file and the untracked one (exit ${both.code}, got ${JSON.stringify(got)})`);
	ok(lc.list !== null && lc.argv[lc.argv.indexOf("--changed-count") + 1] === String(lc.list.length), `§10 …and --changed-count is how many it wrote (${lc.argv[lc.argv.indexOf("--changed-count") + 1]} vs ${lc.list && lc.list.length})`);
	const listPath = lc.argv[lc.argv.indexOf("--changed-list") + 1] || "";
	const diffPath = lc.argv[lc.argv.indexOf("--server-diff") + 1] || "";
	ok(listPath.startsWith(`${CACHES}/logisx-prepush.`) && path.dirname(diffPath) === path.dirname(listPath),
		`§10 on macOS the list and the server.js diff live in a folder under ~/Library/Caches, outside the child's temp space (got ${listPath}, ${diffPath})`);
	git(W, "checkout", "-q", "--", "sub/file.txt");
	fs.rmSync(path.join(W, "c.txt"));

	// §12 the exit contract, then its failures that come before the child.
	for (const [c, m] of contract(hooks)) ok(c, m);
	const noCaches = byHand(hooks, W, { HOME: path.join(T, "no-such-home") });
	ok(noCaches.code === 1 && noCaches.calls.length === 0 && /can't make a temp directory in \S*no-such-home\/Library\/Caches/.test(noCaches.out),
		`§12 on macOS, no ~/Library/Caches to work in blocks before the child starts (exit ${noCaches.code}): ${noCaches.out.trim().split("\n").slice(-2).join(" | ")}`);
	const noTmp = byHand(hooksDir(adapt(HOOK_TEXT, { platform: "Linux" })), W, { TMPDIR: path.join(T, "no-such-dir") });
	ok(noTmp.code === 1 && noTmp.calls.length === 0 && /can't make a temp directory/.test(noTmp.out), `§12 elsewhere, no writable temp space blocks before the child starts (exit ${noTmp.code})`);
	const lone = path.join(T, "lone");
	git(T, "init", "-q", "-b", "main", lone);
	fs.mkdirSync(path.join(lone, "scripts"));
	fs.writeFileSync(path.join(lone, "scripts/run-unit-tests.js"), HARNESS_STUB);
	git(lone, "add", ".");
	git(lone, "commit", "-q", "-m", "init");
	const noBase = push(lone, hooks, ["-q", R, "HEAD:refs/heads/lone"]);
	ok(noBase.code !== 0 && noBase.calls.length === 0 && /can't find where .* leaves origin\/main/.test(noBase.out) && remoteRef("lone") === "",
		`§12 a merge-base that can't be computed blocks the push (exit ${noBase.code}): ${noBase.out.trim().split("\n").slice(-2).join(" | ")}`);

	for (const [name, from, to] of [
		["a missing verdict read as a pass", 'if [ "$protocol" = 1 ] && [ "$status" -eq 0 ] && [ "$last" = "$pass_line" ]; then', 'if [ "$protocol" = 1 ] && [ "$status" -eq 0 ]; then'],
		["a non-zero exit ignored", 'if [ "$protocol" = 1 ] && [ "$status" -eq 0 ] && [ "$last" = "$pass_line" ]; then', 'if [ "$protocol" = 1 ] && [ "$last" = "$pass_line" ]; then'],
		["only the runners' result checked", 'if [ "$protocol" = 1 ] && [ "$status" -eq 0 ] && [ "$last" = "$pass_line" ]; then', 'if [ "$protocol" = 1 ] && [ "$status" -eq 0 ] && [ "${last##*runners=}" = "pass" ]; then'],
	]) {
		const text = HOOK_TEXT.split(from).join(to);
		ok(text !== HOOK_TEXT, `§12 mutant '${name}' must change the hook`);
		ok(contract(hooksDir(adapt(text)), "[mutant] ").some(([c]) => !c), `§12 mutant '${name}' must be caught`);
	}

	// §13 a worktree branched before the pre-push mode.
	fs.writeFileSync(path.join(W, "scripts/run-unit-tests.js"), "// the old harness\n");
	const old = byHand(hooks, W);
	const oldCmd = (old.calls[0] || { argv: [] }).argv;
	ok(old.code === 0 && old.calls.length === 1 && old.calls[0].as === "sandbox-exec" && oldCmd.slice(-3).join(" ") === `${path.join(BIN, "npm")} run check`
		&& /predates the pre-push mode, so lint and the whole suite run instead \(still sandboxed\)/.test(old.out),
	`§13 a worktree whose harness predates the mode runs npm run check, sandboxed (exit ${old.code}, argv ${JSON.stringify(oldCmd.slice(-3))})`);
	git(W, "checkout", "-q", "--", "scripts/run-unit-tests.js");

	// §6 mutants. A mutant that leaves the text unchanged proves nothing.
	const ROOT_LINE = "root=$(git rev-parse --show-toplevel 2>/dev/null)\n";
	const UNSET_END = "GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE\n";
	ok(HOOK_TEXT.includes(ROOT_LINE) && HOOK_TEXT.includes(UNSET_END) && HOOK_TEXT.indexOf(ROOT_LINE) < HOOK_TEXT.indexOf(UNSET_END),
		"§6 the hook reads its root with git rev-parse --show-toplevel before unsetting git's variables");
	const mutants = [
		["the root taken from the hook file's location (the old line)",
			HOOK_TEXT.replace(ROOT_LINE, 'root=$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")\n')],
		["the root read after git's variables are unset",
			HOOK_TEXT.replace(ROOT_LINE, "").replace(UNSET_END, `${UNSET_END}${ROOT_LINE}`)],
	];
	for (const [name, text] of mutants) {
		const caught = text !== HOOK_TEXT && battery(hooksDir(adapt(text)), "[mutant] ").some(([c]) => !c);
		ok(caught, `§6 mutant '${name}' must be caught`);
	}
} catch (e) {
	failures.push(`crashed: ${e.stack || e}`);
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
