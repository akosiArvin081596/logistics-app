#!/usr/bin/env node
// The session `replica:login --mcp-state <user>` keeps for the Playwright MCP
// (scripts/replica/mcp-state.js), and how replica:clean takes it back.
//
//   §1 only the replica's cookies are kept: local storage is dropped, a cookie
//      for any other host (staging, production) refuses the whole state, and a
//      state taken from anything but a loopback address is refused; file names
//      come from the username and never leave the folder
//   §2 save writes <user>.json (600, folder 700) and points active.json at it;
//      the task records the file name (no cookie); a refused state, or a folder
//      inside the repository, writes nothing
//   §3 revoke deletes the task's files only, leaves active.json a signed-out
//      state (never missing: the MCP fails on a missing file), and refuses an
//      unreadable record without deleting anything
//   §4 with the task's server running, revoke signs each session out with the
//      app's own request; a refused sign-out still deletes the file
//   §5 the commands, with HOME on a temporary folder: replica:clean takes the
//      task's sessions back before anything else; replica:login refuses an
//      --mcp-state that names a second account or no account
//   §6 server.js, read: Sign out destroys the session in the SQLite store, so a
//      saved cookie dies with it
//
// Standalone: node scripts/test-replica-mcp-state.js. No replica, no browser;
// the only server is a stub on 127.0.0.1.
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const M = require(path.join(ROOT, "scripts", "replica", "mcp-state.js"));

let failures = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`  ok   ${name}`);
	else { failures++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
const throws = (name, fn, re) => {
	try { fn(); ok(name, false, "did not throw"); } catch (e) { ok(name, re.test(e.message), e.message); }
};
const rejects = async (name, fn, re) => {
	try { await fn(); ok(name, false, "did not throw"); } catch (e) { ok(name, re.test(e.message), e.message); }
};

const BASE = "http://127.0.0.1:3901";
const cookie = (value, domain = "127.0.0.1") => ({ name: "connect.sid", value, domain, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" });
const stateOf = (...cookies) => ({ cookies, origins: [{ origin: BASE, localStorage: [{ name: "draft", value: "x" }] }] });
const mode = (p) => fs.statSync(p).mode & 0o777;
const tmpRoot = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-"));
	for (const t of ["t1", "t2", "t3"]) fs.mkdirSync(path.join(root, "work", t), { recursive: true });
	return root;
};
const roots = [];

(async () => {
	console.log("§1 only the replica's cookies are kept");
	{
		const kept = M.cookiesOnly(stateOf(cookie("s:a")), BASE);
		eq("the replica's cookie is kept and local storage is dropped", kept, { cookies: [cookie("s:a")], origins: [] });
		for (const domain of ["staging-app.logisx.com", "app.logisx.com", ".logisx.com", "localhost"]) {
			throws(`a cookie for ${domain} beside the replica's refuses the whole state`, () => M.cookiesOnly(stateOf(cookie("s:a"), cookie("s:b", domain)), BASE), /another host/);
		}
		for (const base of ["https://staging-app.logisx.com", "https://app.logisx.com", "http://10.0.0.5:3901"]) {
			throws(`a state taken from ${base} is refused`, () => M.cookiesOnly(stateOf(cookie("s:a", new URL(base).hostname)), base), /only from the replica/);
		}
		throws("a sign-in that left no cookie is refused", () => M.cookiesOnly({ cookies: [], origins: [] }, BASE), /no cookie/);
		eq("a username becomes a lower-case file name", M.fileNameFor("Jane Doe"), "jane-doe.json");
		eq("a username with a path in it stays one file name in the folder", M.fileNameFor("../etc/passwd"), "etc-passwd.json");
		for (const bad of ["", "...", "active", "Active"]) throws(`the username ${JSON.stringify(bad)} makes no file name`, () => M.fileNameFor(bad), /no session file name/);
	}

	console.log("§2 save");
	{
		const root = tmpRoot();
		roots.push(root);
		const dir = M.dirOf(root);
		const file = M.save({ root, task: "t1", user: "Alice", state: stateOf(cookie("s:alice")), base: BASE });
		eq("the session goes to mcp/<user>.json", file, path.join(dir, "alice.json"));
		eq("the file is 600 and the folder 700", [mode(file), mode(dir)], [0o600, 0o700]);
		eq("the file holds the cookies and no local storage", JSON.parse(fs.readFileSync(file, "utf8")), { cookies: [cookie("s:alice")], origins: [] });
		eq("active.json is a link to it", fs.readlinkSync(M.activeOf(root)), "alice.json");
		const record = fs.readFileSync(M.taskRecordOf(root, "t1"), "utf8");
		eq("the task records the file name", JSON.parse(record), { files: ["alice.json"] });
		ok("the task's record holds no cookie and is 600", !record.includes("s:alice") && mode(M.taskRecordOf(root, "t1")) === 0o600);

		M.save({ root, task: "t1", user: "bob", state: stateOf(cookie("s:bob")), base: BASE });
		M.save({ root, task: "t1", user: "alice", state: stateOf(cookie("s:alice2")), base: BASE });
		eq("a second account moves active.json; saving one again is not recorded twice", [fs.readlinkSync(M.activeOf(root)), JSON.parse(fs.readFileSync(M.taskRecordOf(root, "t1"), "utf8")).files], ["alice.json", ["alice.json", "bob.json"]]);
		eq("saving again replaces the cookie", JSON.parse(fs.readFileSync(file, "utf8")).cookies[0].value, "s:alice2");

		const before = fs.readdirSync(dir).sort();
		throws("a state with a production cookie is refused", () => M.save({ root, task: "t1", user: "carol", state: stateOf(cookie("s:c"), cookie("s:p", "app.logisx.com")), base: BASE }), /another host/);
		eq("...and writes nothing", [fs.readdirSync(dir).sort(), fs.readlinkSync(M.activeOf(root))], [before, "alice.json"]);
		eq("...nor records anything for the task", JSON.parse(fs.readFileSync(M.taskRecordOf(root, "t1"), "utf8")).files, ["alice.json", "bob.json"]);

		const inRepo = path.join(ROOT, "mcp-state-test-root");
		throws("a folder inside the repository is refused", () => M.save({ root: inRepo, task: "t1", user: "alice", state: stateOf(cookie("s:a")), base: BASE }), /inside the repository/);
		ok("...before anything is created", !fs.existsSync(inRepo));
	}

	console.log("§3 revoke");
	{
		const root = tmpRoot();
		roots.push(root);
		M.save({ root, task: "t1", user: "alice", state: stateOf(cookie("s:alice")), base: BASE });
		M.save({ root, task: "t1", user: "bob", state: stateOf(cookie("s:bob")), base: BASE });
		M.save({ root, task: "t2", user: "carol", state: stateOf(cookie("s:carol")), base: BASE });
		const removed = await M.revoke({ root, task: "t1" });
		eq("the task's files are deleted, with no server to sign them out on", removed, [{ file: path.join(M.dirOf(root), "alice.json"), signedOut: false }, { file: path.join(M.dirOf(root), "bob.json"), signedOut: false }]);
		eq("another task's file and active.json stay", [fs.readdirSync(M.dirOf(root)).sort(), fs.readlinkSync(M.activeOf(root))], [["active.json", "carol.json"], "carol.json"]);
		ok("the task's record is gone", !fs.existsSync(M.taskRecordOf(root, "t1")));

		await M.revoke({ root, task: "t2" });
		const active = M.activeOf(root);
		ok("once its target is gone, active.json is a file again, not a link", !fs.lstatSync(active).isSymbolicLink());
		eq("...holding a signed-out state, 600", [JSON.parse(fs.readFileSync(active, "utf8")), mode(active)], [M.EMPTY_STATE, 0o600]);
		eq("revoking again finds nothing", await M.revoke({ root, task: "t2" }), []);

		const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-"));
		roots.push(fresh);
		eq("on a Mac that never saved one, revoke still leaves active.json for the MCP", [await M.revoke({ root: fresh, task: "t1" }), JSON.parse(fs.readFileSync(M.activeOf(fresh), "utf8"))], [[], M.EMPTY_STATE]);

		M.save({ root, task: "t3", user: "dave", state: stateOf(cookie("s:dave")), base: BASE });
		fs.writeFileSync(M.taskRecordOf(root, "t3"), JSON.stringify({ files: ["../../outside.json", "dave.json"] }));
		await rejects("a record naming a file outside the folder is refused", () => M.revoke({ root, task: "t3" }), /not a list of session files/);
		ok("...and nothing is deleted", fs.existsSync(path.join(M.dirOf(root), "dave.json")));
	}

	console.log("§4 revoke signs each session out on the task's running server");
	{
		const seen = [];
		let status = 200;
		const server = http.createServer((req, res) => {
			seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, xrw: req.headers["x-requested-with"] });
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end('{"success":true}');
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = server.address().port;
		try {
			const root = tmpRoot();
			roots.push(root);
			M.save({ root, task: "t1", user: "erin", state: stateOf(cookie("s:erin")), base: BASE });
			const [r] = await M.revoke({ root, task: "t1", port });
			eq("the app's Sign out request is sent with the saved cookie", seen, [{ method: "POST", url: "/api/auth/logout", cookie: "connect.sid=s:erin", xrw: "XMLHttpRequest" }]);
			ok("...the session is reported signed out and its file deleted", r.signedOut === true && !fs.existsSync(r.file));

			status = 500;
			M.save({ root, task: "t2", user: "frank", state: stateOf(cookie("s:frank")), base: BASE });
			const [r2] = await M.revoke({ root, task: "t2", port });
			ok("a refused sign-out is reported, and the file is still deleted", r2.signedOut === false && !fs.existsSync(r2.file));
		} finally {
			server.close();
		}
	}

	console.log("§5 the commands");
	{
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-state-home-"));
		roots.push(home);
		const root = path.join(home, "LogisX-replica");
		fs.mkdirSync(path.join(root, "work", "t1"), { recursive: true });
		M.save({ root, task: "t1", user: "grace", state: stateOf(cookie("s:grace")), base: BASE });
		const env = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir() };
		const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "replica", script), ...args], { env, encoding: "utf8", timeout: 30000 });

		const clean = run("clean.js", ["--task", "t1"]);
		ok("replica:clean runs with no server recorded", clean.status === 0, { status: clean.status, err: clean.stderr.slice(0, 300) });
		ok("...deletes the task's session first and says so", /deleted the Playwright MCP session grace\.json/.test(clean.stdout) && clean.stdout.indexOf("grace.json") < clean.stdout.indexOf("no server recorded"), clean.stdout);
		eq("...leaves active.json signed out and the working copy gone", [JSON.parse(fs.readFileSync(M.activeOf(root), "utf8")), fs.existsSync(path.join(root, "work", "t1")), fs.existsSync(path.join(M.dirOf(root), "grace.json"))], [M.EMPTY_STATE, false, false]);

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
		ok("sessions live in the SQLite store, so a destroyed one cannot be read back", /const sessionMiddleware = session\(\{[\s\S]{0,200}store: new SqliteStore\(\{ client: db/.test(SRC));
	}

	for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
	console.log(failures ? `\n${failures} FAILED` : "\nall passed");
	process.exit(failures ? 1 : 0);
})().catch((err) => {
	console.error(err);
	process.exit(1);
});
