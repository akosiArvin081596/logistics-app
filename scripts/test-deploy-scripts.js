#!/usr/bin/env node
/**
 * Runs the REAL scripts/deploy/*.sh against a throwaway git sandbox, the way
 * the workflows run them: each script text is fed to `bash -s` on stdin, which
 * is exactly what ssh does on the VPS.
 *
 * WHY IT EXISTS. These scripts deploy production unattended on every merge.
 * Each property below is a way they could fail silently or by racing:
 *   §1 THE BOX LOCK: two deploys of one directory must never overlap (two
 *      pulls, two installs, two builds into one client/dist). The second fails
 *      fast with exit 75 and changes nothing, and a deploy and a rollback
 *      share the one lock.
 *   §2 EXACT-SHA DEPLOYS: with SHA set the box lands on exactly that commit,
 *      stays on branch main, never moves backwards, and refuses a commit that
 *      main does not contain. Without SHA, REF=main keeps its old meaning.
 *   §3 CHECKED GIT STEPS: a failed pull, fast-forward or checkout fails the
 *      deploy, with nothing rebuilt or restarted.
 *   §4 THE DRIFT MARKER'S THREE WRITERS: the heal prep, an auto-rollback, and a
 *      manual pin. After any of them the drift check must ALARM
 *      (behind-already-attempted), never heal: a rolled-back commit, or main
 *      over a human's pin, is a human's call.
 *   §5 remote-drift-check.sh's four box states, and the heal prep's
 *      compare-and-swap (it refuses when the box moved since the check).
 *   §6 ssh-retry.sh retries ONLY transport failures (255); a remote failure
 *      and the lock's 75 pass straight through. ssh-setup.sh refuses an empty
 *      pinned host key (a file-size test cannot see one).
 *   §7 source pins: the two lock copies are byte-identical, the lock is taken
 *      before anything is touched, every pm2 call closes the lock FD.
 *   §8 mutants: each property above, broken on purpose, must turn this runner
 *      red.
 *   §9 THE NATIVE-MODULE PROBE OPENS A DATABASE. require('better-sqlite3')
 *      passes under an ABI-mismatched Node because the binding loads lazily, on
 *      the first `new Database()`. A module that requires fine but cannot open
 *      a database must trigger the rebuild, in the deploy AND the rollback;
 *      one that still cannot after the rebuild fails the deploy unrestarted.
 *      backup.sh's probe is pinned to the same shape.
 *
 * Hermetic: a mkdtemp sandbox, local git only (the "origin" is a bare repo in
 * the sandbox), and stubbed pm2/npm/curl/ssh. No network, no VPS, no secrets.
 * macOS ships no flock(1): there a perl flock(2) shim stands in (same syscall,
 * same fd-inheritance semantics). CI and the VPS use the real util-linux one.
 *
 * Run: node scripts/test-deploy-scripts.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const DEPLOY_DIR = path.join(__dirname, "deploy");
const readScript = (n) => fs.readFileSync(path.join(DEPLOY_DIR, n), "utf8");
const REAL = {
	deploy: readScript("remote-deploy.sh"),
	rollback: readScript("remote-rollback.sh"),
	check: readScript("remote-drift-check.sh"),
	heal: readScript("remote-drift-heal.sh"),
};

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const record = (results) => results.forEach(([c, m]) => ok(c, m));

// ───────────────────────────────────────────────────────────────── sandbox
const T = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-scripts-"));
const D = {
	origin: path.join(T, "origin.git"),
	seed: path.join(T, "seed"),
	box: path.join(T, "box"),
	bin: path.join(T, "bin"),
	lock: path.join(T, "lock"),
	logs: path.join(T, "logs"),
	home: path.join(T, "home"),
};
for (const d of [D.bin, D.lock, D.logs, D.home]) fs.mkdirSync(d, { recursive: true });
const EMPTY_GITCONFIG = path.join(T, "empty.gitconfig");
fs.writeFileSync(EMPTY_GITCONFIG, "");

// ⚠️ remote-deploy.sh PREPENDS the directory of pm2's interpreter to PATH (that
// is how it builds with the Node pm2 runs the app on). A real Node install
// keeps a real npm beside node, which would shadow the npm stub, run a genuine
// `npm install` in the sandbox and prune it. So the stub pm2 reports an
// interpreter in a directory that holds node and nothing else.
const NODE_DIR = path.join(T, "nodebin");
fs.mkdirSync(NODE_DIR);
fs.symlinkSync(process.execPath, path.join(NODE_DIR, "node"));

const ENV = {
	PATH: `${D.bin}:${NODE_DIR}:${process.env.PATH}`,
	HOME: D.home,
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
	STUB_LOG_DIR: D.logs,
	STUB_NODE: path.join(NODE_DIR, "node"),
	DEPLOY_LOCK_DIR: D.lock,
};

function git(cwd, ...args) {
	const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr}`);
	return r.stdout.trim();
}
const tryGit = (cwd, ...args) => spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });

function writeExec(p, body) {
	fs.writeFileSync(p, body);
	fs.chmodSync(p, 0o755);
}

// Stubs. Each logs what it was asked, which deploy asked (STUB_TAG), and
// whether it inherited the lock's FD 9 — pm2 must NOT.
writeExec(path.join(D.bin, "pm2"), `#!/bin/bash
if [ -e /dev/fd/9 ]; then fd9=open; else fd9=closed; fi
echo "$1 tag=\${STUB_TAG:-} fd9=$fd9 head=$(git rev-parse HEAD 2>/dev/null)" >> "$STUB_LOG_DIR/pm2.log"
case "$1" in
	jlist) printf '[{"name":"%s","pm2_env":{"status":"online","restart_time":1,"exec_interpreter":"%s"}}]' "$PM2" "$STUB_NODE" ;;
esac
exit 0
`);
writeExec(path.join(D.bin, "npm"), `#!/bin/bash
case "$1" in
	--version) echo 10.9.8 ;;
	install)
		echo "install-start tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log"
		if [ -n "\${STUB_HOLD_FILE:-}" ]; then
			n=0; while [ ! -e "$STUB_HOLD_FILE" ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n+1)); done
		fi
		echo "install-end tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log" ;;
	rebuild) echo "rebuild tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log"
	         : > "$STUB_LOG_DIR/bsql-rebuilt" ;;
	run) mkdir -p client/dist && echo "<html></html>" > client/dist/index.html
	     echo "build tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log" ;;
esac
exit 0
`);
writeExec(path.join(D.bin, "curl"), `#!/bin/bash
printf '%s' "\${STUB_HTTP_CODE:-200}"
`);
writeExec(path.join(D.bin, "ssh"), `#!/bin/bash
n=$(cat "$STUB_SSH_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$STUB_SSH_COUNT"
cat > "$STUB_LOG_DIR/ssh-payload.$n"
printf '%s\\n' "$@" > "$STUB_LOG_DIR/ssh-args.$n"
code=$(sed -n "\${n}p" "$STUB_SSH_CODES")
exit "\${code:-0}"
`);
const hasRealFlock = spawnSync("sh", ["-c", "command -v flock"], { env: { PATH: process.env.PATH } }).status === 0;
if (!hasRealFlock) {
	// Implements only the form the scripts use: `flock -n <fd>`. flock(2) on the
	// inherited descriptor, exactly like util-linux: the lock stays with the open
	// file description, so it outlives this process and dies with the shell's FD.
	writeExec(path.join(D.bin, "flock"), `#!/usr/bin/perl
use strict; use Fcntl qw(:flock);
my $nb = 0; my @a = @ARGV;
while (@a && $a[0] =~ /^-/) { my $o = shift @a; $nb = 1 if $o eq '-n' || $o eq '--nonblock'; }
my $fd = shift @a;
die "flock shim: only 'flock [-n] <fd>' is supported\\n" unless defined $fd && $fd =~ /^\\d+$/ && !@a;
open(my $fh, "+<&=", $fd) or die "flock shim: fd $fd: $!\\n";
exit(flock($fh, LOCK_EX | ($nb ? LOCK_NB : 0)) ? 0 : 1);
`);
}

// Repo: main = c1 → c2 → c3, plus a side-branch commit s1 that main never gets.
fs.mkdirSync(D.seed);
git(D.seed, "init", "-q");
git(D.seed, "symbolic-ref", "HEAD", "refs/heads/main");
fs.writeFileSync(path.join(D.seed, ".gitignore"), "node_modules/\nclient/dist/\n.drift-heal-attempted\n");
const commit = (msg) => {
	fs.writeFileSync(path.join(D.seed, "app.txt"), `${msg}\n`);
	git(D.seed, "add", "-A");
	git(D.seed, "commit", "-q", "-m", msg);
	return git(D.seed, "rev-parse", "HEAD");
};
const C1 = commit("c1");
const C2 = commit("c2");
const C3 = commit("c3");
git(D.seed, "checkout", "-q", "-b", "side", C1);
const S1 = commit("s1");
git(D.seed, "checkout", "-q", "main");
git(T, "init", "-q", "--bare", D.origin);
git(D.seed, "remote", "add", "origin", D.origin);
git(D.seed, "push", "-q", "origin", "main", "side");
git(T, "clone", "-q", D.origin, D.box);
// Stub better-sqlite3. Like the real module, require() never touches the native
// binding: only constructing a Database does, which is why a require()-only
// probe passes under the wrong Node. STUB_BSQL picks the behaviour:
//   (unset)    healthy
//   lazy-abi   require() works, construction throws until `npm rebuild` has run
//   broken     require() works, construction always throws
fs.mkdirSync(path.join(D.box, "node_modules", "better-sqlite3"), { recursive: true });
fs.writeFileSync(path.join(D.box, "node_modules", "better-sqlite3", "index.js"), `"use strict";
const fs = require("fs");
const path = require("path");
module.exports = class Database {
	constructor() {
		const mode = process.env.STUB_BSQL || "";
		const rebuilt = fs.existsSync(path.join(process.env.STUB_LOG_DIR || "/nonexistent", "bsql-rebuilt"));
		if (mode === "broken" || (mode === "lazy-abi" && !rebuilt)) {
			throw new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.");
		}
	}
	close() {}
};
`);

const MARKER = path.join(D.box, ".drift-heal-attempted");
const LOCK_FILE = path.join(D.lock, `logisx-deploy${D.box.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
const head = () => git(D.box, "rev-parse", "HEAD");
const onMain = () => tryGit(D.box, "symbolic-ref", "-q", "HEAD").stdout.trim() === "refs/heads/main";
const marker = () => (fs.existsSync(MARKER) ? fs.readFileSync(MARKER, "utf8") : "");
const log = (n) => { const p = path.join(D.logs, `${n}.log`); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; };

function resetBox(sha, { detachAt = null } = {}) {
	git(D.box, "checkout", "-q", "main");
	git(D.box, "reset", "-q", "--hard", sha);
	if (detachAt) git(D.box, "checkout", "-q", "--detach", detachAt);
	fs.rmSync(MARKER, { force: true });
	for (const f of fs.readdirSync(D.logs)) fs.rmSync(path.join(D.logs, f), { force: true });
}

function runSh(text, env = {}) {
	const r = spawnSync("bash", ["-s"], { cwd: T, input: text, env: { ...ENV, ...env }, encoding: "utf8", timeout: 60000 });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
const deployEnv = (extra) => ({ DIR: D.box, PM2: "logistics-app", REF: "main", ...extra });
const field = (out, k) => { const m = new RegExp(`^${k}=(.*)$`, "m").exec(out); return m ? m[1].trim() : ""; };

async function waitFor(pred, ms, what) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ───────────────────────────────────────────────── §1 the box lock (async)
async function lockScenario(S, tag = "") {
	const r = [];
	resetBox(C1);
	const hold = path.join(T, `release-${Math.random().toString(36).slice(2)}`);
	const A = spawn("bash", ["-s"], { cwd: T, env: { ...ENV, ...deployEnv({ SHA: C2, STUB_TAG: "A", STUB_HOLD_FILE: hold }) } });
	let aOut = "";
	A.stdout.on("data", (c) => (aOut += c));
	A.stderr.on("data", (c) => (aOut += c));
	const aDone = new Promise((res) => A.on("close", (code) => res(code)));
	A.stdin.end(S.deploy);
	let aExited = null;
	aDone.then((code) => (aExited = code));
	try {
		await waitFor(() => /install-start tag=A/.test(log("npm")) || aExited !== null, 20000, "deploy A to reach npm install");
		if (!/install-start tag=A/.test(log("npm"))) {
			throw new Error(`deploy A exited (${aExited}) before reaching npm install:\n${aOut}`);
		}
		const B = runSh(S.deploy, deployEnv({ SHA: C2, STUB_TAG: "B" }));
		const R = runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: C1, STUB_TAG: "R" });
		r.push([B.code === 75, `${tag}§1 a second deploy while one runs must exit 75 (got ${B.code})`]);
		r.push([/lock .* is held/.test(B.out) && B.out.includes(LOCK_FILE), `${tag}§1 the refusal names the held lock file`]);
		r.push([/lock holder: pid=\d+ since=\S+ by=remote-deploy\.sh ref=main sha=/.test(B.out), `${tag}§1 the refusal says who holds it`]);
		r.push([!/current HEAD:/.test(B.out), `${tag}§1 the refused deploy never reached the repo`]);
		r.push([R.code === 75, `${tag}§1 a ROLLBACK during a deploy is refused too — one lock for both (got ${R.code})`]);
		r.push([!/tag=[BR]\b/.test(log("npm") + log("pm2")), `${tag}§1 the refused runs installed, built and restarted nothing`]);
	} finally {
		fs.writeFileSync(hold, "");
	}
	const aCode = await aDone;
	r.push([aCode === 0 && head() === C2, `${tag}§1 the lock holder finishes normally (code ${aCode}, HEAD ${head().slice(0, 7)})`]);
	const C = runSh(S.deploy, deployEnv({ SHA: C2, STUB_TAG: "C" }));
	r.push([C.code === 0, `${tag}§1 the lock is released when the holder exits (next deploy got ${C.code})`]);
	r.push([fs.existsSync(LOCK_FILE) && !LOCK_FILE.startsWith(D.box + path.sep), `${tag}§1 the lock file lives outside the repo tree`]);
	return r;
}

// ─────────────────────────────────────── §2/§3 exact-SHA deploys, checked git
// Named cases, so a mutant re-runs only the case that targets it.
const PIN_CASES = {
	exact(S, tag) {
		const r = [];
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_TAG: "p" }));
		r.push([x.code === 0 && head() === C2, `${tag}§2 SHA=c2 with origin/main at c3 lands on EXACTLY c2 (code ${x.code}, HEAD ${head().slice(0, 7)})`]);
		r.push([onMain(), `${tag}§2 an exact-SHA deploy stays on branch main (not detached)`]);
		r.push([field(x.out, "DEPLOYED_FROM") === C1 && field(x.out, "DEPLOYED_TO") === C2, `${tag}§2 DEPLOYED_FROM/TO report c1 → c2 (the rollback target is read from this)`]);
		r.push([/^restart tag=p fd9=closed/m.test(log("pm2")), `${tag}§7 pm2 restart runs with the lock FD CLOSED (a pm2 daemon spawned with it would hold the lock forever)`]);
		r.push([!/fd9=open/.test(log("pm2")), `${tag}§7 no pm2 call inherits the lock FD`]);
		return r;
	},
	tip(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({}));
		return [[x.code === 0 && head() === C3, `${tag}§2 without SHA, REF=main still means origin/main's tip (HEAD ${head().slice(0, 7)})`]];
	},
	noop(S, tag) {
		resetBox(C3);
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [
			[x.code === 0 && field(x.out, "DEPLOY_NOOP") === "1" && head() === C3, `${tag}§2 a newer main commit is live → no-op, never backwards (code ${x.code}, HEAD ${head().slice(0, 7)})`],
			[!/restart/.test(log("pm2")) && !/install/.test(log("npm")), `${tag}§2 the no-op restarts and installs nothing`],
			[field(x.out, "DEPLOYED_FROM") === C3, `${tag}§2 the no-op still reports DEPLOYED_FROM for the smoke/rollback steps`],
		];
	},
	redeploy(S, tag) {
		resetBox(C2);
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code === 0 && head() === C2 && /restart/.test(log("pm2")), `${tag}§2 re-deploying the live SHA rebuilds and restarts it (what a re-run is for)`]];
	},
	offMain(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: S1 }));
		return [
			[x.code !== 0 && /not on origin\/main/.test(x.out) && head() === C1, `${tag}§2 a commit main does not contain is refused, box untouched (code ${x.code})`],
			[!/restart/.test(log("pm2")), `${tag}§2 …and nothing is restarted`],
		];
	},
	badInput(S, tag) {
		resetBox(C1);
		const a = runSh(S.deploy, deployEnv({ SHA: C2.slice(0, 7) }));
		const b = runSh(S.deploy, deployEnv({ REF: "side", SHA: C2 }));
		return [
			[a.code === 1 && /full 40-character/.test(a.out) && head() === C1, `${tag}§2 an abbreviated SHA is refused`],
			[b.code === 1 && /REF must be main/.test(b.out) && head() === C1, `${tag}§2 SHA with REF other than main is refused`],
		];
	},
	mainAhead(S, tag) {
		// Local main already past SHA while HEAD is detached elsewhere: the ff would
		// "succeed" on the wrong commit. Must refuse BEFORE moving HEAD.
		resetBox(C3, { detachAt: C1 });
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code !== 0 && head() === C1, `${tag}§2 local main past SHA → refused with HEAD unmoved (code ${x.code}, HEAD ${head().slice(0, 7)})`]];
	},
	pullFails(S, tag) {
		// §3 a failed pull must fail the deploy, with nothing rebuilt or restarted.
		resetBox(C1);
		fs.writeFileSync(path.join(D.box, "app.txt"), "box-only\n");
		git(D.box, "commit", "-q", "-am", "diverged on the box");
		const diverged = head();
		const x = runSh(S.deploy, deployEnv({}));
		return [
			[x.code !== 0 && /could not fast-forward/.test(x.out), `${tag}§3 a failed pull FAILS the deploy (code ${x.code})`],
			[head() === diverged && !/restart/.test(log("pm2")), `${tag}§3 …and does not restart the old commit as if it were new`],
		];
	},
	unknownRef(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ REF: "no-such-ref" }));
		return [[x.code !== 0 && /cannot check out/.test(x.out) && !/restart/.test(log("pm2")), `${tag}§3 an unknown ref fails instead of redeploying the current commit`]];
	},
	hotfix(S, tag) {
		resetBox(C1);
		fs.writeFileSync(path.join(D.box, "app.txt"), "hand-applied hotfix\n");
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		git(D.box, "checkout", "--", "app.txt");
		return [[x.code === 1 && /local modifications/.test(x.out) && head() === C1, `${tag}§3 a hand-applied hotfix is still never deployed over`]];
	},
};

// ─────────────────────────── §4/§5 marker writers, drift check, heal prep
const checkState = (S, env = {}) => field(runSh(S.check, { DIR: D.box, PM2: "logistics-app", ...env }).out, "DRIFT_STATE");
const DRIFT_CASES = {
	checkStates(S, tag) {
		const r = [];
		resetBox(C3);
		r.push([checkState(S) === "in-sync", `${tag}§5 box at origin/main → in-sync`]);
		resetBox(C2);
		r.push([checkState(S) === "behind-healable", `${tag}§5 behind + serving + no marker → behind-healable (the box's view)`]);
		fs.writeFileSync(MARKER, C3);
		r.push([checkState(S) === "behind-already-attempted", `${tag}§5 marker = main → behind-already-attempted`]);
		fs.writeFileSync(MARKER, C1);
		r.push([checkState(S, { STUB_HTTP_CODE: "503" }) === "behind-and-unhealthy", `${tag}§5 behind + not serving → behind-and-unhealthy`]);
		return r;
	},
	healPrep(S, tag) {
		// Heal prep: compare-and-swap against what the check saw.
		const r = [];
		let x;
		resetBox(C2);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2 });
		r.push([x.code === 0 && field(x.out, "HEAL_READY") === "yes" && marker() === C3, `${tag}§5 heal prep: box as the check saw it → ready, marker = target`]);
		x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && head() === C3 && checkState(S) === "in-sync", `${tag}§5 the heal's exact-SHA deploy brings the box in sync`]);
		resetBox(C2);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C1 });
		r.push([field(x.out, "HEAL_READY") === "no" && marker() === "", `${tag}§5 heal prep: the box moved since the check → not ready, NO marker written`]);
		fs.writeFileSync(MARKER, C3);
		x = runSh(S.heal, { DIR: D.box, TARGET: C3, EXPECT: C2 });
		r.push([field(x.out, "HEAL_READY") === "no", `${tag}§5 heal prep: already attempted → not ready`]);
		fs.rmSync(MARKER, { force: true });
		x = runSh(S.heal, { DIR: D.box, TARGET: S1, EXPECT: C2 });
		r.push([field(x.out, "HEAL_READY") === "no" && marker() === "", `${tag}§5 heal prep: a target main does not contain → not ready`]);
		return r;
	},
	rollbackMarker(S, tag) {
		// §4 writer 2: an auto-rollback records the rejected commit; drift must
		// alarm, and never deploy it again by itself.
		const r = [];
		resetBox(C2);
		runSh(S.deploy, deployEnv({ SHA: C3 }));
		const x = runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: C2 });
		r.push([x.code === 0 && /ROLLBACK OK/.test(x.out) && head() === C2, `${tag}§4 rollback returns the box to PREV (code ${x.code})`]);
		r.push([marker() === C3, `${tag}§4 rollback records the REJECTED commit in the drift marker (got '${marker().slice(0, 7)}')`]);
		r.push([checkState(S) === "behind-already-attempted", `${tag}§4 after an auto-rollback the drift check ALARMS, it does not re-deploy the rejected commit`]);
		r.push([/^restart tag= fd9=closed/m.test(log("pm2")), `${tag}§7 the rollback's pm2 restart closes the lock FD too`]);
		return r;
	},
	manualPin(S, tag) {
		// §4 writer 3: a manual pin off main (the documented rollback path).
		const r = [];
		resetBox(C3);
		let x = runSh(S.deploy, deployEnv({ REF: C1 }));
		r.push([x.code === 0 && head() === C1 && !onMain(), `${tag}§4 a manual REF=<sha> deploy pins the box, detached (code ${x.code})`]);
		r.push([marker() === C3, `${tag}§4 a manual pin records main's tip in the drift marker`]);
		r.push([checkState(S) === "behind-already-attempted", `${tag}§4 drift ALARMS over a manual pin; it never deploys main over it by itself`]);
		x = runSh(S.deploy, deployEnv({ SHA: C3 }));
		r.push([x.code === 0 && head() === C3 && onMain() && checkState(S) === "in-sync", `${tag}§4 deploying main again ends the pin`]);
		return r;
	},
};
const runCases = (cases, S, tag = "") => Object.values(cases).flatMap((fn) => fn(S, tag));

// ─────────────────────────────────── §9 the native-module probe opens a DB
// Measured on the VPS 2026-09-19: /usr/bin/node v20 passes
// require('better-sqlite3') and fails `new Database()`. A probe that only
// requires the module therefore waves a wrong-ABI build through to a restart
// that dies on boot.
const PROBE_CASES = {
	healthy(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2 }));
		return [[x.code === 0 && !/rebuild/.test(log("npm")), `${tag}§9 a module that opens a database is not rebuilt (code ${x.code})`]];
	},
	lazyAbi(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_BSQL: "lazy-abi" }));
		return [
			[/rebuild/.test(log("npm")) && /native ABI mismatch detected/.test(x.out), `${tag}§9 require() OK but new Database() throws → the deploy REBUILDS better-sqlite3`],
			[x.code === 0 && head() === C2 && /restart/.test(log("pm2")), `${tag}§9 …and once rebuilt it builds and restarts normally (code ${x.code})`],
		];
	},
	stillBroken(S, tag) {
		resetBox(C1);
		const x = runSh(S.deploy, deployEnv({ SHA: C2, STUB_BSQL: "broken" }));
		return [[x.code !== 0 && /still fails to load after rebuild/.test(x.out) && !/restart/.test(log("pm2")),
			`${tag}§9 still unable to open a database after the rebuild → the deploy fails and restarts nothing (code ${x.code})`]];
	},
	rollbackLazyAbi(S, tag) {
		resetBox(C2);
		const x = runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: C1, STUB_BSQL: "lazy-abi" });
		return [[x.code === 0 && /rebuild/.test(log("npm")), `${tag}§9 the rollback's probe opens a database too: require() OK + construction throws → rebuild (code ${x.code})`]];
	},
};

// The probe's exact text, shared by the static pin and the mutants below.
const DB_PROBE = `node -e "new (require('better-sqlite3'))(':memory:').close()"`;
const REQUIRE_ONLY_PROBE = `node -e "require('better-sqlite3')"`;
function probePins() {
	const scripts = [
		["remote-deploy.sh", REAL.deploy],
		["remote-rollback.sh", REAL.rollback],
		["backup.sh", fs.readFileSync(path.join(__dirname, "..", "backup.sh"), "utf8")],
	];
	for (const [name, text] of scripts) {
		// Every `-e '...require(better-sqlite3)...'` line outside a comment is a
		// capability probe, whichever quote style it uses.
		const probes = text.split("\n").filter((l) => !/^\s*#/.test(l) && /-e\s+["'][^"']*require\(\s*["']better-sqlite3["']\s*\)/.test(l));
		const opens = probes.filter((l) => /new \(require\(\s*["']better-sqlite3["']\s*\)\)\(\s*["']:memory:["']\s*\)\.close\(\)/.test(l));
		ok(probes.length > 0 && opens.length === probes.length,
			`§9 every better-sqlite3 probe in ${name} opens a database, not just require()s it (${opens.length} of ${probes.length})`);
	}
	ok(REAL.deploy.split(DB_PROBE).length - 1 === 2 && REAL.rollback.split(DB_PROBE).length - 1 === 1,
		"§9 the deploy probes before and after its rebuild, the rollback once — all with the same text the mutants swap");
}

// ───────────────────────────────────────── §6 runner-side ssh helpers
function sshScenarios() {
	const retry = path.join(DEPLOY_DIR, "ssh-retry.sh");
	const runRetry = (codes, backoff) => {
		for (const f of fs.readdirSync(D.logs)) fs.rmSync(path.join(D.logs, f), { force: true });
		const codesFile = path.join(T, "ssh-codes");
		const countFile = path.join(T, "ssh-count");
		fs.writeFileSync(codesFile, codes.join("\n") + "\n");
		fs.rmSync(countFile, { force: true });
		const env = { ...ENV, STUB_SSH_CODES: codesFile, STUB_SSH_COUNT: countFile };
		if (backoff !== undefined) env.SSH_RETRY_BACKOFF = backoff;
		const r = spawnSync("bash", [retry, "root@203.0.113.9", "DIR='/x' bash -s"], { input: "echo payload\nexit 0", env, encoding: "utf8", timeout: 30000 });
		const n = Number((fs.existsSync(countFile) && fs.readFileSync(countFile, "utf8").trim()) || 0);
		const payloads = Array.from({ length: n }, (_, i) => fs.readFileSync(path.join(D.logs, `ssh-payload.${i + 1}`), "utf8"));
		const args = n ? fs.readFileSync(path.join(D.logs, "ssh-args.1"), "utf8") : "";
		return { code: r.status, out: `${r.stdout}${r.stderr}`, n, payloads, args };
	};
	let x = runRetry([255, 255, 0], "0 0 0 0");
	ok(x.code === 0 && x.n === 3, `§6 ssh-retry: two transport failures then success → exit 0 after 3 attempts (code ${x.code}, n ${x.n})`);
	ok(x.payloads.every((p) => p === "echo payload\nexit 0"), "§6 ssh-retry: the full payload is replayed on every attempt");
	ok(/root@203\.0\.113\.9/.test(x.args) && /DIR='\/x' bash -s/.test(x.args) && /deploy_key/.test(x.args), "§6 ssh-retry: destination, remote command and the deploy key are passed to ssh");
	x = runRetry([3], "0 0 0 0");
	ok(x.code === 3 && x.n === 1, `§6 ssh-retry: a REMOTE failure passes straight through, no retry (code ${x.code}, n ${x.n})`);
	x = runRetry([75], "0 0 0 0");
	ok(x.code === 75 && x.n === 1, `§6 ssh-retry: the lock's 75 is NOT retried (code ${x.code}, n ${x.n})`);
	x = runRetry([255, 255, 255], "0 0");
	ok(x.code === 255 && x.n === 3 && /after 3 attempts/.test(x.out), `§6 ssh-retry: gives up after backoff+1 attempts with exit 255 (code ${x.code}, n ${x.n})`);
	ok(/SSH_RETRY_BACKOFF-15 30 60 90\}/.test(fs.readFileSync(retry, "utf8")), "§6 ssh-retry: the production budget is still 5 attempts over 15/30/60/90 s (sized from a measured outage)");

	const setup = path.join(DEPLOY_DIR, "ssh-setup.sh");
	const home2 = fs.mkdtempSync(path.join(T, "home-"));
	const runSetup = (key, known) => spawnSync("bash", [setup], { env: { PATH: ENV.PATH, HOME: home2, VPS_SSH_KEY: key, VPS_SSH_KNOWN_HOSTS: known }, encoding: "utf8" });
	let s = runSetup("KEY", "");
	ok(s.status === 1 && /VPS_SSH_KNOWN_HOSTS is empty/.test(s.stdout + s.stderr), "§6 ssh-setup: an EMPTY pinned host key is refused (a file-size test cannot see one)");
	s = runSetup("KEY", " \n\t ");
	ok(s.status === 1, "§6 ssh-setup: a whitespace-only host key is refused too");
	s = runSetup("", "203.0.113.9 ssh-ed25519 AAAA");
	ok(s.status === 1 && /VPS_SSH_KEY is empty/.test(s.stdout + s.stderr), "§6 ssh-setup: an empty deploy key is refused");
	s = runSetup("KEY", "203.0.113.9 ssh-ed25519 AAAA");
	const kf = path.join(home2, ".ssh", "known_hosts");
	const df = path.join(home2, ".ssh", "deploy_key");
	ok(s.status === 0 && fs.readFileSync(kf, "utf8") === "203.0.113.9 ssh-ed25519 AAAA\n" && fs.readFileSync(df, "utf8") === "KEY\n", "§6 ssh-setup: writes the key and the pinned host key");
	ok((fs.statSync(df).mode & 0o777) === 0o600 && (fs.statSync(kf).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(kf)).mode & 0o777) === 0o700, "§6 ssh-setup: 600 files in a 700 directory");
}

// ─────────────────────────────────────────────────────────── §7 source pins
function lockBlock(text) {
	const a = text.indexOf("# >>> deploy-lock");
	const b = text.indexOf("# <<< deploy-lock");
	return a >= 0 && b > a ? text.slice(a, b) : null;
}
function sourcePins() {
	const ld = lockBlock(REAL.deploy);
	const lr = lockBlock(REAL.rollback);
	ok(ld && lr && ld === lr, "§7 the deploy-lock block is byte-identical in remote-deploy.sh and remote-rollback.sh");
	for (const [name, text] of [["remote-deploy.sh", REAL.deploy], ["remote-rollback.sh", REAL.rollback]]) {
		const lockAt = text.indexOf("# >>> deploy-lock");
		const cdAt = text.indexOf('cd "$DIR"');
		ok(lockAt > 0 && cdAt > lockAt, `§7 ${name} takes the lock before it touches the repo`);
		const pm2Lines = text.split("\n").filter((l) => /^\s*[^#]*\bpm2 (restart|jlist|start|reload)\b/.test(l));
		ok(pm2Lines.length > 0 && pm2Lines.every((l) => /9>&-/.test(l)), `§7 every pm2 call in ${name} closes the lock FD (9>&-)`);
		const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
		ok(!/pm2 (restart|reload|stop|delete) all\b/.test(code), `§7 ${name} never restarts ALL pm2 processes (23 other clients share the box)`);
	}
	ok(REAL.deploy.indexOf("SHA must be a full") < REAL.deploy.indexOf("# >>> deploy-lock"), "§7 SHA is validated before the lock is even taken");
	for (const [name, text] of Object.entries(REAL)) {
		ok(/\.drift-heal-attempted/.test(text), `§7 ${name} uses the one marker filename, .drift-heal-attempted`);
	}
	const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
	ok(/^\.drift-heal-attempted$/m.test(gi), "§7 the marker stays gitignored (the dirty-tree check must not trip on it)");
}

// ──────────────────────────────────────────────────────────────── §8 mutants
async function mutants() {
	const swap = (text, from, to) => {
		const out = text.split(from).join(to);
		ok(out !== text, `§8 mutant source must change — update the mutant if the code moved (${from.slice(0, 40)}…)`);
		return out;
	};
	// Remove the locking but keep the script runnable (it echoes $LOCK_FILE later).
	const cut = (text) => {
		const a = text.indexOf("# >>> deploy-lock");
		const b = text.indexOf("# <<< deploy-lock");
		return `${text.slice(0, a)}LOCK_FILE="(no lock)"\n${text.slice(b)}`;
	};
	const expectCaught = (name, results) => ok(results.some(([c]) => !c), `§8 mutant '${name}' must be caught`);

	const M = "[mutant] ";
	expectCaught("no box lock", await lockScenario({ ...REAL, deploy: cut(REAL.deploy), rollback: cut(REAL.rollback) }, M));
	expectCaught("SHA ignored", PIN_CASES.exact({ ...REAL, deploy: swap(REAL.deploy, 'if [ -n "$SHA" ]; then\n\tif ! git cat-file', 'if false; then\n\tif ! git cat-file') }, M));
	expectCaught("no-op check removed (deploys backwards)", PIN_CASES.noop({ ...REAL, deploy: swap(REAL.deploy, '[ "$SHA" != "$PREV" ] && git merge-base', 'false && git merge-base') }, M));
	expectCaught("failed pull ignored", PIN_CASES.pullFails({
		...REAL,
		deploy: swap(REAL.deploy, "if ! { git checkout main && git pull --ff-only origin main 9>&-; }; then", "if ! { git checkout main && git pull --ff-only origin main 9>&- || true; }; then"),
	}, M));
	expectCaught("pm2 inherits the lock FD", PIN_CASES.exact({ ...REAL, deploy: swap(REAL.deploy, 'pm2 restart "$PM2" --silent 9>&-', 'pm2 restart "$PM2" --silent') }, M));
	expectCaught("rollback leaves no marker", DRIFT_CASES.rollbackMarker({ ...REAL, rollback: swap(REAL.rollback, 'printf \'%s\' "$FAILED" > "$DIR/.drift-heal-attempted"', "true") }, M));
	expectCaught("manual pin leaves no marker", DRIFT_CASES.manualPin({ ...REAL, deploy: swap(REAL.deploy, 'printf \'%s\' "$PIN_MAIN" > "$DIR/.drift-heal-attempted"', "true") }, M));
	expectCaught("heal prep skips its compare-and-swap", DRIFT_CASES.healPrep({ ...REAL, heal: swap(REAL.heal, '[ "$NOW" = "$EXPECT" ] ||', "true ||") }, M));
	expectCaught("deploy probe only require()s the module (passes under the wrong Node)", PROBE_CASES.lazyAbi({ ...REAL, deploy: swap(REAL.deploy, DB_PROBE, REQUIRE_ONLY_PROBE) }, M));
	expectCaught("rollback probe only require()s the module", PROBE_CASES.rollbackLazyAbi({ ...REAL, rollback: swap(REAL.rollback, DB_PROBE, REQUIRE_ONLY_PROBE) }, M));
	expectCaught("deploy restarts even when the rebuild did not help", PROBE_CASES.stillBroken({
		...REAL,
		deploy: swap(REAL.deploy, `|| { echo "::error::better-sqlite3 still fails to load after rebuild"; exit 1; }`, `|| echo "better-sqlite3 still fails to load after rebuild"`),
	}, M));
}

(async () => {
	console.log(`flock: ${hasRealFlock ? "real flock(1) from PATH" : "perl flock(2) shim (no flock(1) on this machine)"}`);
	record(await lockScenario(REAL));
	record(runCases(PIN_CASES, REAL));
	record(runCases(DRIFT_CASES, REAL));
	record(runCases(PROBE_CASES, REAL));
	sshScenarios();
	sourcePins();
	probePins();
	await mutants();
})()
	.catch((err) => failures.push(`runner crashed: ${err && err.stack ? err.stack : err}`))
	.finally(() => {
		fs.rmSync(T, { recursive: true, force: true });
		console.log(`\n${"=".repeat(64)}`);
		if (failures.length) {
			console.log(`FAILURES (${failures.length}):`);
			failures.forEach((f) => console.log(`  ✗ ${f}`));
			console.log(`\n${pass} passed, ${failures.length} failed`);
			process.exit(1);
		}
		console.log(`✓ ${pass} assertions passed`);
	});
