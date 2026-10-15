// Shared by the replica:* scripts (pull-local.js, start.js, login.mjs, clean.js):
// where the local copy lives and how a task's server is recorded and stopped.
//
//   ~/LogisX-replica/            (700; never inside a checkout, never under Documents)
//     clean/                     app.db, sheets.json, manifest.json: the latest pull
//     uploads/ storage/ evidence-archive/   production's files (rsync targets)
//     settings.env               production's non-secret settings (600)
//     work/<task>/               a task's working copy: clones of all of the above
//       server.json              the running server: pid, port, code dir, log
//       mcp-state.json           the session files this task saved (mcp-state.js)
//     mcp/                       sessions for the Playwright MCP (mcp-state.js)
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

// A refused --enable word as it may be printed: what follows "=" is never
// shown, and a word that looks like a key (rules.looksLikeToken) is not shown
// at all, so a value typed by mistake never reaches the screen or a log.
function shownWord(word) {
	const name = word.replace(/=.*$/s, "");
	if (rules.looksLikeToken(name)) return "(not shown: it looks like a key)";
	return (name === word ? name : `${name}=...`).slice(0, 64);
}

// The flags --enable names (each --enable takes the next word), checked against
// lib/replica-rules.js before anything starts: sorted, without repeats. Any
// refusal ends the run.
function enableArgs(argv) {
	const names = new Set();
	const refused = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--enable") continue;
		const name = argv[i + 1];
		if (name === undefined || name.startsWith("--")) fail("--enable needs a setting name, e.g. --enable PERSONAL_EXPENSE_DEDUCTIONS_ENABLED");
		const why = rules.enableRefusal(name);
		if (why) refused.push(`--enable ${shownWord(name)}: ${why}`);
		else names.add(name);
		i++;
	}
	if (refused.length) fail(`refusing to start:\n  ${refused.join("\n  ")}`);
	return [...names].sort();
}

// --from-month YYYY-MM, given once, for the enabled flags that need a first
// month (rules.ENABLE_FROM): the settings to add to the task's environment,
// e.g. { LEDGER_DAY_ONCE_FROM: "2026-10" }. Refused before anything starts
// when such a flag has no month, when there is a month but no such flag, or
// when the month isn't YYYY-MM (the value is never printed).
function fromMonthArg(argv, enabled) {
	const at = argv.reduce((acc, a, i) => (a === "--from-month" ? [...acc, i] : acc), []);
	if (at.length > 1) fail("give --from-month once (it applies to every enabled rule that needs a first month)");
	const needing = enabled.filter((name) => Object.prototype.hasOwnProperty.call(rules.ENABLE_FROM, name));
	if (!at.length) {
		if (needing.length) {
			fail(`refusing to start: ${needing.map((n) => `${n} does nothing without its first month (${rules.ENABLE_FROM[n]})`).join("; ")}. ` +
				"Add --from-month YYYY-MM, which sets it for this task only.");
		}
		return {};
	}
	const month = argv[at[0] + 1];
	if (!rules.isFromMonth(month)) fail("--from-month needs a month, YYYY-MM (a year 2000-2099, a month 01-12), e.g. --from-month 2026-10");
	if (!needing.length) {
		fail(`--from-month sets the first month of ${Object.keys(rules.ENABLE_FROM).join(" or ")}; enable one of them with --enable too`);
	}
	return Object.fromEntries(needing.map((n) => [rules.ENABLE_FROM[n], month]));
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writePrivate(file, text) {
	fs.writeFileSync(file, text, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

// The real path of `p`, through its nearest existing ancestor (symlinks resolved).
function realOf(p) {
	const abs = path.resolve(p);
	try { return fs.realpathSync(abs); } catch {
		const parent = path.dirname(abs);
		return parent === abs ? abs : path.join(realOf(parent), path.basename(abs));
	}
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

// "running", "gone" (no such process) or "unknown" (the system refused to say:
// EPERM inside a sandbox, or another user's process). Only "gone" proves a
// recorded server has stopped.
function pidState(pid) {
	try {
		process.kill(pid, 0);
		return "running";
	} catch (err) {
		return err.code === "ESRCH" ? "gone" : "unknown";
	}
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

// The sheet IDs a working copy's Sheets copy holds, by role (sheets-export.js
// writes { role } on each book). replica:start hands them to the server, which
// refuses to start without a SPREADSHEET_ID (lib/sheet-id.js); the replica's
// Sheets stub answers for exactly these books.
function replicaSheetIds(sheetsJsonPath) {
	const doc = readJson(sheetsJsonPath);
	const byRole = (role) => Object.keys(doc.spreadsheets || {}).find((id) => (doc.spreadsheets[id] || {}).role === role) || "";
	const main = byRole("main");
	if (!main) throw new Error(`${sheetsJsonPath} holds no main sheet; run npm run replica:pull again`);
	const ids = { SPREADSHEET_ID: main };
	const archive = byRole("archive");
	if (archive) ids.ARCHIVE_SPREADSHEET_ID = archive;
	return ids;
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
	enableArgs,
	fromMonthArg,
	readJson,
	writePrivate,
	realOf,
	cwdOf,
	commandOf,
	alive,
	pidState,
	runningServer,
	dirStats,
	mib,
	replicaSheetIds,
};
