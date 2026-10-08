/**
 * The throwaway deploy sandbox shared by scripts/test-deploy-scripts.js,
 * scripts/test-deploy-record.js and scripts/test-deploy-live.js. NOT a runner
 * itself (the unit-test glob takes only scripts/test-*.js and check-*.js):
 * each runner requires it and gets its own sandbox, so each keeps its own 60 s
 * budget (test-deploy-scripts.js gets one per worker process).
 *
 * On require it builds, in a mkdtemp directory: a bare "origin" with main =
 * c1 → c2 → c3 plus a side commit s1, a "box" clone of it, stub
 * pm2/npm/curl/ssh (and a perl flock(2) shim where flock(1) is missing), and a
 * stub better-sqlite3. No network, no VPS, no secrets. finish() removes it and
 * reports.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEPLOY_DIR = path.join(__dirname, "deploy");
const readScript = (n) => fs.readFileSync(path.join(DEPLOY_DIR, n), "utf8");
const REAL = {
	deploy: readScript("remote-deploy.sh"),
	rollback: readScript("remote-rollback.sh"),
	check: readScript("remote-drift-check.sh"),
	heal: readScript("remote-drift-heal.sh"),
	record: readScript("remote-record-verified.sh"),
};

const SMOKE = readScript("remote-smoke.sh");

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
// …and that interpreter lives OFF the PATH, so a script that builds with
// PATH's `node` instead of pm2's interpreter can be told apart (on the box,
// PATH's node is the system Node 20, pm2's is /opt/node22).
const INTERP_DIR = path.join(T, "interp");
fs.mkdirSync(INTERP_DIR);
fs.symlinkSync(process.execPath, path.join(INTERP_DIR, "node"));

// macOS's /usr/bin/git is xcrun's shim, which looks the real binary up on every
// call: about 10 ms a call against 4 ms (measured 2026-10-08), and a run of
// test-deploy-scripts.js makes some 1,900. So on macOS the sandbox puts a link
// to the real binary first on its PATH. Elsewhere (CI, the VPS) git on PATH
// already is the real one, and nothing changes.
const GIT_DIR = path.join(T, "gitbin");
function realGitDir() {
	if (process.platform !== "darwin") return "";
	const r = spawnSync("xcrun", ["--find", "git"], { encoding: "utf8" });
	const real = r.status === 0 ? r.stdout.trim() : "";
	if (!real || !fs.existsSync(real)) return "";
	fs.mkdirSync(GIT_DIR);
	fs.symlinkSync(real, path.join(GIT_DIR, "git"));
	return `${GIT_DIR}:`;
}

const ENV = {
	PATH: `${D.bin}:${realGitDir()}${NODE_DIR}:${process.env.PATH}`,
	HOME: D.home,
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG,
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
	STUB_LOG_DIR: D.logs,
	STUB_NODE: path.join(INTERP_DIR, "node"),
	DEPLOY_LOCK_DIR: D.lock,
	// The bounded wait for a held lock (remote-deploy.sh's deploy-lock block),
	// short here so a contender that must give up does so quickly. Cases that
	// prove the wait succeeds set their own.
	DEPLOY_LOCK_WAIT_S: "1",
};

function git(cwd, ...args) {
	const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr}`);
	return r.stdout.trim();
}
const tryGit = (cwd, ...args) => spawnSync("git", args, { cwd, env: ENV, encoding: "utf8" });

// ⚠️ macOS assesses every NEW executable file the first time it runs: ~80 ms
// each, and seconds when several processes write theirs at once. So a stub is
// not an executable of its own. writeExec(p, body) writes the body as a plain
// file, .stubs/<name> beside p, and makes p a link to ONE executable,
// STUB_EXEC, which runs the body named like the link: a bash body in its own
// process (STUB_EXEC's), any other through its #! interpreter. The worker
// processes of test-deploy-scripts.js all link to the one their parent wrote
// (DEPLOY_TEST_STUB_EXEC); any other runner writes its own.
const STUB_EXEC = process.env.DEPLOY_TEST_STUB_EXEC || path.join(T, "stub-exec");
if (!process.env.DEPLOY_TEST_STUB_EXEC) fs.writeFileSync(STUB_EXEC, `#!/bin/bash
__stub_body="\${0%/*}/.stubs/\${0##*/}"
IFS= read -r __stub_first < "$__stub_body"
case "$__stub_first" in
	"#!/bin/bash") . "$__stub_body" ;;
	*) exec \${__stub_first#"#!"} "$__stub_body" "$@" ;;
esac
`, { mode: 0o755 });
function writeExec(p, body) {
	const stubs = path.join(path.dirname(p), ".stubs");
	fs.mkdirSync(stubs, { recursive: true });
	fs.writeFileSync(path.join(stubs, path.basename(p)), body);
	fs.symlinkSync(STUB_EXEC, p);
}

// Stubs. Each logs what it was asked, which deploy asked (STUB_TAG), and
// whether it inherited the lock's FD 9 — pm2 must NOT. STUB_PM2_STATUS is the
// process status jlist reports (default online). jlist lists another tenant's
// process FIRST, as the shared box does, so only a lookup by name finds ours.
// Our process's pm_uptime lives in $STUB_LOG_DIR/pm2-uptime (1000 after every
// reset, which clears that directory), and a restart moves it on by one. The
// two ways a restart can fail to take, independently: STUB_PM2_RESTART_NOOP
// leaves pm_uptime where it was, STUB_PM2_RESTART_RC is the restart's exit code.
// STUB_PM2_JLIST_NOISE prints the notice pm2's CLI puts on stdout, ahead of
// the JSON, when its daemon is older than the CLI. STUB_PM2_MISSING leaves our
// process out of jlist altogether.
writeExec(path.join(D.bin, "pm2"), `#!/bin/bash
if [ -e /dev/fd/9 ]; then fd9=open; else fd9=closed; fi
echo "$1 tag=\${STUB_TAG:-} fd9=$fd9 head=$(git rev-parse HEAD 2>/dev/null)" >> "$STUB_LOG_DIR/pm2.log"
up=$(cat "$STUB_LOG_DIR/pm2-uptime" 2>/dev/null || echo 1000)
case "$1" in
	jlist)
		if [ -n "\${STUB_PM2_JLIST_NOISE:-}" ]; then
			printf '>>>> In-memory PM2 is out-of-date, do:\\n>>>> $ pm2 update\\nIn memory PM2 version: 5.3.0\\nLocal PM2 version: 6.0.8\\n'
		fi
		other='{"name":"other-tenant","pm2_env":{"status":"online","pm_uptime":5,"restart_time":0,"exec_interpreter":"/nonexistent/other-tenant/node"}}'
		if [ -n "\${STUB_PM2_MISSING:-}" ]; then printf '[%s]' "$other"; exit 0; fi
		printf '[%s,{"name":"%s","pm2_env":{"status":"%s","pm_uptime":%s,"restart_time":1,"exec_interpreter":"%s"}}]' "$other" "$PM2" "\${STUB_PM2_STATUS:-online}" "$up" "$STUB_NODE" ;;
	restart)
		# STUB_PM2_RESTART_NOOP=once: only the first restart since the last reset.
		noop="\${STUB_PM2_RESTART_NOOP:-}"
		if [ "$noop" = once ]; then
			if [ -e "$STUB_LOG_DIR/pm2-noop-used" ]; then noop=""; else : > "$STUB_LOG_DIR/pm2-noop-used"; fi
		fi
		[ -n "$noop" ] || echo $((up + 1)) > "$STUB_LOG_DIR/pm2-uptime"
		exit "\${STUB_PM2_RESTART_RC:-0}" ;;
esac
exit 0
`);
// STUB_INSTALL_FAIL: install exits 1. STUB_BUILD_FAIL: the build dies part-way
// (exit 1, client/dist removed; =keep leaves an existing client/dist alone).
// STUB_BUILD_EMPTY: the build exits 0 and leaves no index.html.
writeExec(path.join(D.bin, "npm"), `#!/bin/bash
case "$1" in
	--version) echo 10.9.8 ;;
	install)
		echo "install-start tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log"
		if [ -n "\${STUB_HOLD_FILE:-}" ]; then
			n=0; while [ ! -e "$STUB_HOLD_FILE" ] && [ $n -lt 600 ]; do sleep 0.05; n=$((n+1)); done
		fi
		if [ -n "\${STUB_INSTALL_FAIL:-}" ]; then
			echo "install-failed tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log"
			exit 1
		fi
		echo "install-end tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log" ;;
	rebuild) echo "rebuild tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log"
	         : > "$STUB_LOG_DIR/bsql-rebuilt" ;;
	run) if [ -n "\${STUB_BUILD_FAIL:-}" ]; then
	         # A build that dies part-way: the old bundle is gone, nothing new.
	         [ "$STUB_BUILD_FAIL" = keep ] || rm -rf client/dist
	         echo "build-failed tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log"
	         exit 1
	     fi
	     if [ -n "\${STUB_BUILD_EMPTY:-}" ]; then
	         rm -rf client/dist
	         echo "build-empty tag=\${STUB_TAG:-}" >> "$STUB_LOG_DIR/npm.log"
	         exit 0
	     fi
	     mkdir -p client/dist && echo "<html></html>" > client/dist/index.html
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
	// Implements only the forms the scripts use: `flock -n <fd>` and
	// `flock -w <seconds> <fd>`. flock(2) on the inherited descriptor, exactly
	// like util-linux: the lock stays with the open file description, so it
	// outlives this process and dies with the shell's FD. -w retries a
	// non-blocking flock until the timeout, then exits 1, as util-linux does.
	writeExec(path.join(D.bin, "flock"), `#!/usr/bin/perl
use strict; use Fcntl qw(:flock); use Time::HiRes qw(time sleep);
my $nb = 0; my $wait; my @a = @ARGV;
while (@a && $a[0] =~ /^-/) {
	my $o = shift @a;
	if ($o eq '-n' || $o eq '--nonblock') { $nb = 1; }
	elsif ($o eq '-w' || $o eq '--timeout') { $wait = shift @a; }
	else { die "flock shim: unsupported option $o\\n"; }
}
my $fd = shift @a;
die "flock shim: only 'flock [-n | -w <s>] <fd>' is supported\\n" unless defined $fd && $fd =~ /^\\d+$/ && !@a;
open(my $fh, "+<&=", $fd) or die "flock shim: fd $fd: $!\\n";
if (defined $wait) {
	my $end = time + $wait;
	while (1) {
		exit 0 if flock($fh, LOCK_EX | LOCK_NB);
		exit 1 if time >= $end;
		sleep 0.01;
	}
}
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
// The box's record of its last VERIFIED deploy: a git ref (see the
// verified-record block in remote-deploy.sh). "" when there is none.
const VERIFIED_REF = "refs/logisx/verified-deploy";
// …and of the last commit a deploy or a rollback STARTED (remote-deploy.sh's LIVE).
const STARTED_REF = "refs/logisx/started-deploy";
const refValue = (ref) => { const r = tryGit(D.box, "rev-parse", "--verify", "-q", ref); return r.status === 0 ? r.stdout.trim() : ""; };
const verified = () => refValue(VERIFIED_REF);
const started = () => refValue(STARTED_REF);

// Every case starts from a known box: HEAD, no marker, no logs, and NEITHER
// ref unless it asks for one. A ref written by one case must not leak into the
// next: the two refs are exactly what the no-op, rollback and drift checks read.
function resetBox(sha, { detachAt = null, verified: record = null, started: mark = null } = {}) {
	git(D.box, "checkout", "-q", "main");
	git(D.box, "reset", "-q", "--hard", sha);
	if (detachAt) git(D.box, "checkout", "-q", "--detach", detachAt);
	fs.rmSync(MARKER, { force: true });
	tryGit(D.box, "update-ref", "-d", VERIFIED_REF);
	tryGit(D.box, "update-ref", "-d", STARTED_REF);
	if (record) git(D.box, "update-ref", VERIFIED_REF, record);
	if (mark) git(D.box, "update-ref", STARTED_REF, mark);
	for (const f of fs.readdirSync(D.logs)) fs.rmSync(path.join(D.logs, f), { force: true });
}

// out: stdout then stderr. stdout alone is what the action parses (ssh hands
// the remote stderr to the runner's stderr, outside the captured output).
function runSh(text, env = {}) {
	const r = spawnSync("bash", ["-s"], { cwd: T, input: text, env: { ...ENV, ...env }, encoding: "utf8", timeout: 60000 });
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}`, stdout: r.stdout || "" };
}
const deployEnv = (extra) => ({ DIR: D.box, PM2: "logistics-app", REF: "main", ...extra });
const field = (out, k) => { const m = new RegExp(`^${k}=(.*)$`, "m").exec(out); return m ? m[1].trim() : ""; };
// The LAST `k=` line, which is the one the action reads (it takes `tail -1`).
const lastField = (out, k) => { const all = [...out.matchAll(new RegExp(`^${k}=(.*)$`, "gm"))]; return all.length ? all[all.length - 1][1].trim() : ""; };

// ── Helpers shared by test-deploy-record.js and test-deploy-live.js.
const short = (sha) => (sha ? sha.slice(0, 7) : "none");
const runCases = (cases, S, tag = "") => Object.values(cases).flatMap((fn) => fn(S, tag));
const clearLogs = () => { for (const f of fs.readdirSync(D.logs)) fs.rmSync(path.join(D.logs, f), { force: true }); };
const reflog = (ref) => tryGit(D.box, "reflog", "show", "--format=%gs", ref).stdout;
const checkOut = (S, env = {}) => runSh(S.check, { DIR: D.box, PM2: "logistics-app", ...env }).out;
const recordVerified = (S, sha, env = {}) => runSh(S.record, { DIR: D.box, SHA: sha, ...env });
// What the action reads from a deploy: stdout's LAST line of each kind.
const result = (x) => lastField(x.stdout, "DEPLOY_RESULT");
const deployedFrom = (x) => lastField(x.stdout, "DEPLOYED_FROM");
const didFullDeploy = (x) => /install-start/.test(log("npm")) && /^build tag=/m.test(log("npm")) && /^restart /m.test(log("pm2")) && result(x) === "deployed";
const isNoop = (x) => x.code === 0 && result(x) === "noop" && !/install/.test(log("npm")) && !/restart/.test(log("pm2"));
// A sleep that returns at once, first on PATH, for a rollback that polls 60 s.
// Its own directory: the npm stub's hold loop needs the real sleep.
let fastBin = null;
function fastBinDir() {
	if (fastBin) return fastBin;
	fastBin = path.join(T, "fast-bin");
	fs.mkdirSync(fastBin);
	writeExec(path.join(fastBin, "sleep"), "#!/bin/bash\nexit 0\n");
	return fastBin;
}
const rollback = (S, prev, env = {}) => runSh(S.rollback, { DIR: D.box, PM2: "logistics-app", PREV: prev, PATH: `${fastBinDir()}:${ENV.PATH}`, ...env });
// The state a deploy leaves when it dies after its checkout, set up directly
// with git: HEAD and main on `sha`, both refs untouched, nothing restarted.
// test-deploy-record.js's halfFinishedDeploy proves the REAL script leaves
// exactly this state; other cases start from it without a whole deploy each.
function leaveHalfFinished(sha) {
	git(D.box, "checkout", "-q", "main");
	git(D.box, "merge", "-q", "--ff-only", sha);
	clearLogs();
}

async function waitFor(pred, ms, what) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ── Mutant helpers, shared by both runners' §8.
const mutantHelpers = (() => {
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

	return { swap, cut, expectCaught };
})();

// Each worker process of scripts/test-deploy-scripts.js runs its share of the
// cases in a sandbox of its own and hands its counts to the process that
// reports: tally() there, absorb() here.
const removeSandbox = () => fs.rmSync(T, { recursive: true, force: true });
const tally = () => ({ pass, failures: [...failures] });
function absorb(t) {
	pass += t.pass;
	failures.push(...t.failures);
}

// Remove the sandbox and report. Exits 1 on any failure.
function finish() {
	removeSandbox();
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
}
const crash = (err) => failures.push(`runner crashed: ${err && err.stack ? err.stack : err}`);

// The heal prep's compare-and-swap inputs, exactly as deploy-drift.yml hands
// them over from a drift check's output: production as the check read it, its
// HEAD, and its marker (`none` when there was none).
const healExpect = (checkOutput) => ({
	EXPECT: field(checkOutput, "DRIFT_LOCAL"),
	EXPECT_HEAD: field(checkOutput, "DRIFT_HEAD"),
	EXPECT_MARKER: field(checkOutput, "DRIFT_MARKER") || "none",
});
// …and the box as it is right now, for a heal prep called with no check before it.
const boxSeen = () => ({ EXPECT_HEAD: head(), EXPECT_MARKER: marker() || "none" });

// Blocks this process for `ms` without starting a `sleep` process.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The lock holder's wait, once it holds the lock: a node process that inherits
// FD 9 (and with it the lock) and exits when RELEASE appears or HOLD_MS has
// passed. One process for the whole hold, not a `sleep` per tick.
const HOLDER_WAIT = `const end = Date.now() + Number(process.env.HOLD_MS);
setInterval(() => { if (require("fs").existsSync(process.env.RELEASE) || Date.now() >= end) process.exit(0); }, 5);`;

// Holds the box's deploy lock from another process, the way a running deploy
// does: `note` is the holder's note it writes into the lock file (as every
// holder does), and with `seconds` it lets go by itself after that long, so a
// contender run meanwhile can be seen to wait for it. Returns once the lock is
// held; release() lets go and waits until the lock is free.
function holdLock({ note = "", seconds = 0 } = {}) {
	const ready = path.join(T, `lock-held-${Math.random().toString(36).slice(2)}`);
	const release = `${ready}.release`;
	const holdMs = seconds > 0 ? Math.round(seconds * 1000) : 3600000;
	const env = { ...ENV, LOCK: LOCK_FILE, READY: ready, RELEASE: release, NOTE: note, HOLD_MS: String(holdMs), HOLDER_NODE: process.execPath, HOLDER_WAIT };
	spawnSync("bash", ["-c", '( exec 9<>"$LOCK"; flock -w 10 9 || exit 3; if [ -n "$NOTE" ]; then printf "%s\\n" "$NOTE" > "$LOCK"; fi; : > "$READY"; exec "$HOLDER_NODE" -e "$HOLDER_WAIT" ) >/dev/null 2>&1 </dev/null &'], { env });
	const free = () => spawnSync("bash", ["-c", 'exec 9<>"$LOCK"; flock -n 9'], { env }).status === 0;
	const until = Date.now() + 10000;
	while (!fs.existsSync(ready)) {
		if (Date.now() > until) throw new Error("could not take the deploy lock for the test");
		pause(5);
	}
	return {
		release() {
			fs.writeFileSync(release, "");
			const until2 = Date.now() + 10000;
			while (!free()) {
				if (Date.now() > until2) throw new Error("the deploy lock was never released after the test");
				pause(5);
			}
			fs.rmSync(ready, { force: true });
			fs.rmSync(release, { force: true });
		},
	};
}
// …while fn runs, then releases it.
function withLockHeld(fn, opts = {}) {
	const h = holdLock(opts);
	try {
		return fn();
	} finally {
		h.release();
	}
}
// The note each kind of holder writes (remote-deploy.sh's deploy-lock block,
// remote-drift-check.sh).
const holderNote = (by) => `pid=1 since=2026-10-08T00:00:00Z by=${by}`;

module.exports = {
	DEPLOY_DIR, readScript, REAL, SMOKE,
	ok, record, finish, crash, removeSandbox, tally, absorb,
	T, D, ENV, NODE_DIR,
	git, tryGit, writeExec, STUB_EXEC, hasRealFlock,
	C1, C2, C3, S1,
	MARKER, LOCK_FILE, head, onMain, marker, log, VERIFIED_REF, verified, STARTED_REF, started,
	resetBox, runSh, deployEnv, field, lastField, waitFor,
	short, runCases, clearLogs, reflog, checkOut, recordVerified, result, deployedFrom, didFullDeploy, isNoop,
	fastBinDir, rollback, leaveHalfFinished,
	healExpect, boxSeen, withLockHeld, holdLock, holderNote,
	...mutantHelpers,
	M: "[mutant] ",
};
