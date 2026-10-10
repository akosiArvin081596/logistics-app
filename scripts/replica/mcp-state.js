// The signed-in session `replica:login --mcp-state <user>` hands the Playwright
// MCP, and how replica:clean takes it back. Used by login.mjs and clean.js.
//
//   ~/LogisX-replica/mcp/            (700)
//     <user>.json                    Playwright storage state, cookies only (600)
//     active.json                    the file the MCP loads (--isolated
//                                    --storage-state): a link to the <user>.json
//                                    saved last, or an empty state once that
//                                    session has been taken back
//   ~/LogisX-replica/work/<task>/mcp-state.json
//                                    the session files this task saved (names
//                                    only, no cookie); replica:clean reads it
//
// Only the replica's own cookies are kept. A state taken from anything but a
// loopback address, or holding a cookie for any other host, is refused and
// nothing is written, so a staging or production session never lands here.
// Signing out in the browser ends the session on the server (POST
// /api/auth/logout destroys it in the working copy's session store).
// replica:clean signs the task's sessions out the same way, deletes their files
// and then the working copy with its store.
"use strict";

const fs = require("fs");
const path = require("path");
const C = require("./common");

const REPO = path.resolve(__dirname, "..", "..");
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
const EMPTY_STATE = Object.freeze({ cookies: [], origins: [] });
const FILE_RE = /^[a-z0-9_][a-z0-9._-]*\.json$/;

const dirOf = (root) => path.join(root, "mcp");
const activeOf = (root) => path.join(dirOf(root), "active.json");
const taskRecordOf = (root, task) => path.join(root, "work", task, "mcp-state.json");

// One file per account, named after its username ("Jane Doe" -> jane-doe.json).
function fileNameFor(user) {
	const name = String(user || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/-+$/, "");
	if (!name || name === "active") throw new Error(`no session file name can be made from the username ${JSON.stringify(user)}`);
	return `${name}.json`;
}

// The cookies of the replica's own host and nothing else: local storage is
// dropped, and a cookie for any other host refuses the whole state.
function cookiesOnly(state, base) {
	const host = new URL(base).hostname;
	if (!LOOPBACK.has(host)) throw new Error(`a session is saved only from the replica on this Mac, not from ${host}`);
	const cookies = Array.isArray(state && state.cookies) ? state.cookies : [];
	const foreign = [...new Set(cookies.map((c) => String(c.domain || "").replace(/^\./, "")).filter((d) => d !== host))];
	if (foreign.length) throw new Error(`the browser held cookies for another host (${foreign.join(", ")}); nothing was saved`);
	if (!cookies.length) throw new Error("the sign-in left no cookie to save");
	return { cookies, origins: [] };
}

function ensureDir(root) {
	const dir = dirOf(root);
	const real = C.realOf(dir);
	const repo = C.realOf(REPO);
	if (real === repo || real.startsWith(repo + path.sep)) throw new Error(`${dir} is inside the repository; a session file never is`);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	return dir;
}

// Written beside the target and renamed over it, so the MCP never reads half a
// file; a rename over the active.json link replaces the link, not its target.
function writeAtomic(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	C.writePrivate(tmp, text);
	fs.renameSync(tmp, file);
}

function pointActive(root, fileName) {
	const active = activeOf(root);
	const tmp = `${active}.${process.pid}.tmp`;
	fs.rmSync(tmp, { force: true });
	fs.symlinkSync(fileName, tmp);
	fs.renameSync(tmp, active);
}

// The MCP fails every browser call when its --storage-state file is missing, so
// active.json is left an empty (signed-out) state rather than removed.
function ensureActive(root = C.ROOT) {
	ensureDir(root);
	if (!fs.existsSync(activeOf(root))) writeAtomic(activeOf(root), `${JSON.stringify(EMPTY_STATE)}\n`);
}

function readTaskRecord(root, task) {
	const file = taskRecordOf(root, task);
	if (!fs.existsSync(file)) return [];
	const files = C.readJson(file).files;
	if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && FILE_RE.test(f) && f !== "active.json")) {
		throw new Error(`${file} is not a list of session files; remove the files in ${dirOf(root)} yourself`);
	}
	return files;
}

// Saves the signed-in browser's cookies for `user` and points active.json at
// them. The task records the file first, so replica:clean can always find it.
function save({ root = C.ROOT, task, user, state, base }) {
	const kept = cookiesOnly(state, base);
	ensureDir(root);
	const fileName = fileNameFor(user);
	const files = readTaskRecord(root, task);
	if (!files.includes(fileName)) files.push(fileName);
	C.writePrivate(taskRecordOf(root, task), `${JSON.stringify({ files }, null, 2)}\n`);
	const file = path.join(dirOf(root), fileName);
	writeAtomic(file, `${JSON.stringify(kept, null, 2)}\n`);
	pointActive(root, fileName);
	return file;
}

// Ends a saved session on the server with the request the app's Sign out sends,
// so a browser that already loaded the cookie is signed out too.
async function signOut(file, port) {
	const { cookies } = C.readJson(file);
	if (!Array.isArray(cookies) || !cookies.length) return false;
	const res = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
		method: "POST",
		headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "), "X-Requested-With": "XMLHttpRequest" },
		signal: AbortSignal.timeout(5000),
	});
	return res.ok;
}

// Takes back every session the task saved: signs each one out on the task's
// server when `port` names it (only a server replica:clean verified), deletes
// its file (a file is per account, so one a later task saved over goes too:
// sign in again) and leaves active.json a signed-out state.
async function revoke({ root = C.ROOT, task, port }) {
	const removed = [];
	for (const fileName of readTaskRecord(root, task)) {
		const file = path.join(dirOf(root), fileName);
		if (!fs.lstatSync(file, { throwIfNoEntry: false })) continue;
		const signedOut = port ? await signOut(file, port).catch(() => false) : false;
		fs.rmSync(file);
		removed.push({ file, signedOut });
	}
	fs.rmSync(taskRecordOf(root, task), { force: true });
	ensureActive(root);
	return removed;
}

module.exports = { EMPTY_STATE, dirOf, activeOf, taskRecordOf, fileNameFor, cookiesOnly, ensureActive, save, revoke };
