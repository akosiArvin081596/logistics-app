#!/usr/bin/env node
/**
 * POST /api/auth/login issues a NEW session ID on every successful sign-in, the
 * way POST /api/auth/setup and POST /api/auth/change-password already did.
 *
 * WHAT IS ASSERTED, each a way this can silently stop being true:
 *   §1 ROTATION: the ID changes across login; the session row the request
 *      arrived with is gone from `sessions`; its cookie no longer authenticates,
 *      at the session probe or at requireAuth; a re-login rotates again; and
 *      login → GET /api/auth/session still answers authenticated:true (the
 *      contract the client's session check, PR #354, depends on)
 *   §2 NOTHING LOGIN WRITES IS LOST: every session field (mustChangePassword
 *      included, for a flagged driver, a flagged investor and an unflagged
 *      dispatcher), last_login_at, and purgeUserSessions() still finding the
 *      rotated session by user id
 *   §3 A FAILED ATTEMPT CHANGES NOTHING: wrong password, unknown user, missing
 *      fields and a server error before rotation leave the existing session,
 *      the cookie and the stamp alone, and no database detail is echoed
 *   §4 RE-READ AFTER THE LAST AWAIT: an account deleted, re-passworded,
 *      demoted or flagged while bcrypt.compare yields is answered from the row
 *      as it is afterwards
 *   §5 FAILURE PATHS: a rotation, a save, or an unexpected throw after
 *      rotation answers 500, sets no cookie, signs nobody in and stamps nothing
 *   §6 the stampLastLogin() try/catch is still load-bearing (docs/claude/
 *      last-login.md asks for this re-check whenever login is refactored)
 *   §7 POST /api/auth/setup, the other route that establishes a session,
 *      rotates too
 *   §8 SOURCE pins (comment-stripped), and §9 DISCRIMINATION: a handler that
 *      does not rotate, and four near-miss mutants, must each be caught
 *
 * Runs the SHIPPED code: the session config, the login and setup handlers,
 * GET /api/auth/session, requireAuth, the must_change_password refresh
 * middleware, stampLastLogin() and purgeUserSessions() are all lifted out of
 * server.js, and wired to the real express-session and the real
 * better-sqlite3-session-store over an in-memory SQLite whose users table is
 * built from server.js's own CREATE and ALTER statements. Real Express on
 * 127.0.0.1:0: no fixed port, no app.db, no network beyond loopback.
 *
 * Run: node scripts/test-login-session-rotation.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { once } = require("events");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// The shipped handlers log on their failure paths, and §5/§6 provoke those on
// purpose. Keep the lines out of the run's output; replay them only on failure.
const logs = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...a) => logs.push(a.join(" "));
console.warn = (...a) => logs.push(a.join(" "));

function die(msg) {
	console.error = realError;
	console.warn = realWarn;
	console.error(`FAILED: ${msg}`);
	process.exit(1);
}

let express, session, Database, bcrypt, SqliteStoreFactory;
try {
	express = require("express");
	session = require("express-session");
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
	SqliteStoreFactory = require("better-sqlite3-session-store");
} catch (e) {
	// Every one of these is a dependency of the shipped server, so "not
	// resolvable" means the install is broken, not that the test may pass.
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const SqliteStoreBase = SqliteStoreFactory(session);

// ── lift the shipped code ───────────────────────────────────────────────────
// A route registration, from its exact head to the `});` that closes it in
// column 0. Handlers are closures, so they cannot be pulled out by name.
function liftRoute(head) {
	const hits = SRC.split(head).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(head);
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
// A top-level function declaration, to the `}` that closes it in column 0.
function liftFunction(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return SRC.slice(a, end + 2);
}
// ⚠️ Structural assertions run over CODE, never prose: the comments beside
// these routes name the very calls being asserted on ("regenerate() destroys
// the session…"). Cuts each line at the first `//` outside a string literal.
function stripComments(src) {
	return src.split("\n").map((line) => {
		let quote = null;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (quote) {
				if (c === "\\") { i++; continue; }
				if (c === quote) quote = null;
				continue;
			}
			if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
			if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
		}
		return line;
	}).join("\n");
}

const LOGIN_SRC = liftRoute('app.post("/api/auth/login", loginLimiter, async (req, res) => {');
const SETUP_SRC = liftRoute('app.post("/api/auth/setup", setupLimiter, async (req, res) => {');
const SESSION_ROUTE_SRC = liftRoute('app.get("/api/auth/session", (req, res) => {');
const STAMP_SRC = liftFunction("function stampLastLogin(userId) {");
const PURGE_SRC = liftFunction("function purgeUserSessions(userId, exceptSid) {");
const REQUIRE_AUTH_SRC = liftFunction("function requireAuth(req, res, next) {");
const CURRENT_FLAG_SRC = liftFunction("function currentMustChangePassword(sessionUser) {");
const REFRESH_FLAG_SRC = liftFunction("function refreshPasswordChangeFlag(req, res, next) {");

// The session middleware exactly as server.js configures it, minus nothing:
// from `const sessionMiddleware = session({` to the line that mounts it.
const SESSION_CONFIG_SRC = (() => {
	const a = SRC.indexOf("const sessionMiddleware = session({");
	const b = SRC.indexOf("\napp.use(sessionMiddleware);", a);
	if (a < 0 || b < 0) die("could not locate the sessionMiddleware configuration");
	const src = SRC.slice(a, b);
	if (!src.trimEnd().endsWith("});")) die("the sessionMiddleware configuration no longer ends where expected");
	return src;
})();

// The users table exactly as server.js builds it: the CREATE, then the ALTERs
// that add the columns login reads and writes.
const USERS_CREATE = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	return `CREATE TABLE users (${m[1]}\n)`;
})();
const USERS_ALTERS = ["full_name", "company_name", "must_change_password", "last_login_at"].map((col) => {
	const m = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
	if (!m) die(`could not locate the users.${col} migration`);
	return m[0];
});

// ── builders ────────────────────────────────────────────────────────────────
const SECRET = "authfu-test-secret-not-a-real-one";

function makeDb({ withLastLogin = true } = {}) {
	const db = new Database(":memory:");
	db.exec(USERS_CREATE);
	for (const alter of USERS_ALTERS) {
		if (!withLastLogin && alter.includes("last_login_at")) continue;
		db.exec(alter);
	}
	return db;
}

const PW = {
	alice: "Alice-Pass-1!",
	bob: "Bob-Pass-2!",
	carol: "Carol-Pass-3!",
	root: "Root-Pass-4!",
};
// Cost 4 keeps the run fast; bcrypt.compare accepts any cost.
function seedUsers(db) {
	const ins = db.prepare(
		"INSERT INTO users (id, username, password_hash, role, driver_name, email, full_name, company_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	ins.run(1, "alice", bcrypt.hashSync(PW.alice, 4), "Dispatcher", "", "alice@example.test", "Alice Dispatch", "", 0);
	ins.run(2, "LogisX-2609", bcrypt.hashSync(PW.bob, 4), "Driver", "Bob Driver", "bob@example.test", "Bob Driver", "", 1);
	ins.run(3, "carol.co", bcrypt.hashSync(PW.carol, 4), "Investor", "", "carol@example.test", "Carol Co", "Carol Co LLC", 1);
	ins.run(4, "root", bcrypt.hashSync(PW.root, 4), "Super Admin", "", "root@example.test", "", "", 0);
}

// The real store, with switchable faults for §5.
function makeStoreClass(holder) {
	return class TestStore extends SqliteStoreBase {
		constructor(opts) {
			super(opts);
			this.failDestroy = 0;
			this.failSet = 0;
			holder.store = this;
		}
		destroy(sid, cb) {
			if (this.failDestroy > 0) { this.failDestroy--; return cb(new Error("SQLITE_IOERR: injected destroy failure")); }
			return super.destroy(sid, cb);
		}
		set(sid, sess, cb) {
			if (this.failSet > 0) { this.failSet--; return cb(new Error("SQLITE_IOERR: injected set failure")); }
			return super.set(sid, sess, cb);
		}
	};
}

function buildSessionMiddleware(db, StoreClass) {
	// The store starts an un-unref'd expiry interval in its constructor, which
	// would hold this process open for the runner's whole timeout.
	const realSetInterval = global.setInterval;
	global.setInterval = (...args) => {
		const t = realSetInterval(...args);
		if (t && typeof t.unref === "function") t.unref();
		return t;
	};
	try {
		return new Function("session", "SqliteStore", "db", "SESSION_SECRET", "SESSION_COOKIE_SECURE", "SESSION_COOKIE_SAMESITE",
			`${SESSION_CONFIG_SRC}\nreturn sessionMiddleware;`)(session, StoreClass, db, SECRET, false, "lax");
	} finally {
		global.setInterval = realSetInterval;
	}
}

const buildStamp = (db) => new Function("db", `${STAMP_SRC}\nreturn stampLastLogin;`)(db);
// The socket half of the purge and of the rotation (disconnectUserSockets,
// disconnectSessionSockets) is injected as a recorder: there are no sockets in
// this runner. scripts/test-session-sockets.js drives the real ones, over real
// Socket.IO connections, against these same lifted routes.
const socketCalls = [];
const disconnectUserSocketsStub = (userId, opts) => { socketCalls.push(["user", userId, opts]); return 0; };
const disconnectSessionSocketsStub = (sid) => { socketCalls.push(["session", sid]); return 0; };
const buildPurge = (db) =>
	new Function("db", "disconnectUserSockets", `${PURGE_SRC}\nreturn purgeUserSessions;`)(db, disconnectUserSocketsStub);
const buildFlagRefresh = (db) =>
	new Function("db", `${CURRENT_FLAG_SRC}\n${REFRESH_FLAG_SRC}\nreturn refreshPasswordChangeFlag;`)(db);
// Bare, nothing injected, the way the other guard runners lift it.
const buildRequireAuth = () => new Function(`${REQUIRE_AUTH_SRC}\nreturn requireAuth;`)();

async function startApp({ db, loginSrc = LOGIN_SRC, bcryptImpl = bcrypt, withSetup = false }) {
	const holder = {};
	const app = express();
	app.use(express.json());
	app.use(buildSessionMiddleware(db, makeStoreClass(holder)));
	// Mounted where server.js mounts it: directly below the session middleware.
	app.use(buildFlagRefresh(db));
	const stampLastLogin = buildStamp(db);
	const passThrough = (req, res, next) => next();
	new Function("app", "loginLimiter", "db", "bcrypt", "stampLastLogin", "disconnectSessionSockets", loginSrc)(
		app, passThrough, db, bcryptImpl, stampLastLogin, disconnectSessionSocketsStub);
	new Function("app", SESSION_ROUTE_SRC)(app);
	if (withSetup) {
		new Function("app", "setupLimiter", "db", "bcrypt", "usersEverExisted", "SETUP_RECOVERY_TOKEN", "safeEqual", "logAudit", "stampLastLogin", "disconnectSessionSockets", SETUP_SRC)(
			app, passThrough, db, bcryptImpl, () => false, "", () => false, () => {}, stampLastLogin, disconnectSessionSocketsStub);
	}
	const requireAuth = buildRequireAuth();
	app.get("/api/whoami", requireAuth, (req, res) => res.json({ id: req.session.user.id }));
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		port: server.address().port,
		store: holder.store,
		close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }),
	};
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function request(port, method, urlPath, { cookie, body } = {}) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const headers = {};
		if (cookie) headers.cookie = cookie;
		if (data !== null) {
			headers["content-type"] = "application/json";
			headers["content-length"] = Buffer.byteLength(data);
		}
		const r = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, agent: false }, (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { buf += c; });
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(buf); } catch { /* not JSON */ }
				const cookieOut = (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("connect.sid=")) || null;
				resolve({ status: res.statusCode, json, cookie: cookieOut });
			});
		});
		r.on("error", reject);
		if (data !== null) r.write(data);
		r.end();
	});
}
const login = (app, username, password, cookie) =>
	request(app.port, "POST", "/api/auth/login", { cookie, body: { username, password } });
const probeSession = (app, cookie) => request(app.port, "GET", "/api/auth/session", { cookie });

// connect.sid=s%3A<sid>.<signature>
function sidOf(cookie) {
	if (!cookie) return null;
	const v = decodeURIComponent(cookie.slice("connect.sid=".length));
	return v.startsWith("s:") ? v.slice(2, v.lastIndexOf(".")) : v;
}
// Signed the way express-session signs (cookie-signature: HMAC-SHA256, base64,
// padding stripped), done here rather than importing a transitive dependency.
const signSid = (sid) => `${sid}.${crypto.createHmac("sha256", SECRET).update(sid).digest("base64").replace(/=+$/, "")}`;
const cookieFor = (sid) => `connect.sid=${encodeURIComponent("s:" + signSid(sid))}`;
function storedUser(db, sid) {
	const row = db.prepare("SELECT sess FROM sessions WHERE sid = ?").get(sid);
	return row ? (JSON.parse(row.sess).user || null) : undefined;
}
const sessionsFor = (db, userId) =>
	db.prepare("SELECT sid FROM sessions WHERE json_extract(sess, '$.user.id') = ?").all(userId).map((r) => r.sid);
const lastLogin = (db, id) => (db.prepare("SELECT last_login_at FROM users WHERE id = ?").get(id) || {}).last_login_at;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ── the properties §9's mutants target, as named booleans ────────────────────
async function probe(loginSrc) {
	const p = {};

	// Rotation: sign in as alice, then as the driver from the same browser.
	{
		const db = makeDb(); seedUsers(db);
		const app = await startApp({ db, loginSrc });
		const first = await login(app, "alice", PW.alice);
		const second = await login(app, "LogisX-2609", PW.bob, first.cookie);
		const s1 = sidOf(first.cookie), s2 = sidOf(second.cookie);
		const oldProbe = await probeSession(app, first.cookie);
		p.firstLoginOk = first.status === 200 && !!first.cookie;
		p.idChanges = second.status === 200 && !!s2 && s2 !== s1;
		p.oldRowDestroyed = !!s1 && storedUser(db, s1) === undefined;
		p.oldIdDead = !!oldProbe.json && oldProbe.json.authenticated === false;
		await app.close();
	}

	// Re-read after the last await: each hook runs while bcrypt.compare yields.
	const raced = async (hook, username, password) => {
		const db = makeDb(); seedUsers(db);
		const hooked = {
			compare: async (pw, hash) => { const r = await bcrypt.compare(pw, hash); hook(db); return r; },
			hash: bcrypt.hash,
		};
		const app = await startApp({ db, loginSrc, bcryptImpl: hooked });
		const r = await login(app, username, password);
		const stored = r.cookie ? storedUser(db, sidOf(r.cookie)) : undefined;
		await app.close();
		return { r, stored, db };
	};
	{
		const { r, db } = await raced((db) => db.prepare("DELETE FROM users WHERE id = 1").run(), "alice", PW.alice);
		p.deletedMidLoginRefused = r.status === 401 && !r.cookie && sessionsFor(db, 1).length === 0;
	}
	{
		const { r, db } = await raced(
			(db) => db.prepare("UPDATE users SET password_hash = ? WHERE id = 1").run(bcrypt.hashSync("Changed-Pass-9!", 4)),
			"alice", PW.alice);
		p.repasswordedMidLoginRefused = r.status === 401 && !r.cookie && sessionsFor(db, 1).length === 0;
	}
	{
		const { r, stored } = await raced((db) => db.prepare("UPDATE users SET role = 'Dispatcher' WHERE id = 4").run(), "root", PW.root);
		p.demotedMidLoginGetsCurrentRole = r.status === 200 && r.json.user.role === "Dispatcher" && !!stored && stored.role === "Dispatcher";
	}
	{
		const { r, stored } = await raced((db) => db.prepare("UPDATE users SET must_change_password = 1 WHERE id = 1").run(), "alice", PW.alice);
		p.flaggedMidLoginCarriesFlag = r.status === 200 && r.json.user.mustChangePassword === true && !!stored && stored.mustChangePassword === true;
	}

	// A rotation that fails: 500, no cookie, the old session untouched, no stamp.
	{
		const db = makeDb(); seedUsers(db);
		const app = await startApp({ db, loginSrc });
		const a = await login(app, "alice", PW.alice);
		db.prepare("UPDATE users SET last_login_at = '' WHERE id = 2").run();
		app.store.failDestroy = 1;
		const r = await login(app, "LogisX-2609", PW.bob, a.cookie);
		const still = await probeSession(app, a.cookie);
		p.rotateFailureIs500 = r.status === 500 && !r.cookie;
		p.rotateFailureSignsNobodyIn = sessionsFor(db, 2).length === 0 && !!still.json && still.json.authenticated === true && still.json.user.id === 1;
		p.rotateFailureNotStamped = lastLogin(db, 2) === "";
		await app.close();
	}

	// A save that fails: 500, no cookie, no stored identity, no stamp — even
	// though express-session tries the save again when the response ends.
	{
		const db = makeDb(); seedUsers(db);
		const app = await startApp({ db, loginSrc });
		app.store.failSet = 1;
		const r = await login(app, "alice", PW.alice);
		p.saveFailureIs500 = r.status === 500 && !r.cookie;
		p.saveFailureLeavesNoSession = sessionsFor(db, 1).length === 0;
		p.saveFailureNotStamped = lastLogin(db, 1) === "";
		await app.close();
	}

	// An unexpected throw after rotation (here the re-read, because the users
	// table disappears while bcrypt.compare yields) goes through the same
	// cleanup: no cookie for the empty session, and no internal detail.
	{
		const db = makeDb(); seedUsers(db);
		const hooked = {
			compare: async (pw, hash) => { const r = await bcrypt.compare(pw, hash); db.exec("DROP TABLE users"); return r; },
			hash: bcrypt.hash,
		};
		const app = await startApp({ db, loginSrc, bcryptImpl: hooked });
		const r = await login(app, "alice", PW.alice);
		p.throwAfterRotationNoCookie = r.status === 500 && !r.cookie &&
			db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n === 0;
		p.throwAfterRotationHidesDetail = r.status === 500 && !!r.json && typeof r.json.error === "string" && !/no such table|SQLITE/i.test(r.json.error);
		await app.close();
	}
	return p;
}

// ─────────────────────────────── §1 rotation, end to end
async function sectionRotation() {
	const db = makeDb(); seedUsers(db);
	const app = await startApp({ db });

	const first = await login(app, "alice", PW.alice);
	ok(first.status === 200 && first.json && first.json.success === true, `§1 a first sign-in must succeed (got ${first.status})`);
	ok(!!first.cookie, "§1 a first sign-in must set a session cookie");
	const s0 = await probeSession(app, first.cookie);
	ok(s0.json && s0.json.authenticated === true && s0.json.user && s0.json.user.username === "alice",
		"§1 login → GET /api/auth/session must answer authenticated:true (the contract the client's session check relies on)");
	const who0 = await request(app.port, "GET", "/api/whoami", { cookie: first.cookie });
	ok(who0.status === 200, "§1 ...and the new cookie must pass requireAuth");

	// The same browser signs in again, as a different account.
	const second = await login(app, "LogisX-2609", PW.bob, first.cookie);
	const s1 = sidOf(first.cookie), s2 = sidOf(second.cookie);
	ok(second.status === 200, `§1 a sign-in from an already-signed-in browser must succeed (got ${second.status})`);
	ok(!!s2 && s2 !== s1, "§1 THE SESSION ID MUST CHANGE across login");
	ok(socketCalls.some(([kind, sid]) => kind === "session" && sid === s1),
		"§1 login must end the live-update sockets of the session it replaced, named by the ID the request arrived with");
	ok(storedUser(db, s1) === undefined, "§1 the session row the request arrived with must be destroyed in the store");
	const oldProbe = await probeSession(app, first.cookie);
	ok(oldProbe.json && oldProbe.json.authenticated === false, "§1 the pre-login ID must no longer authenticate at GET /api/auth/session");
	const oldGuard = await request(app.port, "GET", "/api/whoami", { cookie: first.cookie });
	ok(oldGuard.status === 401, "§1 the pre-login ID must no longer pass requireAuth");
	const nowProbe = await probeSession(app, second.cookie);
	ok(nowProbe.json && nowProbe.json.authenticated === true && nowProbe.json.user && nowProbe.json.user.id === 2,
		"§1 the new ID must carry the account that just signed in");
	ok(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n === 1, "§1 exactly one session may remain");

	// Signing in again as the SAME account rotates too: a re-login is a sign-in.
	const third = await login(app, "LogisX-2609", PW.bob, second.cookie);
	const s3 = sidOf(third.cookie);
	ok(third.status === 200 && !!s3 && s3 !== s2, "§1 a re-login as the same account must rotate the ID as well");
	const secondProbe = await probeSession(app, second.cookie);
	ok(secondProbe.json && secondProbe.json.authenticated === false, "§1 ...and retire the ID it replaced");

	// The test's own cookie signer must produce cookies express-session accepts,
	// or the §1/§7 cases that present a pre-existing ID would prove nothing.
	await new Promise((resolve, reject) => app.store.set("authfu-signer-check", {
		cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: "/" },
		user: { id: 1, username: "alice", role: "Dispatcher" },
	}, (err) => (err ? reject(err) : resolve())));
	const signed = await probeSession(app, cookieFor("authfu-signer-check"));
	ok(signed.json && signed.json.authenticated === true && signed.json.user.id === 1,
		"§1 (harness) a cookie signed by this test must be accepted by the real express-session");

	// A cookie the store has never seen gets a fresh ID too (express-session's
	// own behaviour, kept: the route must not resurrect an unknown ID).
	const unknownCookie = cookieFor("authfu-never-issued-sid");
	const fourth = await login(app, "alice", PW.alice, unknownCookie);
	ok(fourth.status === 200 && sidOf(fourth.cookie) !== "authfu-never-issued-sid",
		"§1 a sign-in presenting an ID the store never issued must still receive a fresh one");
	ok(storedUser(db, "authfu-never-issued-sid") === undefined, "§1 ...and no row may be created under the presented ID");
	await app.close();
}

// ─────────────────────────────── §2 nothing login writes is lost
async function sectionFlags() {
	const db = makeDb(); seedUsers(db);
	db.prepare("UPDATE users SET last_login_at = ''").run();
	const app = await startApp({ db });
	const cases = [
		{
			who: "a flagged driver", username: "LogisX-2609", password: PW.bob,
			expect: { id: 2, username: "LogisX-2609", role: "Driver", driverName: "Bob Driver", email: "bob@example.test", fullName: "Bob Driver", companyName: "", mustChangePassword: true },
		},
		{
			who: "a flagged investor", username: "carol.co", password: PW.carol,
			expect: { id: 3, username: "carol.co", role: "Investor", driverName: "", email: "carol@example.test", fullName: "Carol Co", companyName: "Carol Co LLC", mustChangePassword: true },
		},
		{
			// Signs in by EMAIL: the lookup matches username or email.
			who: "an unflagged dispatcher (by email)", username: "ALICE@example.test", password: PW.alice,
			expect: { id: 1, username: "alice", role: "Dispatcher", driverName: "", email: "alice@example.test", fullName: "Alice Dispatch", companyName: "", mustChangePassword: false },
		},
	];
	for (const c of cases) {
		const before = Date.now();
		const r = await login(app, c.username, c.password);
		ok(r.status === 200, `§2 ${c.who}: sign-in must succeed (got ${r.status})`);
		const { email, ...responseShape } = c.expect;
		ok(r.json && JSON.stringify(r.json.user) === JSON.stringify({
			id: responseShape.id, username: responseShape.username, role: responseShape.role, driverName: responseShape.driverName,
			companyName: responseShape.companyName, fullName: responseShape.fullName, mustChangePassword: responseShape.mustChangePassword,
		}), `§2 ${c.who}: the login response's user must keep its exact shape and values (the client reads data.user): ${JSON.stringify(r.json && r.json.user)}`);
		const stored = r.cookie ? storedUser(db, sidOf(r.cookie)) : null;
		ok(stored && JSON.stringify(stored) === JSON.stringify(c.expect),
			`§2 ${c.who}: the STORED session must carry every field login writes, flag included: ${JSON.stringify(stored)}`);
		const s = await probeSession(app, r.cookie);
		ok(s.json && s.json.user && s.json.user.mustChangePassword === c.expect.mustChangePassword,
			`§2 ${c.who}: GET /api/auth/session must report mustChangePassword ${c.expect.mustChangePassword}`);
		const stamp = lastLogin(db, c.expect.id);
		ok(ISO_Z.test(stamp || "") && Date.parse(stamp) >= before - 1000,
			`§2 ${c.who}: last_login_at must be stamped as an ISO-8601 Z string (got ${JSON.stringify(stamp)})`);
		const who = await request(app.port, "GET", "/api/whoami", { cookie: r.cookie });
		if (c.expect.mustChangePassword) {
			ok(who.status === 403 && who.json && who.json.code === "PASSWORD_CHANGE_REQUIRED",
				`§2 ${c.who}: the rotated session must still be held to the forced password change`);
		} else {
			ok(who.status === 200, `§2 ${c.who}: the rotated session must pass requireAuth`);
		}
		// Revocation keys on sess.user.id (json_extract), so a rotated session
		// must still be findable by it, or a password reset would leave it alive.
		const purgeUserSessions = buildPurge(db);
		ok(purgeUserSessions(c.expect.id) >= 1, `§2 ${c.who}: purgeUserSessions() must find the rotated session by user id`);
		ok(socketCalls.some(([kind, uid]) => kind === "user" && uid === c.expect.id),
			`§2 ${c.who}: ...and end that user's live-update sockets with it`);
		const after = await probeSession(app, r.cookie);
		ok(after.json && after.json.authenticated === false, `§2 ${c.who}: ...and revoking it must sign that cookie out`);
	}
	await app.close();
}

// ─────────────────────────────── §3 a failed attempt changes nothing
async function sectionFailedAttempts() {
	const db = makeDb(); seedUsers(db);
	const app = await startApp({ db });
	const a = await login(app, "alice", PW.alice);
	db.prepare("UPDATE users SET last_login_at = ''").run();
	const attempts = [
		{ what: "a wrong password", body: { username: "LogisX-2609", password: "not-the-password" }, status: 401 },
		{ what: "an unknown user", body: { username: "nobody-here", password: "whatever-1!" }, status: 401 },
		{ what: "a missing password", body: { username: "LogisX-2609" }, status: 400 },
	];
	for (const t of attempts) {
		const r = await request(app.port, "POST", "/api/auth/login", { cookie: a.cookie, body: t.body });
		ok(r.status === t.status, `§3 ${t.what}: must answer ${t.status} (got ${r.status})`);
		ok(!r.cookie, `§3 ${t.what}: must not set a cookie`);
		const still = await probeSession(app, a.cookie);
		ok(still.json && still.json.authenticated === true && still.json.user.id === 1,
			`§3 ${t.what}: the session the request arrived with must be left exactly as it was`);
	}
	ok(lastLogin(db, 2) === "", "§3 a failed attempt must never be stamped as a sign-in");

	// A server error BEFORE rotation (the lookup itself fails) must not cost the
	// caller the session they arrived with, and must not echo internal detail.
	db.exec("ALTER TABLE users RENAME TO users_offline");
	const broken = await login(app, "alice", PW.alice, a.cookie);
	db.exec("ALTER TABLE users_offline RENAME TO users");
	ok(broken.status === 500 && !broken.cookie, `§3 a lookup failure must answer 500 and set no cookie (got ${broken.status})`);
	ok(broken.json && typeof broken.json.error === "string" && !/no such table|SQLITE/i.test(broken.json.error),
		`§3 a lookup failure must not echo the database error to the caller: ${JSON.stringify(broken.json)}`);
	const survived = await probeSession(app, a.cookie);
	ok(survived.json && survived.json.authenticated === true && survived.json.user.id === 1,
		"§3 a failure before rotation must leave the session the request arrived with intact");
	await app.close();
}

// ─────────────────────────────── §6 the stamp's try/catch is load-bearing
async function sectionStampCannotBreakLogin() {
	// No last_login_at column, so the stamp's UPDATE throws inside login.
	const db = makeDb({ withLastLogin: false }); seedUsers(db);
	const app = await startApp({ db });
	const before = logs.length;
	const r = await login(app, "alice", PW.alice);
	ok(r.status === 200 && !!r.cookie, `§6 a failing last_login_at write must NOT fail the sign-in (got ${r.status})`);
	const s = await probeSession(app, r.cookie);
	ok(s.json && s.json.authenticated === true, "§6 ...the session must still be established");
	ok(logs.slice(before).some((l) => /last_login_at stamp failed/.test(l)), "§6 ...and the failure must be logged, not swallowed silently");
	await app.close();
}

// ─────────────────────────────── §7 setup establishes a session, so it rotates too
async function sectionSetup() {
	const db = makeDb(); // no users: first-time setup
	const app = await startApp({ db, withSetup: true });
	// A browser arriving with a stored session (a leftover row) must not keep it.
	const preSid = "authfu-pre-setup-sid";
	await new Promise((resolve, reject) => app.store.set(preSid, {
		cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: "/" },
	}, (err) => (err ? reject(err) : resolve())));
	const r = await request(app.port, "POST", "/api/auth/setup", {
		cookie: cookieFor(preSid), body: { username: "first_admin", password: "First-Admin-1!", email: "fa@example.test" },
	});
	ok(r.status === 200 && r.json && r.json.success === true, `§7 first-time setup must succeed (got ${r.status})`);
	ok(!!r.cookie && sidOf(r.cookie) !== preSid, "§7 setup must hand out a NEW session ID, not the one the request arrived with");
	ok(storedUser(db, preSid) === undefined, "§7 ...and destroy the row the request arrived with");
	const s = await probeSession(app, r.cookie);
	ok(s.json && s.json.authenticated === true && s.json.user.role === "Super Admin", "§7 the new ID must carry the new Super Admin");
	await app.close();
}

// ─────────────────────────────── §8 the source
function sectionSource() {
	const code = stripComments(LOGIN_SRC);
	const at = (needle) => code.indexOf(needle);
	const regen = at("req.session.regenerate(");
	const reread = at('db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)');
	const assign = at("req.session.user = {");
	const save = at("req.session.save(");
	const stamp = at("stampLastLogin(current.id)");
	const compare = at("await bcrypt.compare(");
	ok(regen > compare && compare > 0, "§8 login must rotate the session only AFTER the password is verified");
	ok(regen > 0 && assign > regen, "§8 login must rotate the session BEFORE it attaches the identity");
	ok(reread > regen && reread < assign, "§8 login must re-read the user row after the last await and before the session write");
	ok(save > assign && stamp > save, "§8 last_login_at must be stamped only after the session is saved");
	ok((code.match(/req\.session\.user = /g) || []).length === 1, "§8 login must assign req.session.user exactly once");
	ok((code.match(/stampLastLogin\(/g) || []).length === 1, "§8 login must stamp exactly once");
	ok(/const refuse = \(status, error\) => \{\s*if \(rotating && req\.session\) req\.session\.destroy\(/.test(code),
		"§8 every refusal after the rotation must destroy the half-built session");
	const rotatingSet = at("rotating = true;");
	ok(rotatingSet > compare && rotatingSet < regen, "§8 the rotation flag must be raised after the password check and before regenerate()");
	const outerCatch = code.lastIndexOf("} catch (error) {");
	ok(outerCatch > stamp && /refuse\(500, /.test(code.slice(outerCatch)) && !/error\.message \}/.test(code.slice(outerCatch)),
		"§8 the outer catch must answer through refuse() and not echo error.message");

	const setup = stripComments(SETUP_SRC);
	const sRegen = setup.indexOf("req.session.regenerate(");
	const sAssign = setup.indexOf("req.session.user = userSnapshot");
	ok(sRegen > 0 && sAssign > sRegen, "§8 setup must keep rotating the session before it attaches the new Super Admin");

	ok(/function stampLastLogin\(userId\) \{\s*try \{/.test(STAMP_SRC) && /\} catch \(err\) \{/.test(STAMP_SRC),
		"§8 stampLastLogin() must keep its try/catch (docs/claude/last-login.md: it sits inside login)");
	ok(/^app\.get\("\/api\/auth\/session", \(req, res\) => \{/.test(SESSION_ROUTE_SRC),
		"§8 GET /api/auth/session must stay unguarded — the client's session check reads it");
}

// ─────────────────────────────── §9 discrimination
async function sectionMutants(shipped) {
	const code = LOGIN_SRC;
	const REGEN_CALL = "req.session.regenerate((err) => (err ? reject(err) : resolve()))";
	const REREAD = 'db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)';
	const STAMP_LINE = "\t\tstampLastLogin(current.id);\n";
	const COMPARE_REFUSAL = "\t\tif (!valid) {\n\t\t\treturn res.status(401).json({ error: \"Invalid credentials\" });\n\t\t}\n";
	const CLEANUP = "if (rotating && req.session) req.session.destroy(() => {});";
	const OUTER_REFUSE = 'refuse(500, "Could not sign in. Please try again.");';
	const MUTANTS = [
		{
			name: "a handler that does not rotate",
			src: code.replace(REGEN_CALL, "resolve()"),
			caughtBy: ["idChanges", "oldRowDestroyed", "oldIdDead"],
		},
		{
			name: "no re-read after the last await",
			src: code.replace(REREAD, "user"),
			caughtBy: ["deletedMidLoginRefused", "repasswordedMidLoginRefused", "demotedMidLoginGetsCurrentRole", "flaggedMidLoginCarriesFlag"],
		},
		{
			name: "stamped before the session exists",
			src: code.replace(STAMP_LINE, "").replace(COMPARE_REFUSAL, COMPARE_REFUSAL + "\t\tstampLastLogin(user.id);\n"),
			caughtBy: ["rotateFailureNotStamped", "saveFailureNotStamped"],
		},
		{
			name: "a failed save not cleaned up",
			src: code.replace(CLEANUP, ""),
			caughtBy: ["saveFailureIs500", "saveFailureLeavesNoSession"],
		},
		{
			name: "an outer catch that answers directly with error.message",
			src: code.replace(OUTER_REFUSE, "res.status(500).json({ error: error.message });"),
			caughtBy: ["throwAfterRotationNoCookie", "throwAfterRotationHidesDetail"],
		},
	];
	for (const m of MUTANTS) {
		ok(m.src !== code, `§9 mutant "${m.name}" did not change the source — its marker text moved`);
		if (m.src === code) continue;
		const got = await probe(m.src);
		for (const prop of m.caughtBy) {
			ok(shipped[prop] === true && got[prop] === false, `§9 MUTANT NOT CAUGHT — "${m.name}" must flip ${prop} (shipped ${shipped[prop]}, mutant ${got[prop]})`);
		}
	}
}

function finish() {
	console.error = realError;
	console.warn = realWarn;
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		if (logs.length) console.log(`\nlogged during the run (last 5):\n  ${logs.slice(-5).join("\n  ")}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
}

(async () => {
	await sectionRotation();
	await sectionFlags();
	await sectionFailedAttempts();
	await sectionStampCannotBreakLogin();
	await sectionSetup();
	sectionSource();

	const shipped = await probe(LOGIN_SRC);
	for (const [k, v] of Object.entries(shipped)) ok(v === true, `§4/§5 the shipped handler must hold ${k}`);
	await sectionMutants(shipped);
	finish();
})().catch((e) => {
	console.error = realError;
	console.warn = realWarn;
	console.error(e);
	process.exit(1);
});
