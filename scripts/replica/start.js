#!/usr/bin/env node
// npm run replica:start -- [--task <name>] [--port <n>] [--prod-commit] [--fresh]
//
// Starts the app on a task's working copy of production, in replica mode
// (LOCAL_REPLICA=1, lib/replica-mode.js), on 127.0.0.1:<port> (default 3901).
//
//   --task <name>    the working copy, ~/LogisX-replica/work/<name>/ (default
//                    "default"). Made on first use as instant APFS clones
//                    (cp -c) of the clean snapshot and the uploaded files, so
//                    it costs no space until something changes; kept between
//                    starts, so a task's changes survive a restart.
//   --fresh          clone the working copy again from the clean snapshot.
//   --port <n>       refused when something already listens there.
//   --prod-commit    run the commit production runs (from the manifest) in a
//                    worktree under ~/LogisX-replica/code/, instead of this
//                    checkout. Refused when that commit has no replica mode.
//
// The server gets a minimal environment: none of this shell's variables but
// PATH, HOME, USER, LANG and TMPDIR, the replica's paths, production's time zone,
// NODE_ENV=development and a fresh random SESSION_SECRET held only in that
// environment. Production's non-secret settings come from
// ~/LogisX-replica/settings.env, which the server reads itself; it never reads
// a .env file. Prints the URL and the PID; stop it with npm run replica:clean.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");
const C = require("./common");

const argv = process.argv.slice(2);
const known = new Set(["--task", "--port", "--prod-commit", "--fresh", "-h", "--help"]);
for (let i = 0; i < argv.length; i++) {
	if (!known.has(argv[i])) C.fail(`unknown option ${argv[i]} (see --help)`);
	if (argv[i] === "--task" || argv[i] === "--port") i++;
}
if (argv.includes("-h") || argv.includes("--help")) {
	console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 24).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
	process.exit(0);
}
const task = C.taskArg(argv);
const port = Number(C.optionValue(argv, "--port") || C.DEFAULT_PORT);
const prodCommit = argv.includes("--prod-commit");
const fresh = argv.includes("--fresh");
const REPO = path.resolve(__dirname, "..", "..");

function portFree(p) {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.once("error", () => resolve(false));
		s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
	});
}

function git(args, opts = {}) {
	return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function hasCommit(commit) {
	try { git(["cat-file", "-e", `${commit}^{commit}`]); return true; } catch { return false; }
}

// The checkout whose node_modules this one uses (a worktree's are links to it).
function installsDir() {
	return path.dirname(fs.realpathSync(path.join(REPO, "node_modules")));
}

function linkInstalls(codeDir) {
	const from = installsDir();
	for (const rel of ["node_modules", path.join("client", "node_modules")]) {
		const dest = path.join(codeDir, rel);
		if (!fs.existsSync(dest)) fs.symlinkSync(path.join(from, rel), dest);
	}
}

function buildClient(codeDir) {
	if (fs.existsSync(path.join(codeDir, "client", "dist", "index.html"))) return;
	console.log(`replica: building the client in ${codeDir} (client/dist is missing)`);
	execFileSync("npm", ["run", "build:client"], { cwd: codeDir, stdio: "inherit" });
}

function codeDirFor(manifest) {
	if (!prodCommit) return REPO;
	const commit = manifest.production.commit;
	if (!/^[0-9a-f]{40}$/.test(commit)) C.fail("the manifest names no production commit; run npm run replica:pull");
	if (!hasCommit(commit)) {
		console.log(`replica: fetching ${commit.slice(0, 12)} from origin`);
		git(["fetch", "origin"], { stdio: "inherit" });
		if (!hasCommit(commit)) C.fail(`production's commit ${commit} is not in this repository`);
	}
	try {
		git(["cat-file", "-e", `${commit}:lib/replica-mode.js`]);
	} catch {
		C.fail(`refusing --prod-commit: production runs ${commit.slice(0, 12)}, which has no replica mode (lib/replica-mode.js), ` +
			"so it would run against real services. Run without --prod-commit (this checkout) until a commit with replica mode is deployed.");
	}
	const dir = path.join(C.paths.code, commit);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(C.paths.code, { recursive: true, mode: 0o700 });
		git(["worktree", "add", "--detach", dir, commit], { stdio: "inherit" });
	}
	linkInstalls(dir);
	return dir;
}

function cloneInto(src, dest) {
	try {
		execFileSync("cp", ["-c", "-R", src, dest], { stdio: ["ignore", "ignore", "pipe"] });
	} catch {
		execFileSync("cp", ["-R", src, dest], { stdio: ["ignore", "ignore", "inherit"] });
	}
}

function makeWorkingCopy(work) {
	fs.mkdirSync(path.dirname(work), { recursive: true, mode: 0o700 });
	fs.mkdirSync(work, { mode: 0o700 });
	cloneInto(path.join(C.paths.clean, "app.db"), path.join(work, "app.db"));
	cloneInto(path.join(C.paths.clean, "sheets.json"), path.join(work, "sheets.json"));
	for (const d of C.DATA_FOLDERS) cloneInto(C.paths.data(d), path.join(work, d));
	execFileSync("chmod", ["-R", "go-rwx", work]);
}

function waitUntilServing(child, logFile) {
	const deadline = Date.now() + 120000;
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (child.exitCode !== null || !C.alive(child.pid)) {
				const tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-25).join("\n");
				return reject(new Error(`the server exited; the end of its log (${logFile}):\n${tail}`));
			}
			const req = http.get({ host: "127.0.0.1", port, path: "/api/auth/session", timeout: 3000 }, (res) => {
				res.resume();
				if (res.statusCode === 200) return resolve();
				setTimeout(tick, 1000);
			});
			req.on("error", () => (Date.now() > deadline ? reject(new Error("not serving after 120 s")) : setTimeout(tick, 1000)));
			req.on("timeout", () => req.destroy());
		};
		tick();
	});
}

async function main() {
	for (const f of ["app.db", "sheets.json", "manifest.json"]) {
		if (!fs.existsSync(path.join(C.paths.clean, f))) C.fail(`no clean snapshot (${f} missing); run npm run replica:pull first`);
	}
	if (!fs.existsSync(C.paths.settings)) C.fail("no settings.env; run npm run replica:pull first");
	const manifest = C.readJson(path.join(C.paths.clean, "manifest.json"));
	if (process.version !== manifest.production.node) {
		C.fail(`production runs Node ${manifest.production.node}; this is ${process.version}. Use that version (fnm use) and run again.`);
	}

	const running = C.runningServer(task);
	if (running) {
		console.log(`replica: task ${task} is already running: http://127.0.0.1:${running.port} (pid ${running.pid})`);
		return;
	}
	if (!Number.isInteger(port) || port < 1024 || port > 65535) C.fail("--port must be a number from 1024 to 65535");
	if (C.RESERVED_PORTS.includes(port)) C.fail(`port ${port} is used by another local stack; pick another`);
	if (!(await portFree(port))) C.fail(`something already listens on 127.0.0.1:${port}; pick another --port`);

	const codeDir = codeDirFor(manifest);
	buildClient(codeDir);

	const work = C.paths.work(task);
	if (fs.existsSync(work) && fresh) fs.rmSync(work, { recursive: true, force: true });
	if (fs.existsSync(work)) {
		console.log(`replica: using the existing working copy ${work} (--fresh clones it again)`);
	} else {
		makeWorkingCopy(work);
		console.log(`replica: working copy cloned from the clean snapshot of ${manifest.snapshotAt}: ${work}`);
	}

	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	fs.mkdirSync(C.paths.logs, { recursive: true, mode: 0o700 });
	const logFile = path.join(C.paths.logs, `server-${task}-${stamp}.log`);
	const guardLog = path.join(C.paths.logs, `outbound-${task}-${stamp}.log`);
	fs.writeFileSync(guardLog, "", { mode: 0o600 });
	const tz = (fs.readFileSync(C.paths.settings, "utf8").match(/^TZ=['"`]?([^'"`\n]+)/m) || [])[1] || manifest.production.timeZone;
	const env = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		USER: process.env.USER || "",
		LANG: process.env.LANG || "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR || "/tmp",
		TZ: tz,
		NODE_ENV: "development",
		LOCAL_REPLICA: "1",
		LOGISX_REPLICA_TASK: task,
		DATABASE_PATH: path.join(work, "app.db"),
		LOGISX_REPLICA_DATA_DIR: work,
		LOGISX_REPLICA_GUARD_LOG: guardLog,
		PORT: String(port),
		BIND_HOST: "127.0.0.1",
		SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
	};
	const out = fs.openSync(logFile, "a", 0o600);
	const child = spawn(process.execPath, ["server.js"], { cwd: codeDir, env, detached: true, stdio: ["ignore", out, out] });
	child.unref();
	const record = {
		task, pid: child.pid, port, codeDir, log: logFile, guardLog, startedAt: new Date().toISOString(),
		commit: prodCommit ? manifest.production.commit : (() => { try { return git(["rev-parse", "HEAD"]); } catch { return ""; } })(),
		snapshotAt: manifest.snapshotAt,
	};
	C.writePrivate(C.paths.serverRecord(task), JSON.stringify(record, null, 2));
	console.log(`replica: started pid ${child.pid} from ${codeDir} (log ${logFile})`);
	try {
		await waitUntilServing(child, logFile);
	} catch (err) {
		C.fail(err.message);
	}
	console.log(`replica: LOCAL COPY OF PRODUCTION (task ${task}) is serving at http://127.0.0.1:${port}  pid ${child.pid}`);
	console.log(`replica: outbound guard log ${guardLog} (empty = nothing was attempted)`);
	console.log(`replica: sign in as someone: npm run replica:login -- <username> --task ${task}; stop: npm run replica:clean -- --task ${task}`);
}

main().catch((err) => C.fail(err.message));
