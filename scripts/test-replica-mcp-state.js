#!/usr/bin/env node
// The session `replica:login --mcp-state <user>` keeps for the Playwright MCP
// (scripts/replica/mcp-state.js), and how it ends.
//
//   §1 only the replica's cookies are kept: local storage is dropped, a cookie
//      for any other host (staging, production) refuses the whole state, and a
//      state taken from anything but a loopback address is refused; file names
//      come from the username and never leave the folder
//   §2 save writes <user>.json (600, folder 700) and points active.json at it;
//      the task records the file name (no cookie); a refused state, or a folder
//      inside the repository, writes nothing; saving an account again ends its
//      earlier session, in whichever task saved it, and moves the record
//   §3 revoke ends the task's sessions in its working copy and deletes their
//      files, and only theirs; active.json is emptied before its target goes and
//      is never left missing, also when revoke fails part way (the files it
//      didn't reach stay); an unreadable record still ends the sessions found in
//      the copy; stale temporary files are swept
//   §4 the real session store (express-session + better-sqlite3-session-store,
//      as server.js builds it) no longer returns a session revoke ended
//   §5 the commands, with HOME on a temporary folder: replica:clean ends the
//      task's sessions first, also when its server can't be verified and the
//      working copy is kept; replica:login refuses an --mcp-state that names a
//      second account or no account
//   §6 server.js, read: Sign out destroys the session in the SQLite store, and
//      the cookie keeps express-session's default name
//
// Standalone: node scripts/test-replica-mcp-state.js. No replica, no browser,
// no network.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const M = require(path.join(ROOT, "scripts", "replica", "mcp-state.js"));
const Database = require(path.join(ROOT, "node_modules", "better-sqlite3"));

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const throws = (name, fn, re) => {
	try { fn(); ok(name, false, "did not throw"); } catch (e) { ok(name, re.test(e.message), e.message); }
};

const BASE = "http://127.0.0.1:3901";
// connect.sid as the browser stores it: "s:<sid>.<signature>", URL-encoded.
const cookie = (sid, domain = "127.0.0.1") => ({ name: "connect.sid", value: `s%3A${sid}.signature`, domain, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" });
const stateOf = (...cookies) => ({ cookies, origins: [{ origin: BASE, localStorage: [{ name: "draft", value: "x" }] }] });
const mode = (p) => fs.statSync(p).mode & 0o777;
const roots = [];
const tmpRoot = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-"));
	roots.push(root);
	return root;
};
// A task's working copy with a session store holding these session ids.
const workCopy = (root, task, sids = []) => {
	fs.mkdirSync(path.join(root, "work", task), { recursive: true });
	const db = new Database(path.join(root, "work", task, "app.db"));
	db.exec("CREATE TABLE IF NOT EXISTS sessions (sid TEXT NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TEXT NOT NULL)");
	for (const sid of sids) db.prepare("INSERT INTO sessions VALUES (?, '{}', '2999-01-01')").run(sid);
	db.close();
};
const liveSids = (root, task) => {
	const db = new Database(path.join(root, "work", task, "app.db"), { readonly: true });
	const sids = db.prepare("SELECT sid FROM sessions ORDER BY sid").all().map((r) => r.sid);
	db.close();
	return sids;
};
const record = (root, task) => JSON.parse(fs.readFileSync(M.taskRecordOf(root, task), "utf8")).files;
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

(async () => {
	console.log("§1 only the replica's cookies are kept");
	{
		const kept = M.cookiesOnly(stateOf(cookie("a")), BASE);
		eq("the replica's cookie is kept and local storage is dropped", kept, { cookies: [cookie("a")], origins: [] });
		for (const domain of ["staging-app.logisx.com", "app.logisx.com", ".logisx.com", "localhost"]) {
			throws(`a cookie for ${domain} beside the replica's refuses the whole state`, () => M.cookiesOnly(stateOf(cookie("a"), cookie("b", domain)), BASE), /another host/);
		}
		for (const base of ["https://staging-app.logisx.com", "https://app.logisx.com", "http://10.0.0.5:3901"]) {
			throws(`a state taken from ${base} is refused`, () => M.cookiesOnly(stateOf(cookie("a", new URL(base).hostname)), base), /only from the replica/);
		}
		throws("a sign-in that left no cookie is refused", () => M.cookiesOnly({ cookies: [], origins: [] }, BASE), /no cookie/);
		eq("a username becomes a lower-case file name", M.fileNameFor("Jane Doe"), "jane-doe.json");
		eq("a username with a path in it stays one file name in the folder", M.fileNameFor("../etc/passwd"), "etc-passwd.json");
		for (const bad of ["", "...", "active", "Active"]) throws(`the username ${JSON.stringify(bad)} makes no file name`, () => M.fileNameFor(bad), /no session file name/);
	}

	console.log("§2 save");
	{
		const root = tmpRoot();
		workCopy(root, "t1", ["alice-1"]);
		workCopy(root, "t2", ["alice-2"]);
		const dir = M.dirOf(root);
		const file = M.save({ root, task: "t1", user: "Alice", state: stateOf(cookie("alice-1")), base: BASE });
		eq("the session goes to mcp/<user>.json", file, path.join(dir, "alice.json"));
		eq("the file is 600 and the folder 700", [mode(file), mode(dir)], [0o600, 0o700]);
		eq("the file holds the cookies and no local storage", read(file), { cookies: [cookie("alice-1")], origins: [] });
		eq("active.json is a link to it", fs.readlinkSync(M.activeOf(root)), "alice.json");
		const text = fs.readFileSync(M.taskRecordOf(root, "t1"), "utf8");
		eq("the task records the file name", record(root, "t1"), ["alice.json"]);
		ok("the task's record holds no cookie and is 600", !text.includes("alice-1") && mode(M.taskRecordOf(root, "t1")) === 0o600);
		eq("the session id is read back from the saved cookie", M.sessionIdOf(file), "alice-1");

		M.save({ root, task: "t1", user: "bob", state: stateOf(cookie("bob-1")), base: BASE });
		eq("a second account moves active.json and is recorded", [fs.readlinkSync(M.activeOf(root)), record(root, "t1")], ["bob.json", ["alice.json", "bob.json"]]);

		M.save({ root, task: "t2", user: "alice", state: stateOf(cookie("alice-2")), base: BASE });
		eq("saving the account from another task ends its earlier session there", liveSids(root, "t1"), []);
		eq("...and moves the file's record to that task", [record(root, "t1"), record(root, "t2")], [["bob.json"], ["alice.json"]]);
		eq("...and the file holds the new session", M.sessionIdOf(file), "alice-2");

		workCopy(root, "t2", ["alice-3"]);
		M.save({ root, task: "t2", user: "alice", state: stateOf(cookie("alice-3")), base: BASE });
		eq("saving it again in the same task ends the one it replaces, and isn't recorded twice", [liveSids(root, "t2"), record(root, "t2")], [["alice-3"], ["alice.json"]]);

		const before = fs.readdirSync(dir).sort();
		throws("a state with a production cookie is refused", () => M.save({ root, task: "t1", user: "carol", state: stateOf(cookie("c"), cookie("p", "app.logisx.com")), base: BASE }), /another host/);
		eq("...and writes nothing", [fs.readdirSync(dir).sort(), fs.readlinkSync(M.activeOf(root)), record(root, "t1")], [before, "alice.json", ["bob.json"]]);

		const inRepo = path.join(ROOT, "mcp-state-test-root");
		throws("a folder inside the repository is refused", () => M.save({ root: inRepo, task: "t1", user: "alice", state: stateOf(cookie("a")), base: BASE }), /inside the repository/);
		ok("...before anything is created", !fs.existsSync(inRepo));
		throws("login's preflight refuses an unusable username before any sign-in", () => M.preflight({ root, task: "t1", user: "..." }), /no session file name/);
	}

	console.log("§3 revoke");
	{
		const root = tmpRoot();
		workCopy(root, "t1", ["alice-1", "bob-1", "other"]);
		workCopy(root, "t2", ["carol-1"]);
		M.save({ root, task: "t1", user: "alice", state: stateOf(cookie("alice-1")), base: BASE });
		M.save({ root, task: "t1", user: "bob", state: stateOf(cookie("bob-1")), base: BASE });
		M.save({ root, task: "t2", user: "carol", state: stateOf(cookie("carol-1")), base: BASE });
		const dir = M.dirOf(root);
		const r1 = M.revoke({ root, task: "t1" });
		eq("the task's sessions end in its working copy, and only theirs", liveSids(root, "t1"), ["other"]);
		eq("...their files are deleted", r1, { removed: [{ file: path.join(dir, "alice.json"), ended: true }, { file: path.join(dir, "bob.json"), ended: true }], recordError: null });
		eq("another task's file, session and active.json stay", [fs.readdirSync(dir).sort(), liveSids(root, "t2"), fs.readlinkSync(M.activeOf(root))], [["active.json", "carol.json"], ["carol-1"], "carol.json"]);
		ok("the task's record is gone", !fs.existsSync(M.taskRecordOf(root, "t1")));

		M.revoke({ root, task: "t2" });
		const active = M.activeOf(root);
		ok("when its target goes, active.json becomes a file again, not a link", !fs.lstatSync(active).isSymbolicLink());
		eq("...holding a signed-out state, 600", [read(active), mode(active)], [M.EMPTY_STATE, 0o600]);
		eq("revoking again finds nothing", M.revoke({ root, task: "t2" }), { removed: [], recordError: null });

		const fresh = tmpRoot();
		eq("on a Mac that never saved one, revoke still leaves active.json for the MCP", [M.revoke({ root: fresh, task: "t1" }).removed, read(M.activeOf(fresh))], [[], M.EMPTY_STATE]);

		workCopy(root, "t3", ["dave-1"]);
		M.save({ root, task: "t3", user: "dave", state: stateOf(cookie("dave-1")), base: BASE });
		fs.writeFileSync(M.taskRecordOf(root, "t3"), JSON.stringify({ files: ["../../outside.json"] }));
		const r3 = M.revoke({ root, task: "t3" });
		ok("an unreadable record is reported, naming the record", /mcp-state\.json is not a list of session files/.test(r3.recordError || ""), r3.recordError);
		eq("...and the sessions found in the working copy still end", [liveSids(root, "t3"), r3.removed.map((r) => path.basename(r.file))], [[], ["dave.json"]]);

		workCopy(root, "t4", ["erin-1"]);
		workCopy(root, "t5", ["frank-1"]);
		M.save({ root, task: "t4", user: "erin", state: stateOf(cookie("erin-1")), base: BASE });
		M.save({ root, task: "t4", user: "frank", state: stateOf(cookie("frank-1")), base: BASE });
		fs.writeFileSync(path.join(root, "work", "t4", "app.db"), "not a database");
		fs.rmSync(path.join(root, "work", "t4", "app.db-wal"), { force: true });
		let threw = false;
		try { M.revoke({ root, task: "t4" }); } catch { threw = true; }
		ok("a working copy that can't be read stops revoke", threw);
		ok("...keeping the files it didn't reach and the record", fs.existsSync(path.join(dir, "erin.json")) && fs.existsSync(path.join(dir, "frank.json")) && fs.existsSync(M.taskRecordOf(root, "t4")));
		ok("...and active.json still loads", fs.existsSync(active) && Array.isArray(read(active).cookies));

		const oldTmp = path.join(dir, "gone.json.99999.tmp");
		const newTmp = path.join(dir, "busy.json.99998.tmp");
		fs.writeFileSync(oldTmp, "{}");
		fs.writeFileSync(newTmp, "{}");
		const old = new Date(Date.now() - 10 * 60 * 1000);
		fs.utimesSync(oldTmp, old, old);
		M.revoke({ root, task: "t9" });
		eq("a stale temporary file is swept, a fresh one (a save under way) is left", [fs.existsSync(oldTmp), fs.existsSync(newTmp)], [false, true]);
	}

	console.log("§4 the server's session store no longer knows a revoked session");
	{
		const session = require(path.join(ROOT, "node_modules", "express-session"));
		const SqliteStore = require(path.join(ROOT, "node_modules", "better-sqlite3-session-store"))(session);
		const root = tmpRoot();
		fs.mkdirSync(path.join(root, "work", "t1"), { recursive: true });
		const db = new Database(path.join(root, "work", "t1", "app.db"));
		db.pragma("journal_mode = WAL");
		const store = new SqliteStore({ client: db, expired: { clear: false } });
		const get = (sid) => new Promise((resolve, reject) => store.get(sid, (err, s) => (err ? reject(err) : resolve(s))));
		const sess = { cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: "/" }, user: { username: "super_admin", role: "Super Admin" } };
		await new Promise((resolve, reject) => store.set("grace-1", sess, (err) => (err ? reject(err) : resolve())));
		M.save({ root, task: "t1", user: "grace", state: stateOf(cookie("grace-1")), base: BASE });
		ok("the saved session is live in the store", Boolean((await get("grace-1")) && (await get("grace-1")).user));
		const r = M.revoke({ root, task: "t1" });
		ok("revoke ends it while the store is open, as with a running server", r.removed[0] && r.removed[0].ended === true);
		ok("...and the store answers no session for that cookie", !(await get("grace-1")));
		db.close();
	}

	console.log("§5 the commands");
	{
		const home = tmpRoot();
		const root = path.join(home, "LogisX-replica");
		const env = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir() };
		const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "replica", script), ...args], { env, encoding: "utf8", timeout: 30000 });

		workCopy(root, "t1", ["grace-1"]);
		M.save({ root, task: "t1", user: "grace", state: stateOf(cookie("grace-1")), base: BASE });
		const clean = run("clean.js", ["--task", "t1"]);
		ok("replica:clean runs with no server recorded", clean.status === 0, { status: clean.status, err: clean.stderr.slice(0, 300) });
		ok("...ends the task's session first and says so", /ended the Playwright MCP session grace\.json/.test(clean.stdout) && clean.stdout.indexOf("grace.json") < clean.stdout.indexOf("no server recorded"), clean.stdout);
		eq("...leaves active.json signed out and the working copy gone", [read(M.activeOf(root)), fs.existsSync(path.join(root, "work", "t1")), fs.existsSync(path.join(M.dirOf(root), "grace.json"))], [M.EMPTY_STATE, false, false]);

		workCopy(root, "t2", ["heidi-1"]);
		M.save({ root, task: "t2", user: "heidi", state: stateOf(cookie("heidi-1")), base: BASE });
		// A live pid that is not this task's server: clean must not stop it.
		fs.writeFileSync(path.join(root, "work", "t2", "server.json"), JSON.stringify({ pid: process.pid, port: 3901, codeDir: path.join(home, "nowhere") }));
		const unverified = run("clean.js", ["--task", "t2"]);
		ok("with a server it can't verify, replica:clean stops short and keeps the working copy", unverified.status === 1 && /cannot be verified/.test(unverified.stderr) && fs.existsSync(path.join(root, "work", "t2", "app.db")), { status: unverified.status, err: unverified.stderr.slice(0, 300) });
		eq("...but the session has already ended in it, and its file is gone", [liveSids(root, "t2"), fs.existsSync(path.join(M.dirOf(root), "heidi.json")), read(M.activeOf(root))], [[], false, M.EMPTY_STATE]);

		const two = run("login.mjs", ["alice", "--mcp-state", "bob"]);
		ok("replica:login refuses --mcp-state naming a second account", two.status === 1 && /name two accounts/.test(two.stderr), { status: two.status, err: two.stderr.slice(0, 300) });
		const none = run("login.mjs", ["--mcp-state", "--task", "t1"]);
		ok("replica:login refuses --mcp-state with no account", none.status === 1 && /--mcp-state takes the username/.test(none.stderr), { status: none.status, err: none.stderr.slice(0, 300) });
	}

	console.log("§6 server.js: Sign out ends the session a saved cookie names");
	{
		const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
		const logout = (SRC.match(/app\.post\("\/api\/auth\/logout", \(req, res\) => \{[\s\S]*?\n\}\);/) || [""])[0];
		ok("POST /api/auth/logout destroys the session", /req\.session\.destroy\(\)/.test(logout), logout.slice(0, 200));
		const config = (SRC.match(/const sessionMiddleware = session\(\{[\s\S]*?\n\}\);/) || [""])[0];
		ok("sessions live in the SQLite store on the app's database", /store: new SqliteStore\(\{ client: db/.test(config));
		ok("the cookie keeps express-session's default name, connect.sid", config && !/^\s*name:/m.test(config));
		ok("the store is better-sqlite3-session-store (its table is `sessions`)", /require\("better-sqlite3-session-store"\)\(session\)/.test(SRC));
	}

	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
