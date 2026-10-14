#!/usr/bin/env node
// replica:start --prod-commit on the first run for a commit
// (scripts/replica/start.js): production's commit gets its worktree under
// ~/LogisX-replica/code/ and the replica starts from it on that first run, not
// only on the next one.
//
//   §1 the commit is in the repository but has no worktree yet: replica:start
//      adds the worktree (git's own output still shows), links the installs,
//      starts the server from that commit, records it and exits 0, instead of
//      dying after git with "Cannot read properties of null (reading 'trim')";
//      a second run reuses the worktree
//   §2 the commit is not in the repository yet: replica:start fetches origin
//      (a throwaway repository on disk, no network), then adds the worktree and
//      starts as in §1
//   §3 without --prod-commit the server runs from the checkout itself and the
//      record names the checkout's HEAD (git's piped answers still come back
//      trimmed)
//   §4 the commit is on origin neither: after the fetch, replica:start refuses
//      with "is not in this repository" and exits 1, adds no worktree and
//      starts nothing (a failing git call still fails; it is not read as "")
//   Last, this checkout's own repository lists its worktrees, and none of them
//   is a throwaway one.
//
// The start.js under test is START_JS (default: this checkout's). It runs from
// the scripts/replica/ folder of a throwaway repository (its REPO is two folders
// up from the file), beside this checkout's common.js and lib/replica-rules.js.
// HOME is a temporary folder, so ~/LogisX-replica is a throwaway one too, and
// git gets no GIT_* variable from this shell (a git hook's GIT_DIR would
// otherwise point every call at this repository). The server is a stand-in
// server.js committed in the throwaway repository: it answers replica:start's
// readiness check once and exits.
//
// run-unit-tests.js kills a runner at 60 s, and then the exit handler never
// removes the temporary folders: the replica:start runs share one 45 s budget,
// at most 12 s each (the stand-in server exits by itself at 10 s).
//
// Standalone: node scripts/test-replica-start-git.js. Temporary folders only,
// a free local port, no network.
"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const START_JS = path.resolve(process.env.START_JS || path.join(ROOT, "scripts", "replica", "start.js"));
const RUNS_UNTIL = Date.now() + 45000;

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
// Every temporary folder this runner makes is removed when it exits, pass or
// fail; the throwaway worktrees are registered only inside them.
const tempDirs = [];
process.on("exit", () => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
	tempDirs.push(d);
	return d;
};
const tail = (text) => text.trim().split("\n").slice(-6).join(" | ");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The only environment git and replica:start get: a made-up identity for the
// throwaway commits and nothing from this shell's git setup.
const envFor = (home) => ({
	PATH: process.env.PATH,
	HOME: home,
	TMPDIR: os.tmpdir(),
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Replica Test",
	GIT_AUTHOR_EMAIL: "replica-test@example.invalid",
	GIT_COMMITTER_NAME: "Replica Test",
	GIT_COMMITTER_EMAIL: "replica-test@example.invalid",
});

function git(cwd, args, env) {
	const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
	return r.stdout.trim();
}
const tryGit = (cwd, args, env) => { try { return git(cwd, args, env); } catch { return ""; } };

function write(dir, rel, text) {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
}

const STAND_IN_SERVER = `"use strict";
// Stand-in for the app: answers replica:start's readiness check once, then exits.
const fs = require("fs");
const http = require("http");
const version = fs.readFileSync("version.txt", "utf8").trim();
console.log(\`stand-in server, version \${version}, from \${process.cwd()}\`);
const server = http.createServer((req, res) => {
	const ready = req.url === "/api/auth/session";
	res.writeHead(ready ? 200 : 404, { "content-type": "application/json", connection: "close" });
	res.end("{}", () => { if (ready) process.exit(0); });
});
server.listen(Number(process.env.PORT), process.env.BIND_HOST);
setTimeout(() => process.exit(3), 10000);
`;

// origin holds commits "one" and "two"; repo is a clone made before "two", so
// "two" reaches it only through git fetch. The start.js under test runs from
// repo/scripts/replica/.
function fixture() {
	const base = tmp("replica-start-git-");
	const env = envFor(path.join(base, "no-home"));
	const origin = path.join(base, "origin");
	const repo = path.join(base, "repo");
	fs.mkdirSync(origin);
	git(origin, ["init", "-q", "-b", "main"], env);
	write(origin, "server.js", STAND_IN_SERVER);
	write(origin, "lib/replica-mode.js", "// stand-in: this commit has replica mode\n");
	write(origin, "client/dist/index.html", "<!doctype html><title>stand-in</title>\n");
	const commit = (version) => {
		write(origin, "version.txt", `${version}\n`);
		git(origin, ["add", "-A"], env);
		git(origin, ["commit", "-q", "-m", `version ${version}`], env);
		return git(origin, ["rev-parse", "HEAD"], env);
	};
	const one = commit("one");
	git(base, ["clone", "-q", origin, repo], env);
	const two = commit("two");
	fs.mkdirSync(path.join(repo, "scripts", "replica"), { recursive: true });
	fs.copyFileSync(START_JS, path.join(repo, "scripts", "replica", "start.js"));
	fs.copyFileSync(path.join(ROOT, "scripts", "replica", "common.js"), path.join(repo, "scripts", "replica", "common.js"));
	fs.copyFileSync(path.join(ROOT, "lib", "replica-rules.js"), path.join(repo, "lib", "replica-rules.js"));
	fs.mkdirSync(path.join(repo, "node_modules"));
	fs.mkdirSync(path.join(repo, "client", "node_modules"));
	return { base, env, origin, repo, one, two };
}

// A HOME whose ~/LogisX-replica is as replica:pull leaves it, its manifest
// naming `commit` as production's.
function replicaHome(fx, commit) {
	const home = fs.mkdtempSync(path.join(fx.base, "home-"));
	const root = path.join(home, "LogisX-replica");
	const clean = path.join(root, "clean");
	fs.mkdirSync(clean, { recursive: true });
	fs.writeFileSync(path.join(clean, "app.db"), "");
	fs.writeFileSync(path.join(clean, "sheets.json"), JSON.stringify({ format: 1, spreadsheets: { "replica-test-main": { role: "main" } } }));
	fs.writeFileSync(path.join(clean, "manifest.json"), JSON.stringify({
		format: 1,
		snapshotAt: "2026-01-02T03:04:05.000Z",
		production: { commit, node: process.version, timeZone: "America/New_York" },
	}));
	fs.writeFileSync(path.join(root, "settings.env"), "TZ=America/New_York\n");
	for (const d of ["uploads", "storage", "evidence-archive"]) fs.mkdirSync(path.join(root, d));
	return { home, root };
}

const freePort = () => new Promise((resolve, reject) => {
	const s = net.createServer();
	s.once("error", reject);
	s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// True once the pid is gone (the stand-in exits by itself; this never signals it).
function exited(pid) {
	for (let i = 0; i < 50; i++) {
		try { process.kill(pid, 0); } catch (err) { if (err.code === "ESRCH") return true; }
		sleep(100);
	}
	return false;
}

async function start(fx, h, task, extra) {
	const port = await freePort();
	const r = spawnSync(process.execPath, [path.join(fx.repo, "scripts", "replica", "start.js"), "--task", task, "--port", String(port), ...extra],
		{ cwd: fx.repo, env: envFor(h.home), encoding: "utf8", timeout: Math.max(1, Math.min(12000, RUNS_UNTIL - Date.now())) });
	const recFile = path.join(h.root, "work", task, "server.json");
	const record = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8")) : {};
	const log = record.log && fs.existsSync(record.log) ? fs.readFileSync(record.log, "utf8") : "";
	return {
		status: r.status,
		out: `${r.stdout || ""}${r.stderr || ""}`,
		port,
		record,
		firstLog: log.split("\n")[0],
		serverExited: Number.isInteger(record.pid) ? exited(record.pid) : true,
	};
}

const headOf = (fx, dir) => (fs.existsSync(dir) ? tryGit(dir, ["rev-parse", "HEAD"], fx.env) : "");
const hasCommit = (fx, commit) => spawnSync("git", ["-C", fx.repo, "cat-file", "-e", `${commit}^{commit}`], { env: fx.env }).status === 0;
const worktreesOf = (cwd, env) => tryGit(cwd, ["worktree", "list", "--porcelain"], env)
	.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
const linkOf = (p) => { try { return fs.readlinkSync(p); } catch { return ""; } };

(async () => {
	const fx = fixture();
	const gitDir = tryGit(fx.repo, ["rev-parse", "--absolute-git-dir"], fx.env);
	ok("(fixture) the throwaway repository's git folder is inside the temporary folder", gitDir.startsWith(`${fx.base}${path.sep}`), gitDir);
	if (failures) process.exit(1);

	console.log("§1 first run for a commit already in the repository: git worktree add");
	{
		const h = replicaHome(fx, fx.one);
		const codeDir = path.join(h.root, "code", fx.one);
		ok("(fixture) the commit is in the repository and has no worktree yet", hasCommit(fx, fx.one) && !fs.existsSync(codeDir));
		const r = await start(fx, h, "t1", ["--prod-commit"]);
		eq("replica:start exits 0 on the first run", r.status, 0);
		ok("...without reading a null that git's shown output leaves", !/Cannot read properties of null/.test(r.out), tail(r.out));
		ok("...and git's own output still shows", /Preparing worktree/.test(r.out) && /HEAD is now at/.test(r.out), tail(r.out));
		ok("...and it says it is serving", r.out.includes(`is serving at http://127.0.0.1:${r.port}`), tail(r.out));
		eq("the worktree holds production's commit", headOf(fx, codeDir), fx.one);
		ok("...registered in the throwaway repository", worktreesOf(fx.repo, fx.env).includes(codeDir), worktreesOf(fx.repo, fx.env));
		eq("...with the installs linked from it", [linkOf(path.join(codeDir, "node_modules")), linkOf(path.join(codeDir, "client", "node_modules"))],
			[path.join(fx.repo, "node_modules"), path.join(fx.repo, "client", "node_modules")]);
		eq("the server ran from the worktree (that commit's server.js)", r.firstLog, `stand-in server, version one, from ${codeDir}`);
		eq("the record names the worktree and production's commit", [r.record.codeDir, r.record.commit], [codeDir, fx.one]);
		ok("the stand-in server has exited", r.serverExited);

		const again = await start(fx, h, "t2", ["--prod-commit"]);
		eq("a second run on the same commit exits 0", again.status, 0);
		ok("...reusing the worktree (no second git worktree add)", !/Preparing worktree/.test(again.out), tail(again.out));
		eq("...and runs the same commit from it", [again.record.codeDir, again.record.commit, again.firstLog], [codeDir, fx.one, `stand-in server, version one, from ${codeDir}`]);
		ok("the stand-in server has exited", again.serverExited);
	}

	console.log("§2 first run for a commit not in the repository yet: git fetch, then git worktree add");
	{
		const h = replicaHome(fx, fx.two);
		const codeDir = path.join(h.root, "code", fx.two);
		ok("(fixture) the commit is only on origin", !hasCommit(fx, fx.two) && !fs.existsSync(codeDir));
		const r = await start(fx, h, "t3", ["--prod-commit"]);
		eq("replica:start exits 0 on the first run", r.status, 0);
		ok("...without reading a null that git's shown output leaves", !/Cannot read properties of null/.test(r.out), tail(r.out));
		ok("...after fetching the commit from origin", r.out.includes(`fetching ${fx.two.slice(0, 12)} from origin`), tail(r.out));
		ok("...and it says it is serving", r.out.includes(`is serving at http://127.0.0.1:${r.port}`), tail(r.out));
		ok("the commit is now in the repository", hasCommit(fx, fx.two));
		eq("the worktree holds that commit", headOf(fx, codeDir), fx.two);
		eq("the server ran from the worktree (that commit's server.js)", r.firstLog, `stand-in server, version two, from ${codeDir}`);
		eq("the record names the worktree and production's commit", [r.record.codeDir, r.record.commit], [codeDir, fx.two]);
		ok("the stand-in server has exited", r.serverExited);
	}

	console.log("§3 without --prod-commit: this checkout, its HEAD recorded");
	{
		const h = replicaHome(fx, fx.two);
		const r = await start(fx, h, "t4", []);
		eq("replica:start exits 0", r.status, 0);
		eq("the record names the checkout and its HEAD, trimmed", [r.record.codeDir, r.record.commit], [fx.repo, fx.one]);
		eq("the server ran from the checkout", r.firstLog, `stand-in server, version one, from ${fx.repo}`);
		ok("no worktree is added", !fs.existsSync(path.join(h.root, "code")));
		ok("the stand-in server has exited", r.serverExited);
	}

	console.log("§4 a commit on origin neither: refused after the fetch");
	{
		const nowhere = "0123456789abcdef0123456789abcdef01234567";
		const h = replicaHome(fx, nowhere);
		ok("(fixture) the commit is not in the repository", !hasCommit(fx, nowhere));
		const r = await start(fx, h, "t5", ["--prod-commit"]);
		eq("replica:start exits 1", r.status, 1);
		ok("...after fetching origin", r.out.includes(`fetching ${nowhere.slice(0, 12)} from origin`), tail(r.out));
		ok("...saying the commit is not in this repository", r.out.includes(`production's commit ${nowhere} is not in this repository`), tail(r.out));
		ok("no code folder and no worktree are added", !fs.existsSync(path.join(h.root, "code")) && !worktreesOf(fx.repo, fx.env).some((w) => w.includes(nowhere)), worktreesOf(fx.repo, fx.env));
		ok("no server is started or recorded", !fs.existsSync(path.join(h.root, "work", "t5")));
	}

	const own = worktreesOf(ROOT, process.env);
	ok("this checkout's repository lists its worktrees (the checkout itself among them)", own.length > 0, own);
	ok("...and none of them is a throwaway one", !own.some((w) => w.startsWith(`${fx.base}${path.sep}`)), own);

	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
