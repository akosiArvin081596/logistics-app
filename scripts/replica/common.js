// Shared by the replica:* scripts (pull-local.js, start.js, login.mjs, clean.js):
// where the local copy lives and how a task's server is recorded and stopped.
//
//   ~/LogisX-replica/            (700; never inside a checkout, never under Documents)
//     clean/                     app.db, sheets.json, manifest.json: the latest pull
//     uploads/ storage/ evidence-archive/   production's files (rsync targets)
//     settings.env               production's non-secret settings (600)
//     work/<task>/               a task's working copy: clones of all of the above
//       server.json              the running server: pid, port, code dir, log
//     code/<commit>/             a worktree of production's commit (--prod-commit)
//     logs/                      pull, server and outbound-guard logs
//     screens/                   screenshots
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const rules = require("../../lib/replica-rules");

const ROOT = path.join(os.homedir(), "LogisX-replica");
const DATA_FOLDERS = Object.freeze(["uploads", "storage", "evidence-archive"]);
const DEFAULT_PORT = 3901;
// Ports other local stacks and sessions use; a replica never takes one.
const RESERVED_PORTS = Object.freeze([3000, 3003, 5173, 3016, 3107, 13093]);

const paths = {
	root: ROOT,
	clean: path.join(ROOT, "clean"),
	settings: path.join(ROOT, "settings.env"),
	logs: path.join(ROOT, "logs"),
	screens: path.join(ROOT, "screens"),
	code: path.join(ROOT, "code"),
	work: (task) => path.join(ROOT, "work", task),
	data: (folder) => path.join(ROOT, folder),
	serverRecord: (task) => path.join(ROOT, "work", task, "server.json"),
};

function fail(msg) {
	console.error(`replica: ${msg}`);
	process.exit(1);
}

function taskArg(argv) {
	const i = argv.indexOf("--task");
	const task = i >= 0 ? argv[i + 1] : "default";
	if (!rules.isValidTask(task)) fail("--task must be lower-case letters, digits and dashes (up to 48)");
	return task;
}

function optionValue(argv, name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writePrivate(file, text) {
	fs.writeFileSync(file, text, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

// The working directory of a pid, as lsof reports it ("" when unknown).
function cwdOf(pid) {
	try {
		const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const line = out.split("\n").find((l) => l.startsWith("n"));
		return line ? line.slice(1) : "";
	} catch {
		return "";
	}
}

function commandOf(pid) {
	try {
		return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function alive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

// The task's server, when the recorded pid is still that server: a node
// server.js whose working directory is the recorded code directory. A reused
// pid, or another app's server, is never treated as ours.
function runningServer(task) {
	const rec = paths.serverRecord(task);
	if (!fs.existsSync(rec)) return null;
	const r = readJson(rec);
	if (!Number.isInteger(r.pid) || !alive(r.pid)) return null;
	if (!/server\.js/.test(commandOf(r.pid))) return null;
	if (cwdOf(r.pid) !== r.codeDir) return null;
	return r;
}

function dirStats(dir) {
	let files = 0;
	let bytes = 0;
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) { files++; bytes += fs.statSync(p).size; }
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return { files, bytes };
}

function mib(bytes) {
	return `${(bytes / 1048576).toFixed(1)} MiB`;
}

module.exports = {
	ROOT,
	DATA_FOLDERS,
	DEFAULT_PORT,
	RESERVED_PORTS,
	paths,
	fail,
	taskArg,
	optionValue,
	readJson,
	writePrivate,
	cwdOf,
	commandOf,
	alive,
	runningServer,
	dirStats,
	mib,
};
