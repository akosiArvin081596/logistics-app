#!/usr/bin/env node
// npm run replica:clean -- [--task <name>]
//
// Takes back the sessions replica:login --mcp-state saved for the task, stops
// the task's replica server and deletes its working copy
// (~/LogisX-replica/work/<name>/). The clean snapshot, the copied files, the
// settings, the logs and the screenshots stay.
//
// The sessions go first (mcp-state.js): each one's row is deleted from the
// working copy's session store (what Sign out does), its file is deleted and the
// MCP's active.json is left signed out, even when the server cannot be stopped
// below.
//
// The server is stopped only by the PID replica:start recorded, and only while
// that PID is still a `node server.js` whose working directory is the recorded
// code directory (lsof). Anything else is never signalled. The working copy is
// deleted only once that PID is shown to be gone: when the system won't say
// (inside a sandbox), the copy is kept and the command fails.
"use strict";

const fs = require("fs");
const path = require("path");
const C = require("./common");
const M = require("./mcp-state");

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--task") { i++; continue; }
	C.fail(`unknown option ${argv[i]}`);
}
const task = C.taskArg(argv);
const work = C.paths.work(task);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stop() {
	const rec = C.paths.serverRecord(task);
	if (!fs.existsSync(rec)) return console.log(`replica: no server recorded for task ${task}`);
	const server = C.runningServer(task);
	if (!server) {
		const r = C.readJson(rec);
		// Only a pid shown to be gone lets the working copy go. One the system
		// won't report on (inside a sandbox) may be the server, still serving it.
		const state = Number.isInteger(r.pid) ? C.pidState(r.pid) : "unknown";
		if (state === "unknown") {
			C.fail(`could not check whether the recorded pid ${r.pid} is still running (the system refused to say, ` +
				"as it does inside a sandbox). Nothing was signalled and the working copy was kept; run " +
				`npm run replica:clean -- --task ${task} again on its own, outside the sandbox.`);
		}
		// A live process that cannot be shown to be this task's server may still
		// be using the working copy: nothing is signalled and nothing is deleted.
		if (state === "running") {
			C.fail(`the recorded pid ${r.pid} is running but cannot be verified as this task's server ` +
				`(command: ${C.commandOf(r.pid) || "unknown"}; working directory: ${C.cwdOf(r.pid) || "unknown"}). ` +
				"Nothing was signalled and the working copy was kept; stop that process yourself if it is the replica, then run this again.");
		}
		return console.log(`replica: the recorded pid ${r.pid} is not running; nothing to stop`);
	}
	process.kill(server.pid, "SIGTERM");
	for (let i = 0; i < 30 && C.pidState(server.pid) === "running"; i++) await sleep(500);
	if (C.pidState(server.pid) === "running" && C.runningServer(task)) {
		process.kill(server.pid, "SIGKILL");
		await sleep(500);
	}
	if (C.pidState(server.pid) !== "gone") C.fail(`pid ${server.pid} is still running, or can't be checked; the working copy was kept`);
	console.log(`replica: stopped pid ${server.pid} (task ${task}, port ${server.port})`);
}

async function main() {
	if (!path.resolve(work).startsWith(path.join(C.ROOT, "work") + path.sep)) C.fail("unexpected working copy path");
	const { removed, recordError } = M.revoke({ task });
	if (recordError) console.log(`replica: ${recordError}; the task's sessions were found in its working copy instead`);
	if (!removed.length) console.log(`replica: no Playwright MCP session saved for task ${task}`);
	for (const r of removed) {
		console.log(`replica: ended the Playwright MCP session ${path.basename(r.file)} and deleted its file` +
			(r.ended ? "" : " (it had already ended)"));
	}
	await stop();
	if (fs.existsSync(work)) {
		fs.rmSync(work, { recursive: true, force: true });
		console.log(`replica: deleted the working copy ${work}`);
	} else {
		console.log(`replica: no working copy for task ${task}`);
	}
	const kept = ["clean", "settings.env", ...C.DATA_FOLDERS].filter((n) => fs.existsSync(path.join(C.ROOT, n)));
	console.log(`replica: kept in ${C.ROOT}: ${kept.join(", ")}`);
}

main().catch((err) => C.fail(err.message));
