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
//                                    only, no cookie)
//
// Only the replica's own cookies are kept. A state taken from anything but a
// loopback address, or holding a cookie for any other host, is refused and
// nothing is written, so a staging or production session never lands here.
// The cookie still goes to every port on 127.0.0.1 (an e2e server on :3181
// included), where another server's own session cookie replaces it. The MCP must
// run without `--caps storage`, whose cookie tools would show its value.
//
// A session ends where Sign out ends it: its row in the working copy's session
// store (`sessions`, the express-session SQLite store) is deleted. That works
// with the task's server running, stopped or unverifiable, and holds for a
// browser that already loaded the cookie. Saving an account again ends its
// earlier session first, whichever task saved it; replica:clean ends the task's.
"use strict";

const fs = require("fs");
const path = require("path");
const C = require("./common");

const REPO = path.resolve(__dirname, "..", "..");
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
const EMPTY_STATE = Object.freeze({ cookies: [], origins: [] });
const SESSION_COOKIE = "connect.sid";
const FILE_RE = /^[a-z0-9_][a-z0-9._-]*\.json$/;
const STALE_TMP_MS = 60 * 1000;

const dirOf = (root) => path.join(root, "mcp");
const activeOf = (root) => path.join(dirOf(root), "active.json");
const taskRecordOf = (root, task) => path.join(root, "work", task, "mcp-state.json");
const isSessionFile = (name) => FILE_RE.test(name) && name !== "active.json";

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

// Written beside the target and renamed over it, so nothing ever reads half a
// file; a rename over the active.json link replaces the link, not its target.
function writeAtomic(file, text) {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		C.writePrivate(tmp, text);
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

function pointActive(root, fileName) {
	const active = activeOf(root);
	const tmp = `${active}.${process.pid}.tmp`;
	fs.rmSync(tmp, { force: true });
	fs.symlinkSync(fileName, tmp);
	fs.renameSync(tmp, active);
}

function resetActive(root) {
	writeAtomic(activeOf(root), `${JSON.stringify(EMPTY_STATE)}\n`);
}

// The MCP fails every browser call when its --storage-state file is missing, so
// active.json is left an empty (signed-out) state rather than removed.
function ensureActive(root = C.ROOT) {
	ensureDir(root);
	if (!fs.existsSync(activeOf(root))) resetActive(root);
}

function activeTarget(root) {
	try { return fs.readlinkSync(activeOf(root)); } catch { return null; }
}

function readTaskRecord(root, task) {
	const file = taskRecordOf(root, task);
	if (!fs.existsSync(file)) return [];
	let files;
	try { files = C.readJson(file).files; } catch { files = null; }
	if (!Array.isArray(files) || !files.every((f) => typeof f === "string" && isSessionFile(f))) {
		throw new Error(`${file} is not a list of session files`);
	}
	return files;
}

function writeTaskRecord(root, task, files) {
	writeAtomic(taskRecordOf(root, task), `${JSON.stringify({ files }, null, 2)}\n`);
}

// The session id a saved cookie carries ("s:<sid>.<signature>", URL-encoded).
function sessionIdOf(file) {
	try {
		const c = (C.readJson(file).cookies || []).find((x) => x && x.name === SESSION_COOKIE);
		const m = c && /^s:([^.]+)\./.exec(decodeURIComponent(String(c.value)));
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

// Deletes the session's row from the task's working copy, as Sign out does.
// True when the row was there; false when the copy or the row isn't.
function endSession(root, task, sid) {
	const dbPath = path.join(root, "work", task, "app.db");
	if (!sid || !fs.existsSync(dbPath)) return false;
	const Database = require(path.join(REPO, "node_modules", "better-sqlite3"));
	const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
	try {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()) return false;
		return db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid).changes > 0;
	} finally {
		db.close();
	}
}

// What login.mjs checks before it signs in, so a save it would refuse never
// leaves a live session behind.
function preflight({ root = C.ROOT, task, user }) {
	ensureDir(root);
	readTaskRecord(root, task);
	return fileNameFor(user);
}

// Saves the signed-in browser's cookies for `user` and points active.json at
// them. The account's earlier session, saved by any task, ends first; then the
// task records the file, so replica:clean can always find it.
function save({ root = C.ROOT, task, user, state, base }) {
	const kept = cookiesOnly(state, base);
	const fileName = preflight({ root, task, user });
	const file = path.join(dirOf(root), fileName);
	if (fs.existsSync(file)) {
		const sid = sessionIdOf(file);
		const work = path.join(root, "work");
		for (const other of fs.existsSync(work) ? fs.readdirSync(work) : []) {
			let files;
			try { files = readTaskRecord(root, other); } catch { continue; }
			if (!files.includes(fileName)) continue;
			endSession(root, other, sid);
			if (other !== task) writeTaskRecord(root, other, files.filter((f) => f !== fileName));
		}
	}
	const files = readTaskRecord(root, task);
	if (!files.includes(fileName)) writeTaskRecord(root, task, [...files, fileName]);
	writeAtomic(file, `${JSON.stringify(kept, null, 2)}\n`);
	pointActive(root, fileName);
	return file;
}

// Takes back the task's sessions: every file the task recorded, and every file
// whose session lives in the task's working copy (so an unreadable record still
// ends them). Each session's row is deleted, then its file; active.json is
// emptied before its target goes, and is never left missing. A failure keeps
// the files it hasn't reached, for another run.
function revoke({ root = C.ROOT, task }) {
	const dir = dirOf(root);
	let recorded = [];
	let recordError = null;
	try { recorded = readTaskRecord(root, task); } catch (e) { recordError = e.message; }
	const removed = [];
	try {
		const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
		for (const name of names) {
			const file = path.join(dir, name);
			if (name.endsWith(".tmp")) {
				if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.rmSync(file, { force: true });
				continue;
			}
			if (!isSessionFile(name)) continue;
			const ended = endSession(root, task, sessionIdOf(file));
			if (!ended && !recorded.includes(name)) continue;
			if (activeTarget(root) === name) resetActive(root);
			fs.rmSync(file, { force: true });
			removed.push({ file, ended });
		}
		fs.rmSync(taskRecordOf(root, task), { force: true });
	} finally {
		ensureActive(root);
	}
	return { removed, recordError };
}

module.exports = { EMPTY_STATE, dirOf, activeOf, taskRecordOf, fileNameFor, cookiesOnly, sessionIdOf, ensureActive, preflight, save, revoke };
