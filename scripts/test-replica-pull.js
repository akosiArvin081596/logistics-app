#!/usr/bin/env node
// replica:pull (scripts/replica/pull.sh) run end to end here, with stand-ins
// for ssh and rsync on PATH: "production" is a temporary folder and nothing
// reaches the network. Each run has its own HOME, so ~/LogisX-replica is a
// temporary folder too.
//
//   §1 one shared ssh connection: opened once, before anything reaches the
//      server (the pull's only sign-in), with its settings on the command line
//      (keepalive, ControlPersist, forwarding and local commands off) and its
//      socket in a private folder under ~/LogisX-replica; every ssh, and rsync
//      through -e, joins it, each step checking it first, and a session that
//      finds it gone fails instead of signing in; every -O request names
//      ControlMaster=no and ControlPersist=no and reads /dev/null; it is closed
//      and its folder removed after the last upload, and by the trap on a
//      failure or an interruption, after the trap's server cleanup has used
//      it, also when a second signal or a broken stdout hits the trap; a pull
//      killed outright has its watchdog close it; a close that fails says how
//      the connection ends; the folders a stopped pull left are removed by the
//      next pull, and only a socket (never a link) gets a close request; a
//      connection that closes mid-pull fails the pull, saying so, and only the
//      server cleanup connects again, on its own connection; a connection that
//      cannot open, or a socket path too long for macOS, stops the pull, with
//      no host in its output or log
//   §2 the swap: interrupted between its two renames, the previous clean
//      snapshot is put back and the last line says so; one a killed pull left
//      half done is put right by the next pull
//   §3 settings.env is written after the swap (and tried once more by the trap
//      when that failed); a failure once the uploads were being updated says
//      they may be newer than the snapshot, one before them does not, and one
//      after the swap says what is in place
//
// Standalone: node scripts/test-replica-pull.js. No server, no network.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PULL = path.join(ROOT, "scripts", "replica", "pull.sh");
const REMOTE = path.join(ROOT, "scripts", "replica", "remote");
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (cond, ms) => { const until = Date.now() + ms; while (!cond() && Date.now() < until) sleepMs(100); return cond(); };

// Every temporary folder goes when the runner exits, pass or fail.
const tempDirs = [];
process.on("exit", () => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p, base = os.tmpdir()) => { const d = fs.mkdtempSync(path.join(base, p)); tempDirs.push(d); return d; };
// pull.sh refuses a socket path over 86 characters (macOS's limit, less what
// ssh adds while creating it). A long temporary folder (macOS's per-user one)
// gives way to /var/tmp for the HOMEs.
const sockPath = (home) => path.join(home, "LogisX-replica", ".pull-conn.XXXXXX", "s");
const HOME_BASE = sockPath(path.join(os.tmpdir(), "rpull-XXXXXX")).length <= 86 ? os.tmpdir() : "/var/tmp";
const HOST = "root@fake-host.invalid";
const which = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
// A Unix socket file, left behind by a process that bound it and exited (what a
// killed ssh master leaves). Some sandboxes refuse to bind one: then false.
const makeSocket = (p) => spawnSync(process.execPath, ["-e", "require('net').createServer().listen(process.argv[1], () => process.exit(0))", p], { encoding: "utf8" }).status === 0 && fs.lstatSync(p).isSocket();
const CAN_BIND = makeSocket(path.join(tmp("rpull-probe-"), "s"));

// ---- the stand-ins (each runs as its own node program) ---------------------------------
// ssh: records each call in FAKE_LOG and acts out OpenSSH's connection sharing,
// with a plain file for the socket; the server program builds the server's
// folder from FAKE_FIXTURE, and the cleanup runs against FAKE_SERVER.
function fakeSsh() {
	const fs = require("fs");
	const path = require("path");
	const { spawnSync } = require("child_process");
	const out = (fd, s) => fs.writeSync(fd, s);
	const args = process.argv.slice(2);
	const o = {};
	let op = "";
	let noCommand = false;
	let background = false;
	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === "-o") { const kv = args[++i]; o[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); }
		else if (a === "-i") i++;
		else if (a === "-O") op = args[++i];
		else if (a === "-N") noCommand = true;
		else if (a === "-f") background = true;
		else if (!a.startsWith("-")) break;
	}
	const host = args[i];
	const cmd = args.slice(i + 1).join(" ");
	const sock = o.ControlPath || "";
	const rec = (r) => fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(r)}\n`);
	const pullPid = () => Number(fs.readFileSync(process.env.FAKE_PIDFILE, "utf8"));
	const [stopWhere, stopSig] = (process.env.FAKE_SIGNAL_AT || "").split(":");
	const stdinNull = (() => {
		try { const a = fs.fstatSync(0); return a.isCharacterDevice() && a.rdev === fs.statSync("/dev/null").rdev; } catch { return false; }
	})();
	if (op) {
		rec({ kind: op, path: sock, host, master: o.ControlMaster, persist: o.ControlPersist, stdinNull });
		if (!fs.existsSync(sock)) { out(2, `Control socket connect(${sock}): No such file or directory\n`); process.exit(255); }
		if (op === "exit" && process.env.FAKE_EXIT_FAILS) { out(2, "mux_client_request_terminate: master did not answer\n"); process.exit(255); }
		if (op === "exit") fs.rmSync(sock);
		process.exit(0);
	}
	if (o.ControlMaster === "yes") {
		const dirMode = (fs.statSync(path.dirname(sock)).mode & 0o777).toString(8);
		rec({
			kind: "master", path: sock, host, persist: o.ControlPersist, keepalive: `${o.ServerAliveInterval}x${o.ServerAliveCountMax}`, batch: o.BatchMode, noCommand, background, dirMode,
			forwarding: [o.ForwardAgent, o.ForwardX11, o.ClearAllForwardings, o.PermitLocalCommand].join(","),
		});
		if (process.env.FAKE_MASTER_FAIL) { out(2, `ssh: connect to host ${host.split("@").pop()} port 22: Connection refused\n`); process.exit(255); }
		fs.writeFileSync(sock, "");
		process.exit(0);
	}
	const shared = o.ControlMaster === "no" && sock && sock !== "none" && fs.existsSync(sock);
	// A session whose socket is gone: OpenSSH connects on its own, through
	// ProxyCommand when one is given.
	const kind = shared ? "mux" : o.ProxyCommand === "/usr/bin/false" ? "refused" : "direct";
	const what = cmd === "bash -s" ? "program" : cmd.startsWith("rsync --server") ? "rsync" : cmd.startsWith("rm -rf -- ") ? "cleanup" : "other";
	rec({ kind, what, master: o.ControlMaster, path: sock, host, proxy: o.ProxyCommand, keepalive: `${o.ServerAliveInterval}x${o.ServerAliveCountMax}` });
	if (kind === "refused") { out(2, "kex_exchange_identification: Connection closed by remote host\n"); process.exit(255); }
	let rc = 0;
	if (what === "program") {
		const input = fs.readFileSync(0, "utf8");
		const stamp = (/^STAMP=(.*)$/m.exec(input) || [])[1];
		const dir = path.join(process.env.FAKE_SERVER, "root", "logisx-replica-tmp", stamp);
		fs.mkdirSync(dir, { recursive: true });
		fs.cpSync(process.env.FAKE_FIXTURE, dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "manifest.json"), fs.readFileSync(process.env.FAKE_MANIFEST, "utf8").replace("__STAMP__", stamp));
		out(1, "replica-remote: temporary folder created\nreplica-remote: ready\n");
		// FAKE_READER_GONE: the pull's stdout reader exits on "ready"; wait for that.
		if (process.env.FAKE_READER_GONE) {
			const until = Date.now() + 10000;
			while (!fs.existsSync(process.env.FAKE_READER_GONE) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
		if (stopWhere === "program") process.kill(pullPid(), `SIG${stopSig}`);
	} else if (what === "cleanup") {
		// FAKE_SIGNAL_IN_CLEANUP: a second signal reaches the pull, and this step stops.
		if (process.env.FAKE_SIGNAL_IN_CLEANUP) { process.kill(pullPid(), `SIG${process.env.FAKE_SIGNAL_IN_CLEANUP}`); process.exit(143); }
		rc = spawnSync("bash", ["-c", cmd.split("/root/").join(`${process.env.FAKE_SERVER}/root/`)], { stdio: "inherit" }).status;
	}
	// FAKE_CONN_ENDS_AFTER=n: the shared connection ends once n sessions have used it.
	const ends = Number(process.env.FAKE_CONN_ENDS_AFTER || 0);
	if (kind === "mux" && ends) {
		const used = fs.readFileSync(process.env.FAKE_LOG, "utf8").split("\n").filter((l) => l.includes('"kind":"mux"')).length;
		if (used >= ends) fs.rmSync(sock, { force: true });
	}
	process.exit(rc);
}

// rsync: starts its -e command as rsync does (ssh, the host, rsync's server
// command), then copies from FAKE_SERVER, --delete included.
function fakeRsync() {
	const fs = require("fs");
	const path = require("path");
	const { spawnSync } = require("child_process");
	const args = process.argv.slice(2);
	let rsh = "";
	const pos = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-e") rsh = args[++i];
		else if (!args[i].startsWith("-")) pos.push(args[i]);
	}
	const [src, dest] = pos;
	const host = src.slice(0, src.indexOf(":"));
	const remote = src.slice(src.indexOf(":") + 1);
	const label = remote.startsWith("/root/logisx-replica-tmp/") ? "download" : path.basename(remote);
	fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ kind: "rsync", label, rsh })}\n`);
	const [cmd, ...opts] = rsh.split(/\s+/).filter(Boolean);
	// FAKE_DROP_SOCK_AT: the shared connection ends between the step's check and its start.
	if (process.env.FAKE_DROP_SOCK_AT === `rsync-${label}`) {
		const cp = opts.find((x) => x.startsWith("ControlPath="));
		if (cp) fs.rmSync(cp.slice("ControlPath=".length), { force: true });
	}
	const r = spawnSync(cmd, [...opts, host, "rsync", "--server", "--sender", ".", remote], { stdio: ["ignore", "ignore", "inherit"] });
	if (r.status !== 0) { fs.writeSync(2, "rsync: connection unexpectedly closed (0 bytes received so far) [receiver]\n"); process.exit(12); }
	if (process.env.FAKE_RSYNC_FAIL === label) { fs.writeSync(2, "rsync(4242): error: unexpected end of file\n"); process.exit(12); }
	for (const f of fs.readdirSync(dest)) fs.rmSync(path.join(dest, f), { recursive: true, force: true });
	fs.cpSync(path.join(process.env.FAKE_SERVER, remote), dest, { recursive: true });
	fs.writeSync(1, `Number of files: ${fs.readdirSync(dest).length}\n`);
	const [stopWhere, stopSig] = (process.env.FAKE_SIGNAL_AT || "").split(":");
	if (stopWhere === `rsync-${label}`) process.kill(Number(fs.readFileSync(process.env.FAKE_PIDFILE, "utf8")), `SIG${stopSig}`);
}

// mv: the real one, then SIGTERM to the pull right after the rename named in
// FAKE_STOP_AFTER_MV, as an interruption at that point would.
function fakeMv() {
	const fs = require("fs");
	const { spawnSync } = require("child_process");
	const args = process.argv.slice(2);
	const r = spawnSync(process.env.FAKE_REAL_MV, args, { stdio: "inherit" });
	if (r.status !== 0) process.exit(r.status === null ? 1 : r.status);
	if (process.env.FAKE_STOP_AFTER_MV && args.join(" ") === process.env.FAKE_STOP_AFTER_MV) process.kill(Number(fs.readFileSync(process.env.FAKE_PIDFILE, "utf8")), "SIGTERM");
}

// install: the real one, or a failure: every time (FAKE_INSTALL_FAIL=always) or
// the first time only (=once, remembered in FAKE_INSTALL_MARK).
function fakeInstall() {
	const fs = require("fs");
	const mode = process.env.FAKE_INSTALL_FAIL;
	if (mode === "always" || (mode === "once" && !fs.existsSync(process.env.FAKE_INSTALL_MARK))) {
		if (mode === "once") fs.writeFileSync(process.env.FAKE_INSTALL_MARK, "");
		fs.writeSync(2, "install: cannot create the file\n");
		process.exit(1);
	}
	const r = require("child_process").spawnSync(process.env.FAKE_REAL_INSTALL, process.argv.slice(2), { stdio: "inherit" });
	process.exit(r.status === null ? 1 : r.status);
}

// The pull's stdout reader for the broken-stdout run: it goes away once the
// server program says it is ready.
function stdoutReader() {
	let seen = "";
	process.stdin.on("data", (c) => {
		seen += c;
		if (seen.includes("replica-remote: ready")) process.exit(0);
	});
}

const BIN = tmp("rpull-bin-");
for (const [name, f] of [["ssh", fakeSsh], ["rsync", fakeRsync], ["mv", fakeMv], ["install", fakeInstall], ["stdout-reader", stdoutReader]]) {
	fs.writeFileSync(path.join(BIN, name), `#!${process.execPath}\n"use strict";\n(${f.toString()})();\n`, { mode: 0o755 });
}
const REAL = { mv: which("mv"), install: which("install") };

// What the server's program leaves for the download: a real database and Sheets
// copy, compressed by compress.js, the settings, and the manifest (its stamp
// filled in per run).
const FIX_STAMP = "20261011T0000Z-0f0f0f0f";
const FIXTURE = path.join(tmp("rpull-fx-"), FIX_STAMP);
fs.mkdirSync(FIXTURE, { mode: 0o700 });
{
	const db = new Database(path.join(FIXTURE, "app.db"));
	db.exec("CREATE TABLE loads (id INTEGER PRIMARY KEY, name TEXT)");
	const ins = db.prepare("INSERT INTO loads (name) VALUES (?)");
	for (let i = 0; i < 50; i++) ins.run(`load-${i}`);
	db.close();
	fs.writeFileSync(path.join(FIXTURE, "sheets.json"), JSON.stringify({ format: 1, spreadsheets: { s1: { role: "main", tabs: { "Job Tracking": [["Load ID"], ["1"]] } } } }));
	const r = spawnSync(process.execPath, [path.join(REMOTE, "compress.js"), `--stamp=${FIX_STAMP}`, `--parent=${path.dirname(FIXTURE)}`], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`compress.js failed: ${r.stderr}`);
	fs.writeFileSync(path.join(FIXTURE, "settings.env"), "PAYOUT_DAY=15\n");
}
const MANIFEST = path.join(tmp("rpull-mf-"), "manifest.json");
fs.writeFileSync(MANIFEST, JSON.stringify({
	stamp: "__STAMP__", snapshotAt: new Date().toISOString(),
	production: { commit: "0000000", node: "v22.23.2", timeZone: "UTC", timeZoneSource: "server" },
	database: { rows: { loads: 50 } }, sheets: { spreadsheets: [{ role: "main", tabs: 1, rows: 1 }] },
	scrub: { cleared: [] }, settings: { copied: ["PAYOUT_DAY"], skipped: [] },
}));

// One pull: a HOME holding a previous snapshot, settings and an upload; a
// server with files in uploads/, storage/ and evidence-archive/.
const allCalls = [];
function pull({ env = () => ({}), home, before, brokenStdout = false } = {}) {
	const h = home || tmp("rpull-", HOME_BASE);
	const R = path.join(h, "LogisX-replica");
	fs.mkdirSync(path.join(R, "clean"), { recursive: true });
	fs.writeFileSync(path.join(R, "clean", "manifest.json"), JSON.stringify({ stamp: "previous-pull", snapshotAt: new Date(Date.now() - 48 * 3600e3).toISOString() }));
	fs.writeFileSync(path.join(R, "clean", "previous-snapshot"), "x");
	fs.writeFileSync(path.join(R, "settings.env"), "PREVIOUS=1\n");
	fs.mkdirSync(path.join(R, "uploads"), { recursive: true });
	fs.writeFileSync(path.join(R, "uploads", "previous.pdf"), "x");
	if (before) before(R);
	const server = tmp("rpull-srv-");
	for (const [f, body] of [["uploads/a.pdf", "a"], ["uploads/sub/b.jpg", "b"], ["storage/s.json", "{}"], ["evidence-archive/e.txt", "e"]]) {
		const p = path.join(server, "var", "www", "logistics-app", f);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, body);
	}
	const work = tmp("rpull-calls-");
	const fakeLog = path.join(work, "calls.jsonl");
	fs.writeFileSync(fakeLog, "");
	const opts = {
		encoding: "utf8",
		timeout: 60000,
		env: {
			PATH: `${BIN}:${path.dirname(process.execPath)}:${process.env.PATH}`,
			HOME: h,
			...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
			LOGISX_PROD_SSH: HOST,
			FAKE_LOG: fakeLog, FAKE_SERVER: server, FAKE_FIXTURE: FIXTURE, FAKE_MANIFEST: MANIFEST,
			FAKE_PIDFILE: path.join(R, ".pull.lock", "pid"), FAKE_REAL_MV: REAL.mv, FAKE_REAL_INSTALL: REAL.install,
			FAKE_INSTALL_MARK: path.join(work, "install-failed-once"),
			...(brokenStdout ? { FAKE_READER_GONE: path.join(work, "reader-gone") } : {}),
			...env(R),
		},
	};
	// The broken stdout: the reader exits on "ready", the shell then closes its
	// own copy of the pipe and only then says the reader is gone.
	const r = brokenStdout
		? spawnSync("bash", ["-c", 'bash "$0" --force | { exec 3<&0 0</dev/null; "$1" <&3 3<&-; exec 3<&-; : >"$FAKE_READER_GONE"; }; exit "${PIPESTATUS[0]}"', PULL, path.join(BIN, "stdout-reader")], opts)
		: spawnSync("bash", [PULL, "--force"], opts);
	const readCalls = () => fs.readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const calls = readCalls();
	allCalls.push(calls);
	const logDir = path.join(R, "logs");
	const readLog = () => (fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.startsWith("pull-")).map((f) => fs.readFileSync(path.join(logDir, f), "utf8")).join("") : "");
	const sessions = calls.filter((c) => c.kind === "mux" || c.kind === "direct" || c.kind === "refused");
	return {
		r, R, server, calls, readCalls, log: readLog(), readLog, sessions,
		out: `${r.stdout}${r.stderr}`,
		master: calls.find((c) => c.kind === "master"),
		signIns: calls.filter((c) => c.kind === "master" || c.kind === "direct").length,
		connDirs: () => (fs.existsSync(R) ? fs.readdirSync(R).filter((f) => f.startsWith(".pull-conn.")) : []),
		serverFolders: fs.existsSync(path.join(server, "root", "logisx-replica-tmp")) ? fs.readdirSync(path.join(server, "root", "logisx-replica-tmp")) : [],
		locked: () => fs.existsSync(path.join(R, ".pull.lock")),
		clean: () => JSON.parse(fs.readFileSync(path.join(R, "clean", "manifest.json"), "utf8")).stamp,
		settings: () => fs.readFileSync(path.join(R, "settings.env"), "utf8"),
	};
}
const seq = (p) => p.sessions.map((c) => `${c.kind}:${c.what}`);
const indexOf = (p, pred) => p.calls.findIndex(pred);
const lastIndexOf = (p, pred) => p.calls.map(pred).lastIndexOf(true);
const isSession = (c) => c.kind === "mux" || c.kind === "direct" || c.kind === "refused";
const closedAfter = (p, pred) => {
	const exit = indexOf(p, (c) => c.kind === "exit" && p.master && c.path === p.master.path);
	return exit > lastIndexOf(p, pred);
};
const STOP_SWAP = (R) => ({ FAKE_STOP_AFTER_MV: `${path.join(R, "clean")} ${path.join(R, "clean.old")}` });

// ---- §1 the shared connection --------------------------------------------------------------
console.log("§1 one shared ssh connection");
{
	const p = pull();
	eq("a pull with the stand-ins exits 0", [p.r.status, p.r.status === 0 ? "" : p.out], [0, ""]);
	eq("it opens one shared connection", p.calls.filter((c) => c.kind === "master").length, 1);
	const m = p.master || {};
	ok("...first, before anything reaches the server", indexOf(p, (c) => c.kind === "master") >= 0 && indexOf(p, (c) => c.kind === "master") < indexOf(p, isSession));
	eq("...with its settings on the command line: ControlPersist 30, keepalive 15 s x 20, batch mode, no command, in the background", [m.persist, m.keepalive, m.batch, m.noCommand, m.background], ["30", "15x20", "yes", true, true]);
	eq("...agent and X11 forwarding, every port forwarding and local commands off", m.forwarding, "no,no,yes,no");
	ok("...its socket in a folder of its own in ~/LogisX-replica, mode 700", path.dirname(path.dirname(m.path || "")) === p.R && /^\.pull-conn\.[A-Za-z0-9]{6}$/.test(path.basename(path.dirname(m.path || ""))) && m.dirMode === "700", m);
	eq("every ssh joins it: the server program, the download, the cleanup, the three uploads", seq(p), ["mux:program", "mux:rsync", "mux:cleanup", "mux:rsync", "mux:rsync", "mux:rsync"]);
	ok("...each through that socket, never as a master, failing rather than signing in if it is gone", p.sessions.every((c) => c.path === m.path && c.master === "no" && c.proxy === "/usr/bin/false"));
	const rsyncs = p.calls.filter((c) => c.kind === "rsync");
	ok("...rsync through -e, with the same settings", rsyncs.length === 4 && rsyncs.every((c) => / -o ControlMaster=no /.test(` ${c.rsh} `) && c.rsh.includes(`-o ControlPath=${m.path}`) && c.rsh.includes("-o ProxyCommand=/usr/bin/false")), rsyncs.map((c) => c.rsh));
	ok("...each step checking the connection first", p.sessions.slice(1).every((s) => {
		const at = p.calls.indexOf(s);
		const prev = p.calls.indexOf(p.sessions[p.sessions.indexOf(s) - 1]);
		return p.calls.slice(prev + 1, at).some((c) => c.kind === "check" && c.path === m.path);
	}));
	eq("one sign-in for the whole pull (one Touch ID)", p.signIns, 1);
	ok("the connection is closed (ssh -O exit) after its last session", closedAfter(p, isSession));
	ok("...and its folder is removed", !fs.existsSync(path.dirname(m.path || "/nonexistent/x")) && p.connDirs().length === 0, p.connDirs());
	ok("the pull says so, in its output and log", /shared ssh connection open: \d+ s; every step below uses it/.test(p.out) && /shared ssh connection closed/.test(p.out) && /shared ssh connection open/.test(p.log) && /shared ssh connection closed/.test(p.log));
	eq("the new snapshot, its settings and the files are in place", [p.clean() !== "previous-pull", p.settings(), fs.readdirSync(path.join(p.R, "uploads")).sort(), p.serverFolders], [true, "PAYOUT_DAY=15\n", ["a.pdf", "sub"], []]);
	ok("no host in the output or the log", !/fake-host/.test(p.out + p.log));
	sleepMs(3000);
	eq("the watchdog was stopped with the connection: no close request after the pull", p.readCalls().filter((c) => c.kind === "exit").length, 1);
}
{
	const p = pull({ env: () => ({ FAKE_RSYNC_FAIL: "download" }) });
	ok("a failed download fails the pull", p.r.status !== 0 && /FAILED \(exit \d+\)/.test(p.r.stderr), p.out);
	eq("...the trap's server cleanup still goes through the shared connection", seq(p), ["mux:program", "mux:rsync", "mux:cleanup"]);
	ok("...the server's folder is removed", p.serverFolders.length === 0, p.serverFolders);
	ok("...then the connection is closed and its folder removed", closedAfter(p, isSession) && p.connDirs().length === 0, p.connDirs());
	eq("...with one sign-in", p.signIns, 1);
}
for (const [where, sig, expected] of [["program", "TERM", ["mux:program", "mux:cleanup"]], ["rsync-storage", "INT", ["mux:program", "mux:rsync", "mux:cleanup", "mux:rsync", "mux:rsync"]]]) {
	const p = pull({ env: () => ({ FAKE_SIGNAL_AT: `${where}:${sig}` }) });
	ok(`an interruption (SIG${sig} during ${where === "program" ? "the server program" : "the uploads"}) exits 130`, p.r.status === 130, p.out);
	eq("...every ssh before and in the trap uses the shared connection", seq(p), expected);
	ok("...the connection is closed after them and its folder removed", closedAfter(p, isSession) && p.connDirs().length === 0, p.connDirs());
	ok("...the server's folder is gone", p.serverFolders.length === 0, p.serverFolders);
}
{
	const p = pull({ env: () => ({ FAKE_SIGNAL_AT: "program:TERM", FAKE_SIGNAL_IN_CLEANUP: "TERM" }) });
	ok("a second signal while the trap removes the server's folder stops only that step", p.r.status !== 0 && /removing the server's temporary folder \(a Ctrl-C now skips this, and the next pull removes that folder once it is an hour old\)/.test(p.r.stderr) && /could not confirm the server's temporary folder/.test(p.r.stderr), p.out);
	ok("...the trap still closes the connection, removes its folder and the lock, and says what it left", closedAfter(p, isSession) && p.connDirs().length === 0 && !p.locked() && /FAILED \(exit 1\); the clean snapshot and settings\.env were left as they were/.test(p.r.stderr), [p.connDirs(), p.locked(), p.r.stderr]);
}
{
	const p = pull({ brokenStdout: true, env: () => ({ FAKE_SIGNAL_AT: "program:TERM" }) });
	ok("with stdout gone (its reader exited), an interrupted pull's trap still runs to its end", p.r.status === 130 && /FAILED \(exit 130\)/.test(p.r.stderr), [p.r.status, p.r.stderr]);
	ok("...removing the server's folder over the shared connection, closing it, and removing its folder and the lock", seq(p).join() === "mux:program,mux:cleanup" && p.serverFolders.length === 0 && closedAfter(p, isSession) && p.connDirs().length === 0 && !p.locked(), [seq(p), p.serverFolders, p.connDirs(), p.locked()]);
}
{
	const p = pull({ env: () => ({ FAKE_SIGNAL_AT: "program:KILL" }) });
	const sockAt = p.master && p.master.path;
	const closed = waitFor(() => p.readCalls().some((c) => c.kind === "exit" && c.path === sockAt) && p.connDirs().length === 0, 10000);
	ok("a pull killed outright (SIGKILL, no trap): its watchdog closes the connection and removes its folder within seconds", p.r.signal === "SIGKILL" && closed, [p.r.signal, p.connDirs()]);
	ok("...and notes it in the pull's log", /watchdog: the pull ended without closing the shared ssh connection; it is closed/.test(p.readLog()));
}
{
	const p = pull({ env: () => ({ FAKE_EXIT_FAILS: "1" }) });
	ok("a close request that fails says how the connection ends", p.r.status === 0 && /the shared ssh connection did not close when asked; it ends by itself within 30 s of its last session/.test(p.out) && /did not close when asked/.test(p.log), p.out);
	ok("...and its folder is removed all the same", p.connDirs().length === 0, p.connDirs());
}
{
	let elsewhere;
	let target;
	const p = pull({
		before: (R) => {
			fs.mkdirSync(path.join(R, ".pull-conn.Ab12Cd"), { mode: 0o700 });
			fs.writeFileSync(path.join(R, ".pull-conn.Ab12Cd", "s"), "");
			fs.mkdirSync(path.join(R, ".pull-conn.Zz99Yy"), { mode: 0o700 });
			elsewhere = tmp("rpull-elsewhere-");
			fs.writeFileSync(path.join(elsewhere, "keep"), "x");
			fs.symlinkSync(elsewhere, path.join(R, ".pull-conn.Link01"));
			// A link named s, to a socket where one can be made, else to a file.
			target = path.join(elsewhere, "other-socket");
			if (!CAN_BIND || !makeSocket(target)) fs.writeFileSync(target, "");
			fs.mkdirSync(path.join(R, ".pull-conn.Sym123"), { mode: 0o700 });
			fs.symlinkSync(target, path.join(R, ".pull-conn.Sym123", "s"));
			if (CAN_BIND) {
				fs.mkdirSync(path.join(R, ".pull-conn.Sock01"), { mode: 0o700 });
				makeSocket(path.join(R, ".pull-conn.Sock01", "s"));
			}
		},
	});
	const exits = p.calls.filter((c) => c.kind === "exit" && !(p.master && c.path === p.master.path)).map((c) => path.basename(path.dirname(c.path)));
	eq("the next pull sends a close request only to a socket a stopped pull left: never to a file or a link", exits, CAN_BIND ? [".pull-conn.Sock01"] : []);
	if (CAN_BIND) ok("...before opening its own connection", indexOf(p, (c) => c.kind === "exit" && c.path.includes(".pull-conn.Sock01")) < indexOf(p, (c) => c.kind === "master"));
	else console.log("  gap  ...a stopped pull's live socket gets a close request: this environment cannot create a Unix socket (sandboxed); CI runs it");
	ok("...every -O request it sends reads /dev/null and names ControlMaster=no", p.calls.filter((c) => c.kind === "exit").every((c) => c.master === "no" && c.stdinNull));
	eq("...it removes the folders stopped pulls left (a symlinked folder is left alone)", p.connDirs(), [".pull-conn.Link01"]);
	ok("...never following a link", fs.existsSync(path.join(elsewhere, "keep")) && fs.existsSync(target));
	ok("...and says how many it removed", new RegExp(`removed ${CAN_BIND ? 4 : 3} shared ssh connection folder\\(s\\) a stopped pull left`).test(p.out), p.out);
}
{
	const p = pull({ env: () => ({ FAKE_CONN_ENDS_AFTER: "1" }) });
	ok("a shared connection that closes mid-pull fails the pull, saying so", p.r.status === 1 && /the shared ssh connection to production closed before the download \(the network dropped, or no step ran for 30 s\); the clean snapshot was not replaced\. Run the pull again/.test(p.r.stderr), p.out);
	ok("...the trap says its cleanup needs a new connection", /removing the server's temporary folder takes a new one \(Touch ID\)/.test(p.r.stderr));
	eq("...only that cleanup connects again", seq(p), ["mux:program", "direct:cleanup"]);
	const d = p.sessions.find((c) => c.kind === "direct") || {};
	eq("...on a connection of its own (ControlPath=none, no ProxyCommand), with keepalive 15 s x 8", [d.path, d.proxy, d.keepalive], ["none", undefined, "15x8"]);
	ok("...the server's folder is removed and the connection's folder too", p.serverFolders.length === 0 && p.connDirs().length === 0, [p.serverFolders, p.connDirs()]);
	eq("...nothing local changed", [p.clean(), p.settings()], ["previous-pull", "PREVIOUS=1\n"]);
}
{
	const p = pull({ env: () => ({ FAKE_DROP_SOCK_AT: "rsync-download" }) });
	ok("a step whose socket went away after its check fails instead of signing in again", p.r.status !== 0 && /FAILED/.test(p.r.stderr), p.out);
	eq("...no new connection for it: only the trap's cleanup connects, on purpose", seq(p), ["mux:program", "refused:rsync", "direct:cleanup"]);
	eq("...two sign-ins in all (the shared connection and the cleanup's)", p.signIns, 2);
	ok("...the server's folder is removed and the connection's folder too", p.serverFolders.length === 0 && p.connDirs().length === 0, [p.serverFolders, p.connDirs()]);
}
{
	const p = pull({ env: () => ({ FAKE_MASTER_FAIL: "1" }) });
	ok("a connection that cannot open stops the pull before anything else reaches the server", p.r.status === 1 && /could not open the ssh connection to production/.test(p.r.stderr) && p.sessions.length === 0, p.out);
	ok("...showing ssh's reason without the host, in the output and the log", /ssh: connect to host <host> port 22: Connection refused/.test(p.out) && /ssh: connect to host <host> port 22: Connection refused/.test(p.log) && !/fake-host/.test(p.out + p.log), p.out);
	ok("...and removes the connection's folder and the lock", p.connDirs().length === 0 && !p.locked());
}
{
	const home = path.join(tmp("rpull-", HOME_BASE), "h".repeat(60));
	fs.mkdirSync(home);
	const p = pull({ home });
	ok("a socket path too long for macOS stops the pull before any connection", p.r.status === 1 && /over the 86 macOS allows/.test(p.r.stderr) && p.calls.filter((c) => c.kind === "master" || isSession(c)).length === 0, p.out);
	ok("...and removes the connection's folder", p.connDirs().length === 0, p.connDirs());
}
{
	const ctl = allCalls.flat().filter((c) => c.kind === "check" || c.kind === "exit");
	ok("every ssh -O request in these runs names ControlMaster=no and ControlPersist=no and reads /dev/null", ctl.length > 20 && ctl.every((c) => c.master === "no" && c.persist === "no" && c.stdinNull), ctl.filter((c) => !(c.master === "no" && c.persist === "no" && c.stdinNull)).slice(0, 3));
	const src = fs.readFileSync(PULL, "utf8");
	const sshLines = src.split("\n").filter((l) => /^\s*(if ! )?ssh /.test(l) || /RSH="ssh /.test(l));
	ok("pull.sh starts ssh in five places only: the -O helper, the two session helpers, the master and rsync's -e", sshLines.length === 5, sshLines);
}

// ---- §2 the swap --------------------------------------------------------------------------
console.log("§2 an interrupted swap");
{
	const p = pull({ env: STOP_SWAP });
	ok("an interruption between the swap's two renames exits 130", p.r.status === 130, p.out);
	ok("...and puts the previous clean snapshot back", fs.existsSync(path.join(p.R, "clean", "previous-snapshot")) && p.clean() === "previous-pull");
	eq("...leaving no clean.old/ or clean.incoming/", ["clean.old", "clean.incoming"].filter((d) => fs.existsSync(path.join(p.R, d))), []);
	ok("...and says so", /FAILED \(exit 130\); the swap was interrupted, so the previous clean snapshot was put back/.test(p.r.stderr), p.r.stderr);
}
{
	// What a pull killed between the renames leaves: clean.old/ and no clean/.
	const p = pull({ before: (R) => fs.renameSync(path.join(R, "clean"), path.join(R, "clean.old")), env: () => ({ FAKE_MASTER_FAIL: "1" }) });
	ok("the next pull puts that snapshot back once it holds the lock, and says so", /a pull stopped during its swap left no clean\/; its previous snapshot was put back/.test(p.out) && fs.existsSync(path.join(p.R, "clean", "previous-snapshot")) && !fs.existsSync(path.join(p.R, "clean.old")), p.out);
	const src = fs.readFileSync(PULL, "utf8");
	ok("...and makes clean/ only after that", /^for d in logs uploads storage evidence-archive work; do/m.test(src) && src.search(/^if restore_clean; then$/m) > src.search(/^echo "\$PULL_PID" >"\$LOCK\/pid"$/m) && src.search(/^mkdir -p "\$ROOT\/clean"$/m) > src.search(/^if restore_clean; then$/m));
}

// ---- §3 settings and the uploads -----------------------------------------------------------
console.log("§3 settings.env after the swap; what a failure left");
{
	const src = fs.readFileSync(PULL, "utf8");
	const at = (re) => src.search(re);
	ok("settings.env is written after the swap (and only there and in the trap's retry)", at(/^mv "\$INCOMING" "\$ROOT\/clean"$/m) > 0 && at(/^install -m 600 "\$ROOT\/clean\/settings\.env" "\$ROOT\/settings\.env"$/m) > at(/^mv "\$INCOMING" "\$ROOT\/clean"$/m) && (src.match(/"\$ROOT\/settings\.env"/g) || []).length === 2);
	const swap = pull({ env: STOP_SWAP });
	eq("an interrupted swap leaves settings.env as it was", swap.settings(), "PREVIOUS=1\n");
	ok("...and says the uploads may be newer than the snapshot", /settings\.env was left as it was; uploads\/, storage\/ and evidence-archive\/ were being updated and may be newer than the snapshot/.test(swap.r.stderr), swap.r.stderr);
	const mid = pull({ env: () => ({ FAKE_SIGNAL_AT: "rsync-storage:INT" }) });
	ok("an interruption during the uploads says they may be newer, the snapshot and settings untouched", mid.r.status === 130 && /the clean snapshot and settings\.env were left as they were; uploads\/, storage\/ and evidence-archive\/ were being updated and may be newer than the snapshot/.test(mid.r.stderr) && mid.clean() === "previous-pull" && mid.settings() === "PREVIOUS=1\n", mid.r.stderr);
	const early = pull({ env: () => ({ FAKE_RSYNC_FAIL: "download" }) });
	ok("a failure before the uploads says nothing of them", /the clean snapshot and settings\.env were left as they were\. Log: /.test(early.r.stderr) && !/may be newer/.test(early.r.stderr) && fs.readdirSync(path.join(early.R, "uploads")).join() === "previous.pdf", early.r.stderr);
	const late = pull({ env: () => ({ FAKE_INSTALL_FAIL: "always" }) });
	ok("settings.env failing twice after the swap: the new snapshot is in place and the settings are the previous pull's", late.r.status !== 0 && /the new clean snapshot is in place, but settings\.env is still the previous pull's \(run the pull again with --force\)/.test(late.r.stderr) && late.clean() !== "previous-pull" && late.settings() === "PREVIOUS=1\n", late.r.stderr);
	ok("...and leaves no clean.old/", !fs.existsSync(path.join(late.R, "clean.old")));
	const retry = pull({ env: () => ({ FAKE_INSTALL_FAIL: "once" }) });
	ok("settings.env failing once after the swap: the trap's second try writes it, and the last line says both are in place", retry.r.status !== 0 && retry.settings() === "PAYOUT_DAY=15\n" && retry.clean() !== "previous-pull" && /FAILED \(exit 1\); the new clean snapshot and its settings are in place\. Log: /.test(retry.r.stderr), retry.r.stderr);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
