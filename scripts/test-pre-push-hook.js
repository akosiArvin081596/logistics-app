#!/usr/bin/env node
/**
 * Pins WHICH worktree .githooks/pre-push checks: the one git runs it in.
 *
 * WHY IT EXISTS. core.hooksPath is often an absolute path to one checkout's
 * .githooks, and every linked worktree of that repository shares it. The hook
 * used to find the code to check from its own file's location, so a push from
 * a linked worktree ran `npm run check` in the other checkout: a broken
 * worktree pushed green, and a broken main checkout blocked a clean worktree.
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
 *
 * Hermetic: a mkdtemp sandbox, local git only (the remote is a bare repo in
 * the sandbox, global and system git config ignored), stub npm, fnm and node
 * first on PATH. The stub npm fails when the directory it runs in holds a
 * BROKEN file, so "which tree was checked" decides whether a push goes
 * through. No network.
 * Run: node scripts/test-pre-push-hook.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK_TEXT = fs.readFileSync(path.join(__dirname, "..", ".githooks/pre-push"), "utf8");

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-hook-")));
process.on("exit", () => fs.rmSync(T, { recursive: true, force: true }));

const M = path.join(T, "main");
const W = path.join(T, "wt");
const R = path.join(T, "remote.git");
const OUTSIDE = path.join(T, "outside");
const BIN = path.join(T, "bin");
const HOME = path.join(T, "home");
for (const d of [OUTSIDE, BIN, HOME]) fs.mkdirSync(d);
const EMPTY_GITCONFIG = path.join(HOME, "gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");

// The runner's own git variables (set when it runs under a hook that kept
// them) would point the sandbox's git commands back at this repository.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
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
});

function git(cwd, ...args) {
	const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr}`);
	return r.stdout.trim();
}
const remoteRef = (b) => spawnSync("git", ["--git-dir", R, "rev-parse", "--verify", "-q", `refs/heads/${b}`], { env: ENV, encoding: "utf8" }).stdout.trim();

// Stubs. npm logs where it ran and which git variables reached it, and fails
// in a tree holding BROKEN. fnm does nothing, so a real fnm later on PATH
// cannot put a real npm ahead of the stub. node reports .nvmrc's version.
const stub = (name, body) => fs.writeFileSync(path.join(BIN, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
stub("npm", 'printf "npm %s|cwd=%s|GIT_DIR=%s|GIT_WORK_TREE=%s|GIT_INDEX_FILE=%s\\n" "$*" "$(pwd -P)" "${GIT_DIR-}" "${GIT_WORK_TREE-}" "${GIT_INDEX_FILE-}" >> "$STUB_LOG"\n[ -e BROKEN ] && exit 1\nexit 0');
stub("fnm", "exit 0");
stub("node", "echo v22.23.2");

// The sandbox: a main checkout M whose .githooks every worktree uses through
// an ABSOLUTE core.hooksPath, a linked worktree W, and a bare remote R.
git(T, "init", "-q", "--bare", R);
git(T, "init", "-q", "-b", "main", M);
fs.writeFileSync(path.join(M, ".nvmrc"), "22.23.2\n");
fs.mkdirSync(path.join(M, "sub"));
fs.writeFileSync(path.join(M, "sub/file.txt"), "x\n");
git(M, "add", ".");
git(M, "commit", "-q", "-m", "init");
git(M, "remote", "add", "origin", R);
git(M, "worktree", "add", "-q", "-b", "feature", W);
const W_GIT_DIR = git(W, "rev-parse", "--absolute-git-dir");

// Each hook under test gets a hooks directory of its own inside M, so the
// checkout it lives in is always M.
function hooksDir(name, text) {
	const dir = path.join(M, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "pre-push"), text, { mode: 0o755 });
	return dir;
}

let runs = 0;
function calls(log) {
	if (!fs.existsSync(log)) return [];
	return fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("npm ")).map((l) => {
		const [cmd, ...fields] = l.split("|");
		return { cmd, ...Object.fromEntries(fields.map((f) => [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)])) };
	});
}
function push(cwd, hooks, ...args) {
	const log = path.join(T, `npm-${++runs}.log`);
	const r = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "push", ...args], {
		cwd, env: { ...ENV, STUB_LOG: log }, encoding: "utf8", timeout: 30000,
	});
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls: calls(log) };
}
function byHand(hooks, cwd, env = {}) {
	const log = path.join(T, `npm-${++runs}.log`);
	const r = spawnSync("bash", [path.join(hooks, "pre-push")], {
		cwd, env: { ...ENV, ...env, STUB_LOG: log }, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
	});
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, calls: calls(log) };
}
const ranIn = (run, dir) => run.calls.length === 1 && run.calls[0].cmd === "npm run check" && run.calls[0].cwd === dir;
const where = (run) => JSON.stringify(run.calls.map((c) => c.cwd));
const noGitVars = (run) => run.calls.length > 0 && run.calls.every((c) => !c.GIT_DIR && !c.GIT_WORK_TREE && !c.GIT_INDEX_FILE);
const broken = (dir, on) => (on ? fs.writeFileSync(path.join(dir, "BROKEN"), "") : fs.rmSync(path.join(dir, "BROKEN"), { force: true }));

let branchN = 0;
function battery(hooks, tag = "") {
	const r = [];
	const b = `b${++branchN}`;

	// §1 the hook's own checkout is broken, the worktree is clean: it pushes.
	git(W, "commit", "-q", "--allow-empty", "-m", `${b} one`);
	const first = git(W, "rev-parse", "HEAD");
	broken(M, true);
	const clean = push(W, hooks, "-q", "origin", `HEAD:refs/heads/${b}`);
	broken(M, false);
	r.push([clean.code === 0 && ranIn(clean, W), `${tag}§1 a push from a linked worktree checks that worktree, not the hook's own checkout (exit ${clean.code}, checked ${where(clean)}, want ["${W}"])`]);
	r.push([remoteRef(b) === first, `${tag}§1 …and the push lands`]);

	// §1 the worktree is broken, the hook's own checkout is clean: blocked.
	git(W, "commit", "-q", "--allow-empty", "-m", `${b} two`);
	broken(W, true);
	const blocked = push(W, hooks, "-q", "origin", `HEAD:refs/heads/${b}`);
	r.push([blocked.code !== 0 && /push was blocked/.test(blocked.out) && ranIn(blocked, W), `${tag}§1 a broken linked worktree blocks its own push (exit ${blocked.code}, checked ${where(blocked)})`]);
	r.push([remoteRef(b) === first, `${tag}§1 …and the remote keeps its old commit`]);
	r.push([noGitVars(clean) && noGitVars(blocked), `${tag}§5 git's repository variables never reach the check (got ${JSON.stringify(clean.calls.concat(blocked.calls))})`]);

	// §3 deleting a branch runs nothing, even from the broken worktree.
	const deleted = push(W, hooks, "-q", "origin", "--delete", b);
	r.push([deleted.code === 0 && deleted.calls.length === 0 && /only branch deletions/.test(deleted.out) && remoteRef(b) === "",
		`${tag}§3 a push that only deletes a branch runs nothing (exit ${deleted.code}, checked ${where(deleted)})`]);
	broken(W, false);

	// §2 the main checkout still checks itself.
	const fromMain = push(M, hooks, "-q", "origin", `HEAD:refs/heads/${b}-main`);
	r.push([fromMain.code === 0 && ranIn(fromMain, M) && noGitVars(fromMain), `${tag}§2 a push from the main checkout checks the main checkout (exit ${fromMain.code}, checked ${where(fromMain)})`]);

	// §4 by hand.
	const sub = byHand(hooks, path.join(W, "sub"));
	r.push([sub.code === 0 && ranIn(sub, W), `${tag}§4 run by hand in a worktree's subdirectory, it checks that worktree (exit ${sub.code}, checked ${where(sub)})`]);
	const outside = byHand(hooks, OUTSIDE);
	r.push([outside.code === 1 && outside.calls.length === 0 && /not inside a git worktree/.test(outside.out),
		`${tag}§4 run by hand outside any worktree, it refuses and runs nothing (exit ${outside.code}, checked ${where(outside)})`]);
	const vars = byHand(hooks, OUTSIDE, { GIT_DIR: W_GIT_DIR, GIT_WORK_TREE: W, GIT_INDEX_FILE: path.join(W_GIT_DIR, "index") });
	r.push([vars.code === 0 && ranIn(vars, W) && noGitVars(vars),
		`${tag}§4 given git's repository variables, it checks the worktree they name and unsets them before the check (exit ${vars.code}, got ${JSON.stringify(vars.calls)})`]);
	return r;
}

try {
	const real = hooksDir(".githooks", HOOK_TEXT);
	for (const [c, m] of battery(real)) ok(c, m);

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
	mutants.forEach(([name, text], i) => {
		const caught = text !== HOOK_TEXT && battery(hooksDir(`.githooks-mutant-${i + 1}`, text), "[mutant] ").some(([c]) => !c);
		ok(caught, `§6 mutant '${name}' must be caught`);
	});
} catch (e) {
	failures.push(`crashed: ${e.stack || e}`);
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
