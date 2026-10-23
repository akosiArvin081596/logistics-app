#!/usr/bin/env node
/**
 * Proves the pre-push sandbox profile kept inside .githooks/pre-push refuses
 * what it must and allows what the runners need, against the real
 * /usr/bin/sandbox-exec.
 *
 *   §1 secrets in a fake home and worktree (env files, settings.env, the
 *      service-account key, app.db and its -wal/-shm, uploads/, ~/.ssh,
 *      ~/Documents/Credentials, ~/LogisX-replica, ~/Library/Keychains): read,
 *      stat, copy, a new hard link, rename, and a read through a symlink are
 *      all refused
 *   §2 the worktree's .env.example, a plain file in home and the worktree,
 *      and an env-style file in a temp dir outside both stay readable
 *   §3 token stores under the fake home are refused: .config/gh, .npmrc,
 *      .aws, .config/gcloud, .docker/config.json, .git-credentials, .netrc,
 *      .claude, .claude.json
 *   §4 writes to the fake home and worktree are refused; temp writes work
 *   §5 network: loopback only. Its own port-0 server and another process's
 *      listening server on loopback are reached (pinned, so a change to the
 *      network rule is a decision); a TEST-NET address and an external DNS
 *      lookup are not
 *   §6 security, osascript, open, launchctl, ssh and sandbox-exec can't be
 *      started; git can. /dev/tty can't be opened and the terminal devices
 *      /dev/ttys* can't even be looked at
 *   §7 the hook end to end, with the real sandbox-exec: a copy of the hook
 *      run as git runs it in a fixture repository whose path holds regex
 *      characters. The child sees only the allowlisted environment (no
 *      GH_TOKEN, SSH_AUTH_SOCK, UNIT_TEST_SHARD or UNIT_TEST_SKIP_TIMING), the
 *      worktree's env file is refused inside it, it can't write the folder
 *      holding the hook's list and log, and the hook passes on the verdict
 *      line. Then with a terminal, under /usr/bin/script (a push from
 *      Terminal.app, and a run by hand there): the child can't open /dev/tty
 *      or the terminal by name, its stdin is not the terminal, and the hook's
 *      own lines still reach the terminal
 *   §8 mutants: every deny rule of the profile deleted in turn, the path
 *      quoting dropped, `env -i` dropped, and the child's stdin from
 *      /dev/null dropped, are each noticed above
 *
 * macOS only, and only outside any sandbox: sandbox-exec can't start inside
 * another one (Claude's Bash sandbox, the pre-push hook's own child), and CI
 * runs Linux. There it prints "SKIP (platform): ..." and exits 0, which
 * scripts/run-unit-tests.js reports as a skip, never as a pass.
 * Run it from a plain terminal: node scripts/test-prepush-sandbox.js
 *
 * Every fake is made at run time in this runner's own temp directories and
 * holds dummy text; no real secret is read or written.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HOOK_TEXT = fs.readFileSync(path.join(ROOT, ".githooks/pre-push"), "utf8");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function skip(reason) {
	console.log(`SKIP (platform): ${reason}`);
	process.exit(0);
}
if (process.platform !== "darwin") skip(`not macOS (${process.platform}); the pre-push sandbox is macOS only`);
if (!fs.existsSync(SANDBOX_EXEC)) skip(`${SANDBOX_EXEC} is missing`);
{
	const nest = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8" });
	if (nest.error || nest.status !== 0) {
		skip(`sandbox-exec can't start here (${nest.error ? nest.error.code : `exit ${nest.status}`}): this runs inside a sandbox already`);
	}
}

const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// ── The profile and the quoting, read from the hook itself.
const PROFILE = (() => {
	const m = /<<'SANDBOX_PROFILE' \|\| true\n([\s\S]*?)\nSANDBOX_PROFILE\n/.exec(HOOK_TEXT);
	if (!m) throw new Error("no SANDBOX_PROFILE heredoc in .githooks/pre-push");
	return m[1];
})();
const QUOTE_FN = (() => {
	const m = /\nsbpl_quote\(\) \{\n[\s\S]*?\n\}\n/.exec(HOOK_TEXT);
	if (!m) throw new Error("no sbpl_quote() in .githooks/pre-push");
	return m[0];
})();
function sbplQuote(p) {
	const r = spawnSync("/bin/bash", ["-c", `${QUOTE_FN}\nsbpl_quote "$1"`, "quote", p], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`sbpl_quote failed: ${r.stderr}`);
	return r.stdout;
}

// ── Fixtures. Temp side: os.tmpdir(). Home and worktree: outside temp space
// (the profile lets anything write under the temp roots), in a mkdtemp of the
// user's cache folder, with regex characters in their names.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prepush-sandbox-")));
const CACHES = path.join(os.homedir(), "Library", "Caches");
fs.mkdirSync(CACHES, { recursive: true });
const NT = fs.realpathSync(fs.mkdtempSync(path.join(CACHES, "logisx-prepush-sandbox-")));
process.on("exit", () => {
	fs.rmSync(TMP, { recursive: true, force: true });
	fs.rmSync(NT, { recursive: true, force: true });
});
const H = path.join(NT, "h.o+m(e)[1]{2}");
const W = path.join(NT, "w.t+(x)[3]{4}|^$");
const SCRATCH = path.join(TMP, "scratch");
const OUTSIDE = path.join(TMP, "outside");
const DUMMY = "fake-not-a-secret\n";
const plant = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, DUMMY); return p; };
for (const d of [SCRATCH, OUTSIDE]) fs.mkdirSync(d, { recursive: true });

const ENVFILE = ".env";
const SECRETS = [
	plant(path.join(W, ENVFILE)),
	plant(path.join(W, `${ENVFILE}.local`)),
	plant(path.join(W, `${ENVFILE}.production`)),
	plant(path.join(W, "settings.env")),
	plant(path.join(W, "service-account-key.json")),
	plant(path.join(W, "deploy", "nested", "service-account-key-2.json")),
	plant(path.join(W, "scripts", "replica", "settings.env")),
	plant(path.join(W, "app.db")),
	plant(path.join(W, "app.db-wal")),
	plant(path.join(W, "app.db-shm")),
	plant(path.join(W, "uploads", "pod.pdf")),
	plant(path.join(H, "Projects", "other", ENVFILE)),
	plant(path.join(H, "Projects", "other", "service-account-key.json")),
	plant(path.join(H, "Projects", "other", "settings.env")),
	plant(path.join(H, ".ssh", "id_fake")),
	plant(path.join(H, "Documents", "Credentials", "x.txt")),
	plant(path.join(H, "LogisX-replica", "mcp", "x.txt")),
	plant(path.join(H, "LogisX-replica", "reports", "y.md")),
	plant(path.join(H, "Library", "Keychains", "x.keychain-db")),
];
const TOKEN_STORES = [
	plant(path.join(H, ".config", "gh", "hosts.yml")),
	plant(path.join(H, ".npmrc")),
	plant(path.join(H, ".aws", "credentials")),
	plant(path.join(H, ".config", "gcloud", "x.json")),
	plant(path.join(H, ".docker", "config.json")),
	plant(path.join(H, ".git-credentials")),
	plant(path.join(H, ".netrc")),
	plant(path.join(H, ".claude", "x.json")),
	plant(path.join(H, ".claude.json")),
];
const READABLE = [
	plant(path.join(W, `${ENVFILE}.example`)),
	plant(path.join(W, "plain.txt")),
	plant(path.join(H, "plain.txt")),
	plant(path.join(OUTSIDE, ENVFILE)),
];
const EXEC_REFUSED = [
	["/usr/bin/security", ["help"]],
	["/usr/bin/osascript", ["-e", "return 1"]],
	["/usr/bin/open", []],
	["/bin/launchctl", ["version"]],
	["/usr/bin/ssh", ["-V"]],
	[SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]],
];

// ── The probe: one node process under sandbox-exec, every case at once, a
// JSON line of outcomes ("allowed" or the error code).
const PROBE = String.raw`
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const path = require("path");
const { spawnSync } = require("child_process");
const spec = JSON.parse(process.argv[1]);
const out = {};
const rec = (k, fn) => { try { fn(); out[k] = "allowed"; } catch (e) { out[k] = e.code || String(e.message); } };
let n = 0;
for (const p of spec.secrets) {
  rec("read " + p, () => fs.readFileSync(p));
  rec("stat " + p, () => fs.statSync(p));
  rec("copy " + p, () => fs.copyFileSync(p, path.join(spec.scratch, "copy-" + (++n))));
  rec("link " + p, () => fs.linkSync(p, path.join(spec.scratch, "link-" + (++n))));
  rec("rename " + p, () => fs.renameSync(p, path.join(spec.scratch, "renamed-" + (++n))));
  const l = path.join(spec.scratch, "sym-" + (++n));
  fs.symlinkSync(p, l);
  rec("symlink-read " + p, () => fs.readFileSync(l));
}
for (const p of spec.tokens) { rec("read " + p, () => fs.readFileSync(p)); rec("stat " + p, () => fs.statSync(p)); }
for (const p of spec.readable) rec("read " + p, () => fs.readFileSync(p));
for (const p of spec.writes) rec("write " + p, () => fs.writeFileSync(p, "x"));
for (const [bin, args] of spec.execs) {
  const r = spawnSync(bin, args, { stdio: "ignore", timeout: 5000 });
  out["exec " + bin] = r.error ? (r.error.code || "error") : "allowed";
}
const C = fs.constants;
rec("open-r /dev/tty", () => fs.closeSync(fs.openSync("/dev/tty", C.O_RDONLY | C.O_NOCTTY)));
rec("open-w /dev/tty", () => fs.closeSync(fs.openSync("/dev/tty", C.O_WRONLY | C.O_NOCTTY)));
out.ptys = fs.readdirSync("/dev").filter((d) => /^ttys\d+$/.test(d)).slice(0, 3);
for (const d of out.ptys) rec("stat /dev/" + d, () => fs.statSync("/dev/" + d));
out.env = Object.keys(process.env).sort();
const connect = (host, port) => new Promise((res) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); res("TIMEOUT"); }, 1500);
  s.on("connect", () => { clearTimeout(t); s.end(); res("allowed"); });
  s.on("error", (e) => { clearTimeout(t); res(e.code || "error"); });
});
(async () => {
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  out["loopback"] = await connect("127.0.0.1", srv.address().port);
  srv.close();
  out["test-net"] = await connect("192.0.2.1", 443);
  for (const p of spec.ports) out["port " + p] = await connect("127.0.0.1", p);
  out["dns"] = await Promise.race([
    dns.promises.lookup("example.com").then(() => "allowed", (e) => e.code || "error"),
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 3000)),
  ]);
  process.stdout.write(JSON.stringify(out) + "\n");
})();
`;

let round = 0;
function freshScratch() {
	const s = path.join(SCRATCH, String(++round));
	fs.mkdirSync(s);
	return s;
}
// Re-plants anything a mutant run let a probe rename away.
function replant() {
	for (const p of [...SECRETS, ...TOKEN_STORES, ...READABLE]) if (!fs.existsSync(p)) plant(p);
	for (const p of [path.join(W, "new.txt"), path.join(H, "new.txt")]) fs.rmSync(p, { force: true });
}
function probe(profile, { home = H, work = W, ports = [] } = {}) {
	replant();
	const scratch = freshScratch();
	const spec = {
		secrets: SECRETS,
		tokens: TOKEN_STORES,
		readable: READABLE,
		writes: [path.join(W, "new.txt"), path.join(H, "new.txt"), path.join(scratch, "w.txt"), path.join("/private/var/tmp", `prepush-sandbox-${process.pid}-${round}`)],
		execs: [...EXEC_REFUSED, ["/usr/bin/true", []], ["/usr/bin/git", ["--version"]]],
		ports,
		scratch,
	};
	const r = spawnSync(SANDBOX_EXEC, [
		"-p", profile,
		"-D", `HOME=${home}`, "-D", `WORK=${work}`,
		"-D", `HOME_RE=${sbplQuote(home)}`, "-D", `WORK_RE=${sbplQuote(work)}`,
		process.execPath, "-e", PROBE, JSON.stringify(spec),
	], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: TMP }, timeout: 60000 });
	fs.rmSync(spec.writes[3], { force: true });
	const line = (r.stdout || "").trim().split("\n").pop();
	try {
		return { ...JSON.parse(line), spec };
	} catch {
		return { failed: `exit ${r.status}: ${(r.stderr || "").slice(0, 300)}`, spec };
	}
}

// The expectations, as [name, holds] pairs, so a mutant run can say which broke.
function expectations(o) {
	const r = [];
	if (o.failed) return [["the probe ran", false]];
	for (const p of o.spec.secrets) {
		for (const op of ["read", "stat", "copy", "link", "rename", "symlink-read"]) {
			r.push([`§1 ${op} ${path.relative(NT, p)} is refused (got ${o[`${op} ${p}`]})`, o[`${op} ${p}`] === "EPERM"]);
		}
	}
	for (const p of o.spec.readable) r.push([`§2 ${path.relative(path.dirname(NT), p)} stays readable (got ${o[`read ${p}`]})`, o[`read ${p}`] === "allowed"]);
	for (const p of o.spec.tokens) {
		for (const op of ["read", "stat"]) r.push([`§3 ${op} ${path.relative(NT, p)} is refused (got ${o[`${op} ${p}`]})`, o[`${op} ${p}`] === "EPERM"]);
	}
	const [wW, wH, wTmp, wVarTmp] = o.spec.writes;
	r.push([`§4 writing into the worktree is refused (got ${o[`write ${wW}`]})`, o[`write ${wW}`] === "EPERM"]);
	r.push([`§4 writing into home is refused (got ${o[`write ${wH}`]})`, o[`write ${wH}`] === "EPERM"]);
	r.push([`§4 writing in a temp dir works (got ${o[`write ${wTmp}`]})`, o[`write ${wTmp}`] === "allowed"]);
	r.push([`§4 writing in /private/var/tmp works (got ${o[`write ${wVarTmp}`]})`, o[`write ${wVarTmp}`] === "allowed"]);
	r.push([`§5 loopback to its own port-0 server works (got ${o.loopback})`, o.loopback === "allowed"]);
	r.push([`§5 a TEST-NET address is refused (got ${o["test-net"]})`, o["test-net"] === "EPERM"]);
	r.push([`§5 an external DNS lookup fails (got ${o.dns})`, o.dns !== "allowed"]);
	for (const [bin] of EXEC_REFUSED) r.push([`§6 ${bin} can't be started (got ${o[`exec ${bin}`]})`, o[`exec ${bin}`] === "EPERM"]);
	r.push([`§6 /usr/bin/true and git still start (got ${o["exec /usr/bin/true"]}, ${o["exec /usr/bin/git"]})`, o["exec /usr/bin/true"] === "allowed" && o["exec /usr/bin/git"] === "allowed"]);
	// With no terminal, an open the profile allows fails ENXIO; only EPERM is
	// the profile's refusal.
	r.push([`§6 /dev/tty can't be opened, to read or to write (got ${o["open-r /dev/tty"]}, ${o["open-w /dev/tty"]})`, o["open-r /dev/tty"] === "EPERM" && o["open-w /dev/tty"] === "EPERM"]);
	const ptys = Array.isArray(o.ptys) ? o.ptys : [];
	r.push([`§6 the terminal devices can't even be looked at (${ptys.length ? ptys.map((d) => `/dev/${d}: ${o[`stat /dev/${d}`]}`).join(", ") : "no /dev/ttys* here to probe: run it from a terminal"})`,
		ptys.length > 0 && ptys.every((d) => o[`stat /dev/${d}`] === "EPERM")]);
	return r;
}

// §1-§6 against the profile as written.
const base = probe(PROFILE);
for (const [m, c] of expectations(base)) ok(c, m);

// §5 loopback only, pinned so a change to the network rule is a decision:
// loopback to a LISTENING local server (another process's, on a free port of
// this runner's own) is reached from inside the sandbox. The kernel completes
// the probe's handshake while this process waits on spawnSync.
async function listeningCheck() {
	const net = require("net");
	const srv = net.createServer((s) => s.destroy());
	await new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(0, "127.0.0.1", resolve); });
	const P = srv.address().port;
	const o = probe(PROFILE, { ports: [P] });
	srv.close();
	ok(o[`port ${P}`] === "allowed", `§5 loopback to another process's listening server is reached (network: loopback only) (got ${o[`port ${P}`]})`);
}

// ── §7 the hook end to end.
const GITCONFIG = path.join(TMP, "gitconfig");
fs.writeFileSync(GITCONFIG, "");
const GIT_ENV = {
	PATH: "/usr/bin:/bin", HOME: H, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: GITCONFIG, GIT_CEILING_DIRECTORIES: NT,
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const git = (cwd, ...args) => {
	const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout.trim();
};
// The fixture harness: speaks the pre-push protocol, reports what it sees
// from inside the sandbox, and ends on the verdict line.
const FIXTURE_HARNESS = String.raw`// const PREPUSH_PROTOCOL = 1;
const fs = require("fs");
const net = require("net");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const out = { argv: process.argv.slice(2), env: Object.keys(process.env).sort(), timeout: process.env.UNIT_TEST_TIMEOUT_MS || "" };
const tryRead = (p) => { try { fs.readFileSync(p); return "allowed"; } catch (e) { return e.code; } };
const tryOpen = (p) => { try { fs.closeSync(fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NOCTTY)); return "allowed"; } catch (e) { return e.code; } };
out.envFile = tryRead(path.join(ROOT, ".env"));
out.plain = tryRead(path.join(ROOT, "README.md"));
const i = process.argv.indexOf("--changed-list");
out.list = i > 0 ? fs.readFileSync(process.argv[i + 1], "utf8").split("\0").filter(Boolean).sort() : null;
try { fs.writeFileSync(path.join(ROOT, "written.txt"), "x"); out.write = "allowed"; } catch (e) { out.write = e.code; }
out.workWrite = "no list";
if (i > 0) try { fs.writeFileSync(path.join(path.dirname(process.argv[i + 1]), "planted.txt"), "x"); out.workWrite = "allowed"; } catch (e) { out.workWrite = e.code; }
out.tty = tryOpen("/dev/tty");
let pty = "";
try { pty = fs.readFileSync(path.join(ROOT, "..", "pty-name"), "utf8").trim(); } catch {}
out.pty = pty;
out.ptyOpen = /^\/dev\/ttys\d+$/.test(pty) ? tryOpen(pty) : "";
out.stdinTTY = require("tty").isatty(0);
const s = net.connect({ host: "192.0.2.1", port: 443 });
const t = setTimeout(() => { s.destroy(); done("TIMEOUT"); }, 1500);
s.on("connect", () => { s.end(); done("allowed"); });
s.on("error", (e) => done(e.code));
let finished = false;
function done(net) {
  if (finished) return;
  finished = true;
  clearTimeout(t);
  out.net = net;
  console.log("FIXTURE " + JSON.stringify(out));
  console.log("pre-push verdict: lint=pass selection=pass runners=pass");
}
`;
const REPO = path.join(W, "repo");
fs.mkdirSync(path.join(REPO, "scripts"), { recursive: true });
fs.writeFileSync(path.join(REPO, "scripts", "run-unit-tests.js"), FIXTURE_HARNESS);
fs.writeFileSync(path.join(REPO, "README.md"), "fixture\n");
fs.writeFileSync(path.join(REPO, ".gitignore"), `${ENVFILE}\n`);
git(NT, "init", "-q", "-b", "main", REPO);
git(REPO, "add", ".");
git(REPO, "commit", "-q", "-m", "init");
git(REPO, "update-ref", "refs/remotes/origin/main", "HEAD");
git(REPO, "checkout", "-q", "-b", "feature");
fs.writeFileSync(path.join(REPO, "lib.txt"), "changed\n");
git(REPO, "add", "lib.txt");
git(REPO, "commit", "-q", "-m", "change");
plant(path.join(REPO, ENVFILE));
const OID = git(REPO, "rev-parse", "HEAD");
const HOOK_TMP = path.join(TMP, "hook-tmp");
fs.mkdirSync(HOOK_TMP);
// On macOS the hook works in a folder under ~/Library/Caches.
fs.mkdirSync(path.join(H, "Library", "Caches"), { recursive: true });
const REFS = `refs/heads/feature ${OID} refs/heads/feature ${"0".repeat(40)}\n`;
const HOOK_ENV = {
	...GIT_ENV,
	PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
	TMPDIR: HOOK_TMP, LANG: "C", USER: "t", LOGNAME: "t", SHELL: "/bin/bash", TERM: "dumb",
	GH_TOKEN: "fake-not-a-token", SSH_AUTH_SOCK: "/nonexistent/agent.sock", SOMETHING_ELSE: "x",
	UNIT_TEST_SHARD: "1/3", UNIT_TEST_SKIP_TIMING: "1", UNIT_TEST_TIMEOUT_MS: "5000",
};
// Not anchored at the line start: on a terminal, script's end-of-input echo
// ("^D" and two backspaces) comes first on the first line.
const hookResult = (r) => {
	const outText = `${r.stdout || ""}${r.stderr || ""}`;
	const m = /FIXTURE (\{.*\})\r?$/m.exec(outText);
	let fixture = null;
	try { fixture = m ? JSON.parse(m[1]) : null; } catch { fixture = null; }
	return { code: r.status, out: outText, fixture };
};
function hookCopy(text) {
	const hook = path.join(TMP, `pre-push-${++round}`);
	fs.writeFileSync(hook, text, { mode: 0o755 });
	fs.rmSync(path.join(REPO, "written.txt"), { force: true });
	return hook;
}

function runHook(text) {
	const hook = hookCopy(text);
	return hookResult(spawnSync("/bin/bash", [hook, "origin", "git@github.com:o/r.git"], {
		cwd: REPO, input: REFS, encoding: "utf8", timeout: 60000, env: HOOK_ENV,
	}));
}

// With a terminal: /usr/bin/script runs the hook on a new pty, which becomes
// its controlling terminal and takes its output, as a push from Terminal.app
// does. The wrapper writes the pty's name where the fixture harness reads it.
// As git runs it, stdin is the refs; by hand, stdin is the terminal.
const PTY_NAME = path.join(W, "pty-name");
const REFS_FILE = path.join(TMP, "refs");
fs.writeFileSync(REFS_FILE, REFS);
function runHookOnTerminal(text, { byHand = false } = {}) {
	const hook = hookCopy(text);
	fs.rmSync(PTY_NAME, { force: true });
	const wrap = `/usr/bin/tty > "$1" || exit 97; exec /bin/bash "$2" origin git@github.com:o/r.git${byHand ? "" : ' < "$3"'}`;
	return hookResult(spawnSync("/usr/bin/script", ["-q", "/dev/null", "/bin/bash", "-c", wrap, "wrap", PTY_NAME, hook, REFS_FILE], {
		cwd: REPO, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 60000, env: HOOK_ENV,
	}));
}
function terminalChecks(h, how, tag = "") {
	const f = h.fixture || {};
	return [
		[`${tag}§7 ${how}: the hook's own lines reach the terminal (exit ${h.code}): ${h.out.slice(-200)}`, /pre-push: passed in/.test(h.out)],
		[`${tag}§7 ${how}: the hook ran on a terminal (pty ${JSON.stringify(f.pty)})`, typeof f.pty === "string" && /^\/dev\/ttys\d+$/.test(f.pty)],
		[`${tag}§7 ${how}: the child can't open /dev/tty or the terminal by name (got ${f.tty}, ${f.ptyOpen})`, f.tty === "EPERM" && f.ptyOpen === "EPERM"],
		[`${tag}§7 ${how}: the child's stdin is not the terminal (isatty ${f.stdinTTY})`, f.stdinTTY === false],
	];
}
const ALLOWED_ENV = ["HOME", "LANG", "LOGNAME", "NODE_ENV", "PATH", "SHELL", "TERM", "TMPDIR", "UNIT_TEST_TIMEOUT_MS", "USER"];
// macOS adds this one to every process it starts (the uid and text encoding).
const ADDED_BY_MACOS = "__CF_USER_TEXT_ENCODING";
function hookChecks(h, tag = "") {
	const f = h.fixture || {};
	const env = Array.isArray(f.env) ? f.env.filter((k) => k !== ADDED_BY_MACOS) : f.env;
	return [
		[`${tag}§7 the hook passes on the child's verdict (exit ${h.code}): ${h.out.slice(-300)}`, h.code === 0 && /pre-push: passed in/.test(h.out)],
		[`${tag}§7 the child ran inside the sandbox and reported (got ${JSON.stringify(f).slice(0, 200)})`, !!h.fixture],
		[`${tag}§7 the child's environment is the allowlist and nothing else (got ${JSON.stringify(f.env)})`, JSON.stringify(env) === JSON.stringify(ALLOWED_ENV)],
		[`${tag}§7 …so GH_TOKEN, SSH_AUTH_SOCK, UNIT_TEST_SHARD and UNIT_TEST_SKIP_TIMING never reach it, and UNIT_TEST_TIMEOUT_MS does (got ${f.timeout})`,
			Array.isArray(f.env) && !f.env.some((k) => ["GH_TOKEN", "SSH_AUTH_SOCK", "UNIT_TEST_SHARD", "UNIT_TEST_SKIP_TIMING", "SOMETHING_ELSE"].includes(k)) && f.timeout === "5000"],
		[`${tag}§7 the worktree's env file is refused inside the child, a plain file is not (got ${f.envFile}, ${f.plain})`, f.envFile === "EPERM" && f.plain === "allowed"],
		[`${tag}§7 the child can't write into the worktree (got ${f.write})`, f.write === "EPERM" && !fs.existsSync(path.join(REPO, "written.txt"))],
		[`${tag}§7 the child can't write into the folder holding the hook's list and log (got ${f.workWrite})`, f.workWrite === "EPERM"],
		[`${tag}§7 the child can't open /dev/tty (got ${f.tty})`, f.tty === "EPERM"],
		[`${tag}§7 the child can't reach a TEST-NET address (got ${f.net})`, f.net === "EPERM"],
		[`${tag}§7 the child gets the lint, budget and changed-list flags (got ${JSON.stringify(f.argv)})`,
			Array.isArray(f.argv) && f.argv.includes("--lint") && f.argv.includes("--changed-list") && f.argv[f.argv.indexOf("--budget-ms") + 1] === "115000"],
		[`${tag}§7 the changed list is the branch's file plus the untracked one, never the ignored env file (got ${JSON.stringify(f.list)})`,
			JSON.stringify(f.list) === JSON.stringify(["lib.txt"])],
	];
}
const hookRun = runHook(HOOK_TEXT);
for (const [m, c] of hookChecks(hookRun)) ok(c, m);
for (const [m, c] of terminalChecks(runHookOnTerminal(HOOK_TEXT), "a push from a terminal")) ok(c, m);
for (const [m, c] of terminalChecks(runHookOnTerminal(HOOK_TEXT, { byHand: true }), "run by hand in a terminal")) ok(c, m);

// ── §8 mutants.
// Every rule inside a deny form, and each one-line deny, deleted in turn.
const lines = PROFILE.split("\n");
const ruleLines = [];
let inDeny = false;
const balanced = (l) => (l.match(/\(/g) || []).length === (l.match(/\)/g) || []).length;
lines.forEach((l, k) => {
	if (/^\(deny /.test(l) && balanced(l)) { ruleLines.push(k); return; }
	if (/^\(deny /.test(l)) { inDeny = true; return; }
	if (l === ")") { inDeny = false; return; }
	if (inDeny && /^\s+\(/.test(l)) ruleLines.push(k);
});
// Apple Events: nothing this probe can start sends one (osascript can't be
// started at all), so deleting that rule is not observable here.
const NOT_PROBED = new Set(["(deny appleevent-send)"]);
ok(ruleLines.length >= 30, `§8 the profile's deny rules are found one per line (${ruleLines.length})`);
for (const k of ruleLines) {
	if (NOT_PROBED.has(lines[k].trim())) continue;
	const mutant = lines.filter((_, j) => j !== k).join("\n");
	const broken = expectations(probe(mutant)).filter(([, c]) => !c).map(([m]) => m);
	ok(broken.length > 0, `§8 deleting the rule ${JSON.stringify(lines[k].trim())} must be noticed by a case in §1-§6`);
}
// The hook without its path quoting, and without env -i.
for (const [name, from, to] of [
	["the regex quoting of home and the worktree dropped", '-D "HOME_RE=$(sbpl_quote "$home_real")" -D "WORK_RE=$(sbpl_quote "$work_real")"', '-D "HOME_RE=$home_real" -D "WORK_RE=$work_real"'],
	["env -i dropped", '"$ENV_BIN" -i "${envs[@]}"', '"$ENV_BIN" "${envs[@]}"'],
]) {
	const text = HOOK_TEXT.split(from).join(to);
	ok(text !== HOOK_TEXT, `§8 mutant '${name}' must change the hook`);
	ok(hookChecks(runHook(text), "[mutant] ").some(([, c]) => !c), `§8 mutant '${name}' must be noticed by §7`);
}
// The child's stdin from /dev/null dropped: run by hand in a terminal, the
// child's stdin would be the terminal.
{
	const text = HOOK_TEXT.split('"${run[@]}" < /dev/null 2>&1 | tee').join('"${run[@]}" 2>&1 | tee');
	ok(text !== HOOK_TEXT, "§8 mutant 'stdin from /dev/null dropped' must change the hook");
	ok(terminalChecks(runHookOnTerminal(text, { byHand: true }), "run by hand in a terminal", "[mutant] ").some(([, c]) => !c),
		"§8 mutant 'stdin from /dev/null dropped' must be noticed by §7");
}

listeningCheck().catch((err) => failures.push(`§5 the listening fixture: ${err.stack || err}`)).then(() => {
	console.log(`${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  - ${f}`);
		process.exitCode = 1;
	}
});
