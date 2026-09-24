#!/usr/bin/env node
/**
 * A live-update (Socket.IO) connection ends with the session it was opened on.
 *
 * A socket reads its session ONCE, at the handshake, and keeps the rooms that
 * session earned for as long as it stays connected. Ending a session used to
 * reach only the cookie. This runner holds every path that ends one to ending
 * its sockets too, over real connections.
 *
 * WHAT IS ASSERTED, each a way this can silently stop being true:
 *   §1 LOGOUT closes that session's sockets and only that session's: the
 *      account's other device stays connected and keeps receiving
 *   §2 A SIGN-IN (login, and first-time setup) closes the sockets of the
 *      session it replaced, which may be a different person's; a refused
 *      sign-in closes nothing; the new session's socket joins its own rooms
 *   §3 purgeUserSessions() (role change, password reset, driver rename,
 *      delete) closes the user's sockets on every session but the spared one,
 *      and nobody else's
 *   §3b PUT /api/users/:id revokes through it whenever it changes who a
 *      session says its user is: a new role, a password reset, a new driver
 *      name (case-only and cleared included). Another admin's edit spares no
 *      session, a self-edit spares the one making it; the same name resent,
 *      even padded, or an email / full name / company edit revokes nothing;
 *      the update_user audit line carries the count. §8 pins the revocation
 *      after the commit and before the audit line, with no await or return
 *      between
 *   §3c A SELF-EDIT of the caller's own role, driver name or password rebuilds
 *      the spared session from the account row (the fields login writes) under
 *      a NEW session ID, whose cookie the response carries, and ends the old
 *      ID's sockets, which reconnect under the new identity; a CONNECT sent
 *      again over a transport opened before the edit is refused. A self-demoted
 *      admin is refused as one on the next request. The audit line keeps the
 *      identity that made the change; editing someone else, or only a profile
 *      field, leaves the editor's session alone; a session revoked while its
 *      own edit awaited stays ended, and one whose account row cannot be read
 *      is ended, never left stale; a store that cannot delete a session is
 *      logged
 *   §3d PUT /api/admin/fix-driver-name revokes every account whose stored
 *      driver name its cascade changes, read after the route's last await (a
 *      change landing during the sheet write is honoured), and no other: not a
 *      full-name-only match, not an account already spelled the new way. A dry
 *      run, a refusal, a failed sheet write and a rolled-back cascade revoke
 *      nothing; a self-rename spares and rebuilds the requesting session; the
 *      fix_driver_name audit line carries the count. Runs on the REAL cascade,
 *      and §8 pins the read after the last await and the revocation before the
 *      audit line, with nothing able to return between the commit and it
 *   §4 CHANGE-PASSWORD closes the sockets of every session of the account,
 *      this browser's old one included (a socket must not outlive the cookie
 *      it was opened on), and a socket on the NEW cookie is accepted and joins;
 *      the rotated session carries the fields login writes; it writes one
 *      change_password audit row saying whether the change was required and
 *      how many sessions it signed out, with no password and no hash in it
 *   §4b AFTER ITS LAST AWAIT, change-password re-reads everything it trusts:
 *      a session revoked in the bcrypt window (a demotion does that) is
 *      refused 401 with nothing written and nothing saved back; a role changed
 *      in the window reaches the rotated session, and its socket's rooms; a
 *      password changed in the window is answered 409, not overwritten
 *   §5 THE SWEEP closes sockets whose session row is gone or expired, leaves
 *      live ones, and closes NOTHING when the store cannot be read
 *   §6 THE CONNECTION GATE: a CONNECT sent again over the old transport after
 *      the session ended presents the handshake's session object, and is
 *      refused because the store no longer has that session; and when the
 *      store cannot be read at all, the gate refuses (fails CLOSED)
 *   §7 THE PUBLIC TRACKER (/public-track, no session) is untouched by all of
 *      it, including when it shares the signed-in tab's transport
 *   §8 SOURCE pins (comment-stripped): each call sits before the session write
 *      it accompanies; the sweep is scheduled once, every 60 s, unref'd; the
 *      helpers close the namespace, never the transport
 *   §9 DISCRIMINATION: one mutant per call site, and each must be caught
 *
 * Runs the SHIPPED code: the session configuration, the login / setup / logout
 * / session / change-password routes, PUT /api/users/:id, PUT
 * /api/admin/fix-driver-name, requireAuth, requireRole, the must-change-password
 * refresh, purgeUserSessions(), refreshOwnSession(), stampLastLogin(),
 * logAudit(), the socket helpers and sweep, and both "connection" handlers are
 * lifted out of server.js and wired to the real express-session, the real
 * better-sqlite3-session-store, a real Socket.IO server, and real
 * socket.io-client connections (client/node_modules, which `npm ci` at the
 * repo root installs through the postinstall). In-memory SQLite, with the
 * users and audit_trail tables built from server.js's own statements.
 * Loopback on 127.0.0.1:0: no fixed port, no app.db, no network.
 * PUT /api/users/:id's period, sheet and rename-cascade calls are stubbed to
 * "nothing blocks", so every edit reaches the revocation: this runner asks who
 * stays signed in, not what the cascade writes. fix-driver-name runs on the
 * real cascade (applyDriverRenameSqlite() over DRIVER_RENAME_TARGETS, lifted;
 * every table but `users` is absent, which the cascade skips by design), with
 * its sheet, period and merge planning stubbed to "nothing blocks".
 *
 * Run: node scripts/test-session-sockets.js    # exits 1 on failure
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

// The shipped code logs on purpose (the sweep's line, refused writes, audit
// errors). Keep it out of the run's output; replay the tail only on failure.
const logs = [];
const realLog = console.log;
const realError = console.error;
const realWarn = console.warn;
console.log = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));
console.warn = (...a) => logs.push(a.join(" "));
function restoreConsole() {
	console.log = realLog;
	console.error = realError;
	console.warn = realWarn;
}
function die(msg) {
	restoreConsole();
	console.error(`FAILED: ${msg}`);
	process.exit(1);
}

let express, session, Database, bcrypt, SqliteStoreFactory, SocketServer, ioClient;
try {
	express = require("express");
	session = require("express-session");
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
	SqliteStoreFactory = require("better-sqlite3-session-store");
	SocketServer = require("socket.io").Server;
} catch (e) {
	// Each is a dependency of the shipped server: "not resolvable" means the
	// install is broken, never that the test may pass.
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
try {
	ioClient = require(require.resolve("socket.io-client", { paths: [path.join(__dirname, "..", "client")] }));
} catch (e) {
	die(`socket.io-client did not load from client/node_modules (${e.message}); npm ci at the repo root installs it through the postinstall`);
}
const SqliteStoreBase = SqliteStoreFactory(session);

// ── lift the shipped code ───────────────────────────────────────────────────
// A statement from its exact head to the `});` that closes it in column 0.
function liftRoute(head) {
	const hits = SRC.split(head).length - 1;
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits} (a server.js without this change is the pre-fix source)`);
	const a = SRC.indexOf(head);
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
// A top-level function declaration, to the `}` that closes it in column 0.
function liftFunction(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits} (a server.js without this change is the pre-fix source)`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return SRC.slice(a, end + 2);
}
// The arrow function handed to `X.on("connection", …)`.
function liftHandler(head, prefix) {
	const stmt = liftRoute(head);
	if (!stmt.startsWith(prefix) || !stmt.endsWith(");")) die(`unexpected shape for ${head}`);
	return stmt.slice(prefix.length, -2);
}
// Structural assertions run over CODE, never prose: the comments beside these
// calls name them. Cuts each line at the first `//` outside a string literal.
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

const HELPER_HEADS = [
	"function socketsWhere(test) {",
	"function endSockets(sockets) {",
	"function disconnectSessionSockets(sid) {",
	"function disconnectUserSockets(userId, { exceptSid = null } = {}) {",
	"function liveSessionIds(sids) {",
	"function sweepSessionlessSockets() {",
];
// Everything a mutant may target, by name.
const SRCS = {
	login: liftRoute('app.post("/api/auth/login", loginLimiter, async (req, res) => {'),
	setup: liftRoute('app.post("/api/auth/setup", setupLimiter, async (req, res) => {'),
	logout: liftRoute('app.post("/api/auth/logout", (req, res) => {'),
	change: liftRoute('app.post("/api/auth/change-password", requireAuth, changePasswordLimiter, async (req, res) => {'),
	purge: liftFunction("function purgeUserSessions(userId, exceptSid) {"),
	updateUser: liftRoute('app.put("/api/users/:id", requireRole("Super Admin"), async (req, res) => {'),
	refresh: liftFunction("function refreshOwnSession(req) {"),
	fixName: liftRoute('app.put("/api/admin/fix-driver-name", requireRole("Super Admin"), async (req, res) => {'),
	accountIds: liftFunction("function driverRenameAccountIds(oldName, newName, opts = {}) {"),
	helpers: HELPER_HEADS.map(liftFunction).join("\n"),
	ioHandler: liftHandler('io.on("connection", (socket) => {', 'io.on("connection", '),
};
const SESSION_ROUTE_SRC = liftRoute('app.get("/api/auth/session", (req, res) => {');
const TRACKER_HANDLER_SRC = liftHandler('publicTrack.on("connection", (socket) => {', 'publicTrack.on("connection", ');
const STAMP_SRC = liftFunction("function stampLastLogin(userId) {");
const AUDIT_SRC = liftFunction("function logAudit(req, action, entity, entityId, details) {");
const REQUIRE_AUTH_SRC = liftFunction("function requireAuth(req, res, next) {");
const REQUIRE_ROLE_SRC = liftFunction("function requireRole(...roles) {");
// The driver-rename cascade fix-driver-name runs, exactly as server.js defines
// it: the target list, its WHERE/argument/value builders, and the executor.
// A one-line `const NAME = …;`, or a block from its head to the `];` that
// closes it in column 0.
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	if (end < 0) die(`no end found after ${head}`);
	return SRC.slice(a, end + (close ? close.length : 1));
}
const CASCADE_SRC = [
	liftConst("const DRIVER_RENAME_TARGETS = [", "\n];"),
	liftFunction("function driverRenameWhereSql(t, opts = {}) {"),
	liftFunction("function driverRenameWhereArgs(t, nameLower, opts = {}) {"),
	liftFunction("function driverRenameNewValue(t, newName) {"),
	liftConst("const DRIVER_RENAME_ID_CAP = "),
	liftFunction("function replaceNameOnWordBoundary(text, oldName, newName) {"),
	liftFunction("function applyDriverRenameSqlite({ oldName, newName, userId = null, collectIds = false }) {"),
].join("\n");
const HARD_BLOCK_SRC = liftConst("const DRIVER_RENAME_HARD_BLOCK_CODES = ");
const COL_LETTER_SRC = liftFunction("function colLetter(idx) {");
const CURRENT_FLAG_SRC = liftFunction("function currentMustChangePassword(sessionUser) {");
const REFRESH_FLAG_SRC = liftFunction("function refreshPasswordChangeFlag(req, res, next) {");
const LOAD_ID_RE_SRC = (() => {
	const m = SRC.match(/\nconst LOAD_ID_RE = [^\n]+;/);
	if (!m) die("could not locate LOAD_ID_RE");
	return m[0];
})();
// The session middleware exactly as server.js configures it.
const SESSION_CONFIG_SRC = (() => {
	const a = SRC.indexOf("const sessionMiddleware = session({");
	const b = SRC.indexOf("\napp.use(sessionMiddleware);", a);
	if (a < 0 || b < 0) die("could not locate the sessionMiddleware configuration");
	return SRC.slice(a, b);
})();
// The users and audit_trail tables exactly as server.js builds them.
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
const AUDIT_CREATE = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
})();

// ── fixtures ────────────────────────────────────────────────────────────────
const SECRET = "t3-session-sockets-secret-not-a-real-one";
const PW = { alice: "Alice-Pass-1!", bob: "Bob-Pass-2!", carol: "Carol-Pass-3!", root: "Root-Pass-4!" };
const NEW_PW = "Fresh-Pass-77!";
const ADMIN_RESET_PW = "Admin-Reset-5!";
let HASH = null; // cost-4 hashes, computed once: bcrypt.compare accepts any cost

function makeDb({ seed = true } = {}) {
	const db = new Database(":memory:");
	db.exec(USERS_CREATE);
	for (const alter of USERS_ALTERS) db.exec(alter);
	db.exec(AUDIT_CREATE);
	if (seed) {
		const ins = db.prepare(
			"INSERT INTO users (id, username, password_hash, role, driver_name, email, full_name, company_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		ins.run(1, "alice", HASH.alice, "Dispatcher", "", "alice@example.test", "Alice Dispatch", "", 0);
		ins.run(2, "bob", HASH.bob, "Driver", "Bob Driver", "bob@example.test", "Bob Driver", "", 0);
		// Must change her password: the forced-change audit case.
		ins.run(3, "carol", HASH.carol, "Dispatcher", "", "carol@example.test", "Carol Dispatch", "", 1);
		ins.run(4, "root", HASH.root, "Super Admin", "", "root@example.test", "", "", 0);
	}
	return db;
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

// cost 10 in the route is ~70 ms of pure-JS bcrypt per change; cost 4 keeps
// every probe fast without changing what the route does with the hash.
const fastBcrypt = { compare: (pw, h) => bcrypt.compare(pw, h), hash: (pw) => bcrypt.hash(pw, 4) };

// The room helpers the connection handler names its rooms with, as shipped.
// This runner asks which room a socket joins; how a room is spelled is
// scripts/test-socket-hardening.js's subject.
const ROOMS = new Function(
	`${["function identityRoomKey(name) {", "function driverRoom(name) {", "function userRoom(username) {"].map(liftFunction).join("\n")}\nreturn { identityRoomKey, driverRoom, userRoom };`)();
// The SHIPPED per-listener guard both connection handlers wrap their events in;
// the fault-containment it provides is scripts/test-socket-hardening.js's
// subject, so here it just needs to be the real wrapper the handlers call.
const socketHandler = new Function(
	`${["function socketHandler(event, fn) {", "function logSocketHandlerFault(event, err) {"].map(liftFunction).join("\n")}\nreturn socketHandler;`)();

// One complete app: HTTP routes and Socket.IO on one loopback server, built
// from `sources` (the shipped text, or a mutant of one piece of it).
async function startWorld({ sources = SRCS, seed = true, bcryptImpl = fastBcrypt } = {}) {
	const db = makeDb({ seed });
	const holder = {};
	class TestStore extends SqliteStoreBase {
		constructor(opts) { super(opts); holder.store = this; }
	}
	const sessionMiddleware = buildSessionMiddleware(db, TestStore);
	const flags = new Function("db", `${CURRENT_FLAG_SRC}\n${REFRESH_FLAG_SRC}\nreturn { currentMustChangePassword, refreshPasswordChangeFlag };`)(db);

	const app = express();
	app.use(express.json());
	app.use(sessionMiddleware);
	app.use(flags.refreshPasswordChangeFlag); // where server.js mounts it
	const server = http.createServer(app);
	const io = new SocketServer(server);
	io.engine.use(sessionMiddleware); // where server.js mounts it

	const helpers = new Function("io", "db",
		`${sources.helpers}\nreturn { socketsWhere, endSockets, disconnectSessionSockets, disconnectUserSockets, liveSessionIds, sweepSessionlessSockets };`)(io, db);
	io.on("connection", new Function("currentMustChangePassword", "liveSessionIds", "identityRoomKey", "driverRoom", "userRoom", "socketHandler", `return (${sources.ioHandler});`)(
		flags.currentMustChangePassword, helpers.liveSessionIds, ROOMS.identityRoomKey, ROOMS.driverRoom, ROOMS.userRoom, socketHandler));
	const LOAD_ID_RE = new Function(`${LOAD_ID_RE_SRC}\nreturn LOAD_ID_RE;`)();
	io.of("/public-track").on("connection", new Function("LOAD_ID_RE", "socketHandler", `return (${TRACKER_HANDLER_SRC});`)(LOAD_ID_RE, socketHandler));

	const stampLastLogin = new Function("db", `${STAMP_SRC}\nreturn stampLastLogin;`)(db);
	const logAudit = new Function("db", `${AUDIT_SRC}\nreturn logAudit;`)(db);
	const purgeUserSessions = new Function("db", "disconnectUserSockets", `${sources.purge}\nreturn purgeUserSessions;`)(db, helpers.disconnectUserSockets);
	// Bare, nothing injected, the way the other guard runners lift it.
	const requireAuth = new Function(`${REQUIRE_AUTH_SRC}\nreturn requireAuth;`)();
	const passThrough = (req, res, next) => next();

	new Function("app", "loginLimiter", "db", "bcrypt", "stampLastLogin", "disconnectSessionSockets", sources.login)(
		app, passThrough, db, bcryptImpl, stampLastLogin, helpers.disconnectSessionSockets);
	new Function("app", "setupLimiter", "db", "bcrypt", "usersEverExisted", "SETUP_RECOVERY_TOKEN", "safeEqual", "logAudit", "stampLastLogin", "disconnectSessionSockets", sources.setup)(
		app, passThrough, db, bcryptImpl, () => false, "", () => false, logAudit, stampLastLogin, helpers.disconnectSessionSockets);
	new Function("app", "disconnectSessionSockets", sources.logout)(app, helpers.disconnectSessionSockets);
	new Function("app", SESSION_ROUTE_SRC)(app);
	new Function("app", "requireAuth", "changePasswordLimiter", "db", "bcrypt", "purgeUserSessions", "logAudit", "liveSessionIds", "disconnectSessionSockets", sources.change)(
		app, requireAuth, passThrough, db, bcryptImpl, purgeUserSessions, logAudit, helpers.liveSessionIds, helpers.disconnectSessionSockets);

	// PUT /api/users/:id on its real guard, the real purge and the real audit
	// writer. The purge is wrapped only to record whom it was asked to revoke and
	// which sid it spared; it still revokes. The rest is period, sheet and
	// rename-cascade machinery, stubbed to "nothing blocks": no lock rows, no
	// merge, and a Job Tracking sheet that carries no driver name at all. The
	// route hashes a password itself (`await import("bcryptjs")`), for real.
	const requireRole = new Function(`${REQUIRE_ROLE_SRC}\nreturn requireRole;`)();
	const purgeCalls = [];
	const recordPurge = (userId, exceptSid) => { purgeCalls.push([userId, exceptSid]); return purgeUserSessions(userId, exceptSid); };
	const refreshOwnSession = new Function("db", "disconnectSessionSockets", "liveSessionIds", `${sources.refresh}\nreturn refreshOwnSession;`)(
		db, helpers.disconnectSessionSockets, helpers.liveSessionIds);
	// The Job Tracking read a rename makes is one of the route's awaits; a
	// scenario can land a change in it through `putEnv.duringSheetRead`.
	const putEnv = { duringSheetRead: null };
	const noSheetRows = async () => ({ spreadsheets: { values: { get: async () => {
		await new Promise((resolve) => setImmediate(resolve));
		if (putEnv.duringSheetRead) putEnv.duringSheetRead();
		return { data: { values: [["Load ID", "Driver"]] } };
	} } } });
	const auditText = (v, max) => String(v == null ? "" : v).slice(0, max);
	new Function("app", "requireRole", "db", "getSheets", "SPREADSHEET_ID", "auditText", "recordPeriodRefusal", "userUpdateLockBlockers",
		"periodLabel", "driverRenameMergeScan", "applyDriverRenameSqlite", "syncDriverToCarrierSheet", "purgeUserSessions", "logAudit",
		"notifyChange", "refreshOwnSession", sources.updateUser)(
		app, requireRole, db, noSheetRows, "t3-not-a-sheet", auditText, () => {},
		() => ({ unreadable: false, blockers: [] }), (period) => period, () => ({ mergeTargets: {}, mergeRows: 0 }), () => ({ counts: {} }),
		() => {}, recordPurge, logAudit, () => {}, refreshOwnSession);

	// PUT /api/admin/fix-driver-name on the REAL cascade: the executor, the target
	// list and its builders are server.js's own, so "the accounts whose sessions
	// end" can be checked against the accounts the cascade actually changed.
	// Planning is stubbed to "nothing blocks" unless a scenario says otherwise
	// through `fixEnv`: whether period_locks reads, whether the sheet write
	// fails, and what lands in the database while that write — the route's last
	// await — is in flight.
	const cascade = new Function("db", `${CASCADE_SRC}\n${sources.accountIds}\n` +
		"return { DRIVER_RENAME_TARGETS, DRIVER_RENAME_ID_CAP, applyDriverRenameSqlite, driverRenameAccountIds };")(db);
	const fixEnv = {
		locksReadable: true,
		sheetRows: [["Load ID", "Driver", "Assigned Date"], ["L-100", "Bob Driver", "2026-09-01"]],
		failSheetWrite: false,
		duringSheetWrite: null,
		sheetWrites: 0,
		refusals: [],
		merge: null, // a driverRenameMergeScan() answer, to make the route treat the rename as a merge
	};
	const fixSheets = async () => ({ spreadsheets: { values: {
		get: async () => ({ data: { values: fixEnv.sheetRows } }),
		batchUpdate: async () => {
			await new Promise((resolve) => setImmediate(resolve)); // a real round trip yields
			if (fixEnv.duringSheetWrite) fixEnv.duringSheetWrite();
			if (fixEnv.failSheetWrite) throw new Error("simulated sheet outage");
			fixEnv.sheetWrites++;
			return {};
		},
	} } });
	new Function("app", "requireRole", "db", "getSheets", "SPREADSHEET_ID", "colLetter", "isLocked", "periodLocksReadable",
		"namedLockedPeriods", "planDriverRenameSqlite", "driverRenameMergeScan", "DRIVER_RENAME_TARGETS", "DRIVER_RENAME_HARD_BLOCK_CODES",
		"DRIVER_RENAME_ID_CAP", "recordPeriodRefusal", "auditText", "auditReasonNote", "applyDriverRenameSqlite", "driverRenameAccountIds",
		"purgeUserSessions", "logAudit", "refreshOwnSession", sources.fixName)(
		app, requireRole, db, fixSheets, "t3-not-a-sheet", new Function(`${COL_LETTER_SRC}\nreturn colLetter;`)(), () => false,
		() => fixEnv.locksReadable, () => [], () => ({ targets: {}, blockers: [] }), () => fixEnv.merge || ({ mergeTargets: {}, mergeRows: 0 }),
		cascade.DRIVER_RENAME_TARGETS, new Function(`${HARD_BLOCK_SRC}\nreturn DRIVER_RENAME_HARD_BLOCK_CODES;`)(), cascade.DRIVER_RENAME_ID_CAP,
		(audit, code) => { fixEnv.refusals.push(code); }, auditText, () => "", cascade.applyDriverRenameSqlite, cascade.driverRenameAccountIds,
		recordPurge, logAudit, refreshOwnSession);

	// Test-only: refreshOwnSession()'s fail-closed branch. No route can reach it
	// (both call it right after their own commit), so the account row is removed
	// here, the one way the re-read can come back empty.
	app.post("/__t3/refresh-without-row", requireAuth, (req, res) => {
		db.prepare("DELETE FROM users WHERE id = ?").run(req.session.user.id);
		res.json({ refreshed: refreshOwnSession(req) });
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const clients = [];
	return {
		db, io, helpers, purgeUserSessions, purgeCalls, putEnv, fixEnv, clients,
		store: holder.store,
		port: server.address().port,
		close: async () => {
			for (const c of clients) { try { c.disconnect(); } catch { /* already closed */ } }
			const closed = new Promise((resolve) => io.close(() => resolve()));
			if (server.closeAllConnections) server.closeAllConnections();
			// Bounded: a close that never completes must not hold the runner.
			await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
			db.close();
		},
	};
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function request(port, method, urlPath, { cookie, body, xrw } = {}) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const headers = {};
		if (cookie) headers.cookie = cookie;
		if (xrw) headers["x-requested-with"] = "XMLHttpRequest";
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
const login = (w, username, password, cookie) => request(w.port, "POST", "/api/auth/login", { cookie, body: { username, password } });
const changePassword = (w, cookie, currentPassword, newPassword) =>
	request(w.port, "POST", "/api/auth/change-password", { cookie, xrw: true, body: { currentPassword, newPassword } });
const editUser = (w, cookie, id, body) => request(w.port, "PUT", `/api/users/${id}`, { cookie, xrw: true, body });
const fixDriverName = (w, cookie, body, query = "") => request(w.port, "PUT", `/api/admin/fix-driver-name${query}`, { cookie, xrw: true, body });
// Is this cookie still signed in? Asked the way the SPA asks it.
async function isLive(w, cookie) {
	const r = await request(w.port, "GET", "/api/auth/session", { cookie });
	return !!r.json && r.json.authenticated === true;
}

// connect.sid=s%3A<sid>.<signature>
function sidOf(cookie) {
	if (!cookie) return null;
	const v = decodeURIComponent(cookie.slice("connect.sid=".length));
	return v.startsWith("s:") ? v.slice(2, v.lastIndexOf(".")) : v;
}
// Signed the way express-session signs (cookie-signature: HMAC-SHA256, base64,
// padding stripped).
const signSid = (sid) => `${sid}.${crypto.createHmac("sha256", SECRET).update(sid).digest("base64").replace(/=+$/, "")}`;
const cookieFor = (sid) => `connect.sid=${encodeURIComponent("s:" + signSid(sid))}`;
const storeSet = (store, sid, sess) => new Promise((resolve, reject) => store.set(sid, sess, (err) => (err ? reject(err) : resolve())));
const cookieShape = () => ({ originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: "/" });
// The user object stored under `sid`, or undefined when there is no such row.
function storedUser(db, sid) {
	const row = db.prepare("SELECT sess FROM sessions WHERE sid = ?").get(sid);
	return row ? (JSON.parse(row.sess).user || null) : undefined;
}
const sessionsOf = (db, userId) =>
	db.prepare("SELECT sid FROM sessions WHERE json_extract(sess, '$.user.id') = ?").all(userId).map((r) => r.sid);
const changeAudits = (db) => db.prepare("SELECT * FROM audit_trail WHERE action = 'change_password'").all();
const userEditAudits = (db) => db.prepare("SELECT details FROM audit_trail WHERE action = 'update_user' ORDER BY id").all().map((r) => r.details);
const storedName = (db, id) => db.prepare("SELECT driver_name FROM users WHERE id = ?").get(id).driver_name;
// The purge calls PUT /api/users/:id made, exactly: [[userId, sparedSid], …].
const purgedExactly = (w, want) => JSON.stringify(w.purgeCalls) === JSON.stringify(want);
// The same, as a set: fix-driver-name revokes in the order the rows come back.
const byId = (a, b) => a[0] - b[0];
const purgedAsSet = (w, want) => JSON.stringify([...w.purgeCalls].sort(byId)) === JSON.stringify([...want].sort(byId));
// Another account, signing in with bob's password.
function addUser(db, id, username, role, driverName, fullName) {
	db.prepare(
		"INSERT INTO users (id, username, password_hash, role, driver_name, email, full_name, company_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, '', 0)",
	).run(id, username, HASH.bob, role, driverName, `${username}@example.test`, fullName);
}
// id -> driver_name, to compare before and after a rename.
const driverNames = (db) => Object.fromEntries(db.prepare("SELECT id, driver_name FROM users").all().map((r) => [r.id, r.driver_name]));
const namesChanged = (before, after) => Object.keys(after).map(Number).filter((id) => before[id] !== after[id]).sort((a, b) => a - b);
const fixAudits = (db) => db.prepare("SELECT user_id, role, details FROM audit_trail WHERE action = 'fix_driver_name' ORDER BY id").all();
function fixAuditRevoked(db) {
	const rows = fixAudits(db);
	try { return rows.length === 1 ? JSON.parse(rows[0].details).sessionsRevoked : undefined; } catch { return undefined; }
}

// ── sockets ─────────────────────────────────────────────────────────────────
function waitFor(emitter, event, ms = 2000) {
	return new Promise((resolve) => {
		const on = (...args) => { clearTimeout(t); resolve(args); };
		const t = setTimeout(() => { emitter.off(event, on); resolve(null); }, ms);
		emitter.once(event, on);
	});
}
async function waitUntil(pred, ms = 2000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 5));
	}
	return pred();
}

// A browser tab: its own transport, presenting `cookie` on the handshake.
// Resolves once the server has acknowledged the CONNECT. The server runs its
// "connection" handler in the same tick as that acknowledgement, so by the
// time this resolves the gate has already accepted or refused the socket.
async function connectTab(w, cookie) {
	const s = ioClient.io(`http://127.0.0.1:${w.port}`, {
		transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: cookie ? { cookie } : {},
	});
	w.clients.push(s);
	const tab = { s, id: null, reasons: [] };
	s.on("disconnect", (reason) => tab.reasons.push(reason));
	if (!(await waitFor(s, "connect"))) throw new Error("a socket never connected");
	tab.id = s.id; // captured now: socket.io-client clears s.id on disconnect
	return tab;
}
const serverSocket = (w, tab, nsp = "/") => w.io.of(nsp).sockets.get(tab.id) || null;
const isOpen = (w, tab, nsp = "/") => !!serverSocket(w, tab, nsp);
const inRoom = (w, room, id, nsp = "/") => { const r = w.io.of(nsp).adapter.rooms.get(room); return !!(r && r.has(id)); };
// Why the client saw its socket close. Only waited on once the server side is
// already closed, so a mutant that leaves it open costs no timeout.
async function closeReason(tab) {
	if (tab.reasons.length) return tab.reasons[0];
	const got = await waitFor(tab.s, "disconnect");
	return got ? got[0] : null;
}
const closedByServer = async (w, tab, nsp = "/") => !isOpen(w, tab, nsp) && (await closeReason(tab)) === "io server disconnect";
// Sends `register` and waits for the server to put the socket in `room`.
async function joins(w, tab, name, room) {
	if (!isOpen(w, tab)) return false;
	tab.s.emit("register", name);
	return waitUntil(() => inRoom(w, room, tab.id));
}
async function receives(socket, event, fire) {
	const p = waitFor(socket, event);
	fire();
	return !!(await p);
}

// ── the scenarios. Each sets named properties, all true on the shipped code ──
const SCENARIOS = {
	// §1
	async logout(sources, p) {
		const w = await startWorld({ sources });
		try {
			const here = await login(w, "alice", PW.alice);
			const phone = await login(w, "alice", PW.alice); // the same account, another device
			const t = await connectTab(w, here.cookie);
			const o = await connectTab(w, phone.cookie);
			const joined = (await joins(w, t, "dispatch", "dispatch")) && (await joins(w, o, "dispatch", "dispatch"));
			const out = await request(w.port, "POST", "/api/auth/logout", { cookie: here.cookie });
			p.logoutClosesSession = joined && out.status === 200 && (await closedByServer(w, t));
			p.logoutLeavesNoRoom = joined && !inRoom(w, "dispatch", t.id);
			p.logoutSparesOtherDevice = isOpen(w, o) &&
				(await receives(o.s, "location-update", () => w.io.to("dispatch").emit("location-update", { lat: 1 })));
		} finally { await w.close(); }
	},

	// §2
	async login(sources, p) {
		const w = await startWorld({ sources });
		try {
			const a = await login(w, "alice", PW.alice);
			const elsewhere = await login(w, "alice", PW.alice);
			const ta = await connectTab(w, a.cookie);
			const te = await connectTab(w, elsewhere.cookie);
			await joins(w, ta, "dispatch", "dispatch");
			// A refused sign-in (from the other browser) changed no session.
			const refused = await login(w, "bob", "not-the-password", elsewhere.cookie);
			p.refusedLoginClosesNothing = refused.status === 401 && isOpen(w, te) && isOpen(w, ta);
			// This browser signs in as someone else.
			const b = await login(w, "bob", PW.bob, a.cookie);
			p.loginClosesReplacedSession = b.status === 200 && (await closedByServer(w, ta));
			p.loginSparesOtherSessions = isOpen(w, te);
			const tb = await connectTab(w, b.cookie);
			// The driver asks for "dispatch"; the server derives rooms from the session.
			const own = await joins(w, tb, "dispatch", ROOMS.driverRoom("Bob Driver"));
			const ss = serverSocket(w, tb);
			p.newSessionIsNewPerson = own && !inRoom(w, "dispatch", tb.id) && !!ss && ss.data.userId === 2 && ss.data.sid === sidOf(b.cookie);
		} finally { await w.close(); }
	},

	// §2, first-time setup
	async setup(sources, p) {
		const w = await startWorld({ sources, seed: false });
		try {
			// A session left behind with an identity, the kind a truncated users
			// table leaves: its socket is accepted, and setup replaces it.
			const leftover = "t3-leftover-session";
			await storeSet(w.store, leftover, { cookie: cookieShape(), user: { id: 90, username: "leftover", role: "Dispatcher" } });
			const t = await connectTab(w, cookieFor(leftover));
			const joined = await joins(w, t, "dispatch", "dispatch");
			const r = await request(w.port, "POST", "/api/auth/setup", {
				cookie: cookieFor(leftover), body: { username: "first_admin", password: "First-Admin-1!", email: "fa@example.test" },
			});
			p.setupClosesReplacedSession = joined && r.status === 200 && (await closedByServer(w, t));
		} finally { await w.close(); }
	},

	// §3
	async purge(sources, p) {
		const w = await startWorld({ sources });
		try {
			const a1 = await login(w, "alice", PW.alice);
			const a2 = await login(w, "alice", PW.alice);
			const b = await login(w, "bob", PW.bob);
			const t1 = await connectTab(w, a1.cookie);
			const t2 = await connectTab(w, a2.cookie);
			const tb = await connectTab(w, b.cookie);
			const revoked = w.purgeUserSessions(1, sidOf(a2.cookie));
			p.purgeClosesUser = revoked === 1 && (await closedByServer(w, t1));
			p.purgeSparesKeptSession = isOpen(w, t2);
			p.purgeSparesOtherUsers = isOpen(w, tb);
			w.purgeUserSessions(1, null);
			p.purgeWithNoSpareClosesAll = (await closedByServer(w, t2)) && isOpen(w, tb);
		} finally { await w.close(); }
	},

	// §3b: PUT /api/users/:id decides WHEN an edit revokes; purgeUserSessions()
	// (§3) is how. The session caches the driver name that every Driver-scoped
	// check reads, and nothing re-reads it.
	async userEdit(sources, p) {
		{
			// Another admin renames a driver who is signed in on two devices.
			const w = await startWorld({ sources });
			try {
				const admin = await login(w, "root", PW.root);
				const b1 = await login(w, "bob", PW.bob);
				const b2 = await login(w, "bob", PW.bob);
				const tb = await connectTab(w, b1.cookie);
				const ta = await connectTab(w, admin.cookie);
				const joined = (await joins(w, tb, "bob driver", ROOMS.driverRoom("Bob Driver"))) && (await joins(w, ta, "dispatch", "dispatch"));
				const r = await editUser(w, admin.cookie, 2, { driverName: "Robert Driver" });
				const renamed = r.status === 200 && storedName(w.db, 2) === "Robert Driver";
				p.renameRevokesTarget = renamed && purgedExactly(w, [[2, null]]) && sessionsOf(w.db, 2).length === 0 &&
					!(await isLive(w, b1.cookie)) && !(await isLive(w, b2.cookie));
				p.renameClosesTargetSockets = renamed && joined && (await closedByServer(w, tb)) && !inRoom(w, ROOMS.driverRoom("Bob Driver"), tb.id);
				p.renameSparesAdmin = renamed && (await isLive(w, admin.cookie));
				// Editing someone else leaves the editor's own session as it was: same
				// ID (no new cookie), and its socket still in its room.
				p.renameLeavesEditorSession = renamed && !r.cookie && isOpen(w, ta) && inRoom(w, "dispatch", ta.id);
				const audits = userEditAudits(w.db);
				p.renameAuditCounts = audits.length === 1 && audits[0].includes('driverName "Bob Driver" -> "Robert Driver"') &&
					/; sessions revoked: 2$/.test(audits[0]);
			} finally { await w.close(); }
		}
		{
			// A Super Admin gives their OWN account a driver name, from one of two
			// devices: the session making the request is spared, the other is not.
			const w = await startWorld({ sources });
			try {
				const here = await login(w, "root", PW.root);
				const there = await login(w, "root", PW.root);
				const tThere = await connectTab(w, there.cookie);
				const r = await editUser(w, here.cookie, 4, { driverName: "Root Driver" });
				const renamed = r.status === 200 && storedName(w.db, 4) === "Root Driver";
				// Spared means this browser stays signed in. The session it continues on
				// is §3c's business: rebuilt under a new ID, whose cookie this response
				// carries.
				p.selfRenameSparesCurrent = renamed && purgedExactly(w, [[4, sidOf(here.cookie)]]) && !!r.cookie && (await isLive(w, r.cookie));
				p.selfRenameRevokesOthers = renamed && !(await isLive(w, there.cookie)) && (await closedByServer(w, tThere)) &&
					/; sessions revoked: 1$/.test(userEditAudits(w.db)[0] || "");
			} finally { await w.close(); }
		}
		{
			const w = await startWorld({ sources });
			try {
				const admin = await login(w, "root", PW.root);
				const b = await login(w, "bob", PW.bob);
				// Resent as stored; resent padded (stored trimmed, so unchanged); and
				// the cached fields that no check reads.
				const same = await editUser(w, admin.cookie, 2, { driverName: "Bob Driver" });
				const padded = await editUser(w, admin.cookie, 2, { driverName: "  Bob Driver  " });
				const profile = await editUser(w, admin.cookie, 2, { email: "robert@example.test", fullName: "Robert D", companyName: "RD Hauling" });
				p.unchangedNameRevokesNothing = [same, padded, profile].every((r) => r.status === 200) && storedName(w.db, 2) === "Bob Driver" &&
					w.purgeCalls.length === 0 && (await isLive(w, b.cookie)) && !userEditAudits(w.db).some((d) => /sessions revoked/.test(d));

				// Case only: still a rename.
				const tb = await connectTab(w, b.cookie);
				const joined = await joins(w, tb, "bob driver", ROOMS.driverRoom("Bob Driver"));
				const caseOnly = await editUser(w, admin.cookie, 2, { driverName: "bob driver" });
				p.caseOnlyRenameRevokes = caseOnly.status === 200 && storedName(w.db, 2) === "bob driver" && purgedExactly(w, [[2, null]]) &&
					!(await isLive(w, b.cookie)) && joined && (await closedByServer(w, tb));

				// Cleared: null is the documented way.
				w.purgeCalls.length = 0;
				const b2 = await login(w, "bob", PW.bob);
				const cleared = await editUser(w, admin.cookie, 2, { driverName: null });
				p.clearedNameRevokes = cleared.status === 200 && storedName(w.db, 2) === "" && purgedExactly(w, [[2, null]]) &&
					!(await isLive(w, b2.cookie));

				// The two clauses that predate the driver-name one, pinned beside it:
				// nothing else runs this route.
				w.purgeCalls.length = 0;
				const a = await login(w, "alice", PW.alice);
				const role = await editUser(w, admin.cookie, 1, { role: "Driver" });
				p.roleChangeRevokes = role.status === 200 && purgedExactly(w, [[1, null]]) && !(await isLive(w, a.cookie));
				w.purgeCalls.length = 0;
				const c = await login(w, "carol", PW.carol);
				const reset = await editUser(w, admin.cookie, 3, { password: ADMIN_RESET_PW });
				p.passwordResetRevokes = reset.status === 200 && purgedExactly(w, [[3, null]]) && !(await isLive(w, c.cookie));
			} finally { await w.close(); }
		}
	},

	// §3c: the session a self-edit spares says who it is from the account row,
	// not from its sign-in: rebuilt under a new session ID, whose cookie the
	// response carries, and its sockets reconnect as that identity.
	async selfEdit(sources, p) {
		{
			// A Super Admin gives their own account a driver name.
			const w = await startWorld({ sources });
			try {
				const here = await login(w, "root", PW.root);
				const shapeAtLogin = Object.keys(storedUser(w.db, sidOf(here.cookie)) || {}).sort().join();
				const tHere = await connectTab(w, here.cookie);
				const joined = await joins(w, tHere, "dispatch", "dispatch");
				const r = await editUser(w, here.cookie, 4, { driverName: "Root Driver" });
				const renamed = r.status === 200 && storedName(w.db, 4) === "Root Driver";
				const rebuilt = r.cookie ? storedUser(w.db, sidOf(r.cookie)) : undefined;
				p.selfEditRefreshesSession = renamed && !!rebuilt && rebuilt.id === 4 && rebuilt.driverName === "Root Driver" &&
					rebuilt.role === "Super Admin" && Object.keys(rebuilt).sort().join() === shapeAtLogin;
				// A NEW session ID: the old one is gone from the store, its cookie no
				// longer signs anyone in, and only the new cookie does.
				p.selfEditRotatesSession = renamed && !!r.cookie && sidOf(r.cookie) !== sidOf(here.cookie) &&
					storedUser(w.db, sidOf(here.cookie)) === undefined && !(await isLive(w, here.cookie)) && (await isLive(w, r.cookie));
				p.selfEditEndsOwnSockets = renamed && joined && (await closedByServer(w, tHere)) && !inRoom(w, "dispatch", tHere.id);
				// Reconnecting on the new cookie, the socket is the rebuilt identity:
				// the new name is now a room this Super Admin may ask for.
				const back = renamed && r.cookie ? await connectTab(w, r.cookie) : null;
				p.selfEditReconnectsAsRebuilt = !!back && (await joins(w, back, "root driver", ROOMS.driverRoom("Root Driver")));
			} finally { await w.close(); }
		}
		{
			// A Super Admin (another one exists) first edits only their own email,
			// then demotes themselves to Driver.
			const w = await startWorld({ sources });
			try {
				addUser(w.db, 8, "root2", "Super Admin", "", "");
				const here = await login(w, "root", PW.root);
				const tHere = await connectTab(w, here.cookie);
				const joined = await joins(w, tHere, "dispatch", "dispatch");

				const profile = await editUser(w, here.cookie, 4, { email: "root-new@example.test" });
				p.selfProfileEditKeepsSession = profile.status === 200 && w.purgeCalls.length === 0 && !profile.cookie && joined &&
					isOpen(w, tHere) && inRoom(w, "dispatch", tHere.id) && (await isLive(w, here.cookie));

				const r = await editUser(w, here.cookie, 4, { role: "Driver", driverName: "Root Driver" });
				const demoted = r.status === 200 && w.db.prepare("SELECT role FROM users WHERE id = 4").get().role === "Driver";
				// The very next request is a Driver's: on the new cookie it is refused
				// as an admin, and the old cookie signs no one in at all.
				const next = r.cookie;
				const asAdmin = demoted && next ? await editUser(w, next, 2, { email: "bob-new@example.test" }) : null;
				const asOld = demoted ? await editUser(w, here.cookie, 2, { email: "bob-old@example.test" }) : null;
				const s = next ? await request(w.port, "GET", "/api/auth/session", { cookie: next }) : { json: null };
				p.selfDemotionTakesEffect = demoted && !!asAdmin && asAdmin.status === 403 && !!asOld && asOld.status === 401 &&
					!!s.json && s.json.authenticated === true && s.json.user.role === "Driver" && s.json.user.driverName === "Root Driver";
				const back = demoted && next ? await connectTab(w, next) : null;
				p.selfDemotionMovesRooms = demoted && (await closedByServer(w, tHere)) && !inRoom(w, "dispatch", tHere.id) &&
					!!back && (await joins(w, back, "dispatch", ROOMS.driverRoom("Root Driver"))) && !inRoom(w, "dispatch", back.id);
				// The audit line is the identity that was authorised to make the change.
				const rows = w.db.prepare("SELECT user_id, role, details FROM audit_trail WHERE action = 'update_user' ORDER BY id").all();
				const demotion = rows.filter((row) => /role "Super Admin" -> "Driver"/.test(row.details));
				p.selfEditAuditKeepsAuthority = demoted && demotion.length === 1 && demotion[0].user_id === 4 && demotion[0].role === "Super Admin";
			} finally { await w.close(); }
		}
		{
			// A transport opened BEFORE a self-demotion stays open (the public
			// tracker shares it), and its default-namespace socket sends CONNECT
			// again afterwards. That CONNECT presents the session ID the transport
			// was opened with, which the rebuild retired, so it must be refused.
			const w = await startWorld({ sources });
			let m = null;
			try {
				addUser(w.db, 8, "root2", "Super Admin", "", "");
				const here = await login(w, "root", PW.root);
				m = new ioClient.Manager(`http://127.0.0.1:${w.port}`, {
					transports: ["websocket"], reconnection: false, extraHeaders: { cookie: here.cookie },
				});
				const tracker = m.socket("/public-track");
				const dflt = m.socket("/");
				w.clients.push(tracker, dflt);
				const [c1, c2] = await Promise.all([waitFor(tracker, "connect"), waitFor(dflt, "connect")]);
				if (!c1 || !c2) throw new Error("the shared transport never connected");
				const tab = { s: dflt, id: dflt.id, reasons: [] };
				dflt.on("disconnect", (reason) => tab.reasons.push(reason));
				const joined = await joins(w, tab, "dispatch", "dispatch");
				const engineId = m.engine && m.engine.id;
				const r = await editUser(w, here.cookie, 4, { role: "Driver", driverName: "Root Driver" });
				const closed = r.status === 200 && joined && (await closedByServer(w, tab));
				if (closed && m.engine && m.engine.id === engineId) {
					dflt.connect();
					const again = await waitFor(dflt, "connect");
					const reId = dflt.id;
					p.selfEditStaleTransportRefused = !!again && m.engine.id === engineId && !w.io.of("/").sockets.get(reId) &&
						![...w.io.of("/").sockets.values()].some((s) => s.data && s.data.sid === sidOf(here.cookie));
				} else {
					p.selfEditStaleTransportRefused = false;
				}
			} finally {
				try { if (m && m.engine) m.engine.close(); } catch { /* closed */ }
				await w.close();
			}
		}
		{
			// The requesting session is revoked while its own self-edit awaits the
			// Job Tracking read (another admin resets this account's password
			// meanwhile). The edit still lands; the session must stay ended.
			const w = await startWorld({ sources });
			try {
				w.db.prepare("UPDATE users SET driver_name = 'Root Driver' WHERE id = 4").run();
				const here = await login(w, "root", PW.root);
				w.putEnv.duringSheetRead = () => { w.purgeUserSessions(4, null); };
				const r = await editUser(w, here.cookie, 4, { driverName: "Rooted Driver" });
				p.selfEditRevokedMeanwhileStaysEnded = r.status === 200 && storedName(w.db, 4) === "Rooted Driver" && !r.cookie &&
					sessionsOf(w.db, 4).length === 0 && !(await isLive(w, here.cookie));
			} finally { await w.close(); }
		}
		{
			// The account row cannot be read, so the session is ended, not kept.
			const w = await startWorld({ sources });
			try {
				const a = await login(w, "alice", PW.alice);
				const ta = await connectTab(w, a.cookie);
				const r = await request(w.port, "POST", "/__t3/refresh-without-row", { cookie: a.cookie, xrw: true });
				p.refreshFailsClosed = r.status === 200 && !!r.json && r.json.refreshed === false && sessionsOf(w.db, 1).length === 0 &&
					!(await isLive(w, a.cookie)) && (await closedByServer(w, ta));
			} finally { await w.close(); }
		}
		{
			// A Super Admin resets their OWN password from one of two devices. As
			// with change-password, the other device is signed out and this one
			// continues on a new session ID: no copy of the old cookie outlives it.
			const w = await startWorld({ sources });
			try {
				const here = await login(w, "root", PW.root);
				const there = await login(w, "root", PW.root);
				const r = await editUser(w, here.cookie, 4, { password: ADMIN_RESET_PW });
				const rebuilt = r.cookie ? storedUser(w.db, sidOf(r.cookie)) : undefined;
				p.selfPasswordResetRotatesSession = r.status === 200 && purgedExactly(w, [[4, sidOf(here.cookie)]]) &&
					!(await isLive(w, there.cookie)) && !(await isLive(w, here.cookie)) && !!r.cookie && (await isLive(w, r.cookie)) &&
					!!rebuilt && rebuilt.id === 4 && rebuilt.role === "Super Admin";
			} finally { await w.close(); }
		}
		{
			// The store cannot delete a session. Both refresh paths log it, and the
			// one that rotates still signs this browser out: it answers with a fresh
			// session that holds no user.
			const w = await startWorld({ sources });
			try {
				const a = await login(w, "alice", PW.alice);
				const root = await login(w, "root", PW.root);
				w.db.exec("CREATE TRIGGER t3_keep_sessions BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 't3 simulated store failure'); END;");
				let before = logs.length;
				const gone = await request(w.port, "POST", "/__t3/refresh-without-row", { cookie: a.cookie, xrw: true });
				p.refreshLogsFailedEnd = gone.status === 200 && !!gone.json && gone.json.refreshed === false &&
					logs.slice(before).some((l) => /session refresh: ending the session failed/.test(l));
				before = logs.length;
				const r = await editUser(w, root.cookie, 4, { driverName: "Root Driver" });
				const s = r.cookie ? await request(w.port, "GET", "/api/auth/session", { cookie: r.cookie }) : { json: null };
				p.refreshLogsFailedRotation = r.status === 200 && storedName(w.db, 4) === "Root Driver" &&
					logs.slice(before).some((l) => /session refresh: regenerate failed/.test(l)) &&
					!!r.cookie && sidOf(r.cookie) !== sidOf(root.cookie) && !!s.json && s.json.authenticated === false;
				w.db.exec("DROP TRIGGER t3_keep_sessions");
			} finally { await w.close(); }
		}
	},

	// §3d: PUT /api/admin/fix-driver-name, on the real cascade.
	async fixName(sources, p) {
		{
			// Another admin renames "Bob Driver". A second account carries that name
			// in another case; a third has it only as a FULL name; a fourth has a
			// longer name that contains it.
			const w = await startWorld({ sources });
			try {
				addUser(w.db, 5, "dave", "Driver", "BOB DRIVER", "Dave Driver");
				addUser(w.db, 6, "erin", "Driver", "Erin Driver", "Bob Driver");
				addUser(w.db, 7, "frank", "Driver", "Bob Driverson", "Frank Driver");
				const admin = await login(w, "root", PW.root);
				const b1 = await login(w, "bob", PW.bob);
				const b2 = await login(w, "bob", PW.bob);
				const d = await login(w, "dave", PW.bob);
				const e = await login(w, "erin", PW.bob);
				const f = await login(w, "frank", PW.bob);
				const tb = await connectTab(w, b1.cookie);
				const te = await connectTab(w, e.cookie);
				const ta = await connectTab(w, admin.cookie);
				const joined = (await joins(w, tb, "bob driver", ROOMS.driverRoom("Bob Driver"))) && (await joins(w, te, "erin driver", ROOMS.driverRoom("Erin Driver"))) &&
					(await joins(w, ta, "dispatch", "dispatch"));
				const before = driverNames(w.db);
				const r = await fixDriverName(w, admin.cookie, { oldName: "Bob Driver", newName: "Robert Driver" });
				const moved = namesChanged(before, driverNames(w.db));
				const renamed = r.status === 200 && JSON.stringify(moved) === "[2,5]" && w.fixEnv.sheetWrites === 1;
				// Exactly the accounts the cascade changed, each with nothing spared.
				p.fixRenameRevokesMoved = renamed && purgedAsSet(w, moved.map((id) => [id, null])) &&
					sessionsOf(w.db, 2).length === 0 && sessionsOf(w.db, 5).length === 0 &&
					!(await isLive(w, b1.cookie)) && !(await isLive(w, b2.cookie)) && !(await isLive(w, d.cookie));
				p.fixRenameClosesSockets = renamed && joined && (await closedByServer(w, tb)) && !inRoom(w, ROOMS.driverRoom("Bob Driver"), tb.id);
				// The cascade did rewrite erin's FULL name. She stays signed in.
				const erinFull = w.db.prepare("SELECT full_name FROM users WHERE id = 6").get().full_name;
				p.fixRenameSparesOthers = renamed && erinFull === "Robert Driver" && (await isLive(w, e.cookie)) && isOpen(w, te) &&
					(await isLive(w, f.cookie)) && (await isLive(w, admin.cookie));
				// The admin who ran it keeps their session ID and their socket's room.
				p.fixRenameLeavesEditorSession = renamed && !r.cookie && isOpen(w, ta) && inRoom(w, "dispatch", ta.id);
				p.fixRenameAuditCounts = renamed && fixAuditRevoked(w.db) === 3;
			} finally { await w.close(); }
		}
		{
			// While the sheet write (the route's last await) is in flight, another
			// change lands: frank takes the old name and bob gives it up. Whose
			// sessions end is decided by what the cascade changes after that write.
			const w = await startWorld({ sources });
			try {
				addUser(w.db, 7, "frank", "Driver", "Frank Driver", "Frank Driver");
				const admin = await login(w, "root", PW.root);
				const b = await login(w, "bob", PW.bob);
				const f = await login(w, "frank", PW.bob);
				w.fixEnv.duringSheetWrite = () => {
					w.db.prepare("UPDATE users SET driver_name = 'bob driver' WHERE id = 7").run();
					w.db.prepare("UPDATE users SET driver_name = 'Bobby Driver' WHERE id = 2").run();
				};
				const r = await fixDriverName(w, admin.cookie, { oldName: "Bob Driver", newName: "Robert Driver" });
				p.fixReadsAfterLastAwait = r.status === 200 && storedName(w.db, 7) === "Robert Driver" && storedName(w.db, 2) === "Bobby Driver" &&
					purgedExactly(w, [[7, null]]) && !(await isLive(w, f.cookie)) && (await isLive(w, b.cookie));
			} finally { await w.close(); }
		}
		{
			// Nothing reached SQLite, so nothing ends: a dry run, a refusal, a failed
			// sheet write, and a cascade whose transaction rolled back.
			const w = await startWorld({ sources });
			try {
				const admin = await login(w, "root", PW.root);
				const b = await login(w, "bob", PW.bob);
				const body = { oldName: "Bob Driver", newName: "Robert Driver" };
				const untouched = async () => storedName(w.db, 2) === "Bob Driver" && w.purgeCalls.length === 0 && (await isLive(w, b.cookie));

				const dry = await fixDriverName(w, admin.cookie, body, "?dryRun=true");
				p.fixDryRunRevokesNothing = dry.status === 200 && !!dry.json && dry.json.dryRun === true && (await untouched());

				w.fixEnv.locksReadable = false;
				const refused = await fixDriverName(w, admin.cookie, body);
				w.fixEnv.locksReadable = true;
				p.fixRefusalRevokesNothing = refused.status === 409 && !!refused.json && refused.json.code === "PERIOD_LOCK_UNREADABLE" &&
					w.fixEnv.refusals.length === 1 && (await untouched());

				w.fixEnv.failSheetWrite = true;
				const sheetDown = await fixDriverName(w, admin.cookie, body);
				w.fixEnv.failSheetWrite = false;
				p.fixSheetFailureRevokesNothing = sheetDown.status === 502 && !!sheetDown.json && sheetDown.json.code === "SHEET_WRITE_FAILED" &&
					(await untouched());

				// The cascade's own write to users fails, so its transaction rolls back.
				w.db.exec("CREATE TRIGGER t3_refuse_rename BEFORE UPDATE OF driver_name ON users BEGIN SELECT RAISE(ABORT, 't3 simulated write failure'); END;");
				const partial = await fixDriverName(w, admin.cookie, body);
				w.db.exec("DROP TRIGGER t3_refuse_rename");
				p.fixRollbackRevokesNothing = partial.status === 500 && !!partial.json && partial.json.code === "PARTIAL_RENAME" &&
					(await untouched());
			} finally { await w.close(); }
		}
		{
			// A Super Admin renames their OWN driver name, from one of two devices.
			const w = await startWorld({ sources });
			try {
				w.db.prepare("UPDATE users SET driver_name = 'Root Driver' WHERE id = 4").run();
				w.fixEnv.sheetRows = [["Load ID", "Driver", "Assigned Date"], ["L-200", "Root Driver", "2026-09-02"]];
				const here = await login(w, "root", PW.root);
				const there = await login(w, "root", PW.root);
				const tHere = await connectTab(w, here.cookie);
				const tThere = await connectTab(w, there.cookie);
				const r = await fixDriverName(w, here.cookie, { oldName: "Root Driver", newName: "Rooted Driver" });
				const renamed = r.status === 200 && storedName(w.db, 4) === "Rooted Driver";
				// Spared, then rebuilt under a new session ID: this browser continues on
				// the cookie the response carries, and the old one signs no one in.
				const rebuilt = r.cookie ? storedUser(w.db, sidOf(r.cookie)) : undefined;
				const back = renamed && r.cookie ? await connectTab(w, r.cookie) : null;
				p.fixSelfRenameSparesAndRebuilds = renamed && purgedExactly(w, [[4, sidOf(here.cookie)]]) && !!r.cookie &&
					(await isLive(w, r.cookie)) && !(await isLive(w, here.cookie)) &&
					!!rebuilt && rebuilt.driverName === "Rooted Driver" && (await closedByServer(w, tHere)) &&
					!!back && (await joins(w, back, "rooted driver", ROOMS.driverRoom("Rooted Driver")));
				p.fixSelfRenameRevokesOthers = renamed && !(await isLive(w, there.cookie)) && (await closedByServer(w, tThere)) &&
					fixAuditRevoked(w.db) === 1;
			} finally { await w.close(); }
		}
		{
			// Case only. Over an account already spelled the new way the cascade
			// writes the same value back, so nothing about it changes; the other way
			// round, the account's stored name does change.
			const w = await startWorld({ sources });
			try {
				const admin = await login(w, "root", PW.root);
				const b = await login(w, "bob", PW.bob);
				const same = await fixDriverName(w, admin.cookie, { oldName: "bob driver", newName: "Bob Driver" });
				p.fixUnchangedAccountNotRevoked = same.status === 200 && storedName(w.db, 2) === "Bob Driver" && w.purgeCalls.length === 0 &&
					(await isLive(w, b.cookie)) && fixAuditRevoked(w.db) === 0;
				const lower = await fixDriverName(w, admin.cookie, { oldName: "Bob Driver", newName: "bob driver" });
				p.fixCaseOnlyRevokes = lower.status === 200 && storedName(w.db, 2) === "bob driver" && purgedExactly(w, [[2, null]]) &&
					!(await isLive(w, b.cookie));
			} finally { await w.close(); }
		}
		{
			// A MERGE: "Robert Driver" already belongs to rob. The route treats the
			// rename as one (the cascade collects the ids it moves). bob's stored
			// name changes and his sessions end; rob's does not, and his stay.
			const w = await startWorld({ sources });
			try {
				addUser(w.db, 9, "rob", "Driver", "Robert Driver", "Robert Driver");
				w.fixEnv.merge = { mergeTargets: { users: 1 }, mergeRows: 1 };
				const admin = await login(w, "root", PW.root);
				const b = await login(w, "bob", PW.bob);
				const rob = await login(w, "rob", PW.bob);
				const r = await fixDriverName(w, admin.cookie, { oldName: "Bob Driver", newName: "Robert Driver" });
				const audit = fixAudits(w.db)[0];
				const moved = audit ? JSON.parse(audit.details).changedIds : null;
				p.fixMergeRevokesOnlyRenamed = r.status === 200 && !!r.json && r.json.isMerge === true && !!moved &&
					JSON.stringify(moved.users) === "[2]" && storedName(w.db, 2) === "Robert Driver" && storedName(w.db, 9) === "Robert Driver" &&
					purgedExactly(w, [[2, null]]) && !(await isLive(w, b.cookie)) && (await isLive(w, rob.cookie)) && fixAuditRevoked(w.db) === 1;
			} finally { await w.close(); }
		}
	},

	// §4
	async change(sources, p) {
		{
			const w = await startWorld({ sources });
			try {
				// carol must change her password. This browser has two tabs on one
				// cookie; she is also signed in on another device.
				const here = await login(w, "carol", PW.carol);
				const there = await login(w, "carol", PW.carol);
				const bystander = await login(w, "alice", PW.alice);
				const shapeAtLogin = Object.keys(storedUser(w.db, sidOf(here.cookie)) || {}).sort().join();
				const t1 = await connectTab(w, here.cookie);
				const t2 = await connectTab(w, here.cookie);
				const o = await connectTab(w, there.cookie);
				const sa = await connectTab(w, bystander.cookie);
				const r = await changePassword(w, here.cookie, PW.carol, NEW_PW);
				const newSid = sidOf(r.cookie);
				const answered = r.status === 200 && !!newSid && newSid !== sidOf(here.cookie);
				// Every socket of the old cookie goes, the asking tab's included: one
				// opened on a copied cookie must not survive the change.
				p.changeClosesThisSessionsSockets = answered && (await closedByServer(w, t1)) && (await closedByServer(w, t2));
				p.changeClosesOtherDevices = answered && (await closedByServer(w, o));
				p.changeSparesOtherUsers = isOpen(w, sa);
				// The asking tab comes back on the NEW cookie (the client reconnects by
				// itself once the server closed its socket): accepted, and it joins now
				// that the flag is clear.
				const back = answered ? await connectTab(w, r.cookie) : null;
				p.changeNewCookieSocketJoins = !!back && isOpen(w, back) && (await joins(w, back, "dispatch", "dispatch")) &&
					(await receives(back.s, "location-update", () => w.io.to("dispatch").emit("location-update", { lat: 2 })));
				const s = await request(w.port, "GET", "/api/auth/session", { cookie: r.cookie });
				p.changeNewCookieIsLive = !!s.json && s.json.authenticated === true && s.json.user.id === 3 && s.json.user.mustChangePassword === false;
				const rotated = answered ? storedUser(w.db, newSid) : null;
				p.changeSessionHasLoginShape = !!rotated && Object.keys(rotated).sort().join() === shapeAtLogin &&
					rotated.id === 3 && rotated.username === "carol" && rotated.role === "Dispatcher" && rotated.mustChangePassword === false;

				const rows = w.db.prepare("SELECT * FROM audit_trail WHERE action = 'change_password'").all();
				const row = rows.length === 1 ? rows[0] : null;
				p.changeAudited = !!row && row.entity === "user" && row.entity_id === "3" && row.user_id === 3 && row.username === "carol";
				p.auditSaysRequired = !!row && /\(required change\)/.test(row.details);
				p.auditCountsRevoked = !!row && /other sessions signed out: 1$/.test(row.details);
				const blob = JSON.stringify(rows);
				const stored = w.db.prepare("SELECT password_hash FROM users WHERE id = 3").get().password_hash;
				p.auditHoldsNoSecret = !!row && !blob.includes(NEW_PW) && !blob.includes(PW.carol) && !blob.includes("$2") && !blob.includes(stored);
			} finally { await w.close(); }
		}
		{
			// A change nobody required says so, and a lone session revokes nothing.
			const w = await startWorld({ sources });
			try {
				const a = await login(w, "alice", PW.alice);
				const r = await changePassword(w, a.cookie, PW.alice, NEW_PW);
				const rows = w.db.prepare("SELECT details FROM audit_trail WHERE action = 'change_password'").all();
				p.auditPlainWhenNotRequired = r.status === 200 && rows.length === 1 && !/required/.test(rows[0].details) && /other sessions signed out: 0$/.test(rows[0].details);
			} finally { await w.close(); }
		}
		{
			// The password is reset (by an admin, say) while this request awaits
			// bcrypt. The re-read after the last await must answer 409 and write
			// nothing: no overwrite, no purge, no audit row.
			const adminHash = bcrypt.hashSync(ADMIN_RESET_PW, 4);
			let dbRef = null;
			const racing = {
				compare: (pw, h) => bcrypt.compare(pw, h),
				hash: async (pw) => {
					const h = await bcrypt.hash(pw, 4);
					dbRef.prepare("UPDATE users SET password_hash = ? WHERE id = 1").run(adminHash);
					return h;
				},
			};
			const w = await startWorld({ sources, bcryptImpl: racing });
			dbRef = w.db;
			try {
				const a = await login(w, "alice", PW.alice);
				const other = await login(w, "alice", PW.alice);
				const o = await connectTab(w, other.cookie);
				const r = await changePassword(w, a.cookie, PW.alice, NEW_PW);
				const stored = w.db.prepare("SELECT password_hash FROM users WHERE id = 1").get().password_hash;
				const audited = w.db.prepare("SELECT COUNT(*) AS n FROM audit_trail WHERE action = 'change_password'").get().n;
				p.concurrentChangeRefused = r.status === 409 && !!r.json && r.json.code === "PASSWORD_CHANGED_MEANWHILE" &&
					stored === adminHash && audited === 0 && isOpen(w, o);
			} finally { await w.close(); }
		}
	},

	// §4b: what changes while change-password awaits bcrypt
	async changeRace(sources, p) {
		const demote = (db) => db.prepare("UPDATE users SET role = 'Driver', driver_name = 'Alice Driver' WHERE id = 1").run();
		// A bcrypt whose hash() runs `during` in the window after the password is
		// verified: the point where another request can land.
		const racingBcrypt = (during) => ({
			compare: (pw, h) => bcrypt.compare(pw, h),
			hash: async (pw) => { const h = await bcrypt.hash(pw, 4); during(); return h; },
		});
		{
			// Demoted the way PUT /api/users/:id does it: the role changes and every
			// session of the account is revoked.
			let w = null;
			w = await startWorld({ sources, bcryptImpl: racingBcrypt(() => { demote(w.db); w.purgeUserSessions(1, null); }) });
			try {
				const a = await login(w, "alice", PW.alice);
				// Flagged after this sign-in, so the flag refresh edits the session at
				// the start of the change request: a response that saved the session
				// would write the revoked one straight back into the store.
				w.db.prepare("UPDATE users SET must_change_password = 1 WHERE id = 1").run();
				const hashBefore = w.db.prepare("SELECT password_hash FROM users WHERE id = 1").get().password_hash;
				const r = await changePassword(w, a.cookie, PW.alice, NEW_PW);
				const hashAfter = w.db.prepare("SELECT password_hash FROM users WHERE id = 1").get().password_hash;
				p.revokedMidChangeRefused = r.status === 401 && !!r.json && r.json.code === "SESSION_ENDED" && !r.cookie &&
					hashAfter === hashBefore && changeAudits(w.db).length === 0;
				p.revokedMidChangeNotSavedBack = storedUser(w.db, sidOf(a.cookie)) === undefined && sessionsOf(w.db, 1).length === 0;
			} finally { await w.close(); }
		}
		{
			// Demoted while this session survives (the role row changed, nothing was
			// revoked): the rotated session must say what the row says NOW.
			let w = null;
			w = await startWorld({ sources, bcryptImpl: racingBcrypt(() => demote(w.db)) });
			try {
				const a = await login(w, "alice", PW.alice);
				const r = await changePassword(w, a.cookie, PW.alice, NEW_PW);
				const rotated = r.status === 200 && r.cookie ? storedUser(w.db, sidOf(r.cookie)) : null;
				const sessionSaysDriver = !!rotated && rotated.role === "Driver" && rotated.driverName === "Alice Driver";
				// ...and a socket on that cookie gets the driver's rooms, not dispatch.
				const tab = sessionSaysDriver ? await connectTab(w, r.cookie) : null;
				const driverRoom = !!tab && (await joins(w, tab, "dispatch", ROOMS.driverRoom("Alice Driver")));
				p.demotedMidChangeGetsNewRole = sessionSaysDriver && driverRoom && !inRoom(w, "dispatch", tab.id);
				// The audit row records the account as it is now, not the incoming copy.
				const audits = changeAudits(w.db);
				p.auditActorIsTheAccountNow = r.status === 200 && audits.length === 1 && audits[0].user_id === 1 && audits[0].role === "Driver";
			} finally { await w.close(); }
		}
	},

	// §6: the gate when the store cannot be read. The transport is opened while
	// the store is fine (the public tracker holds it open), THEN the store goes
	// away, THEN the default namespace connects over that transport.
	async gateStore(sources, p) {
		const w = await startWorld({ sources });
		let m = null;
		try {
			const a = await login(w, "alice", PW.alice);
			m = new ioClient.Manager(`http://127.0.0.1:${w.port}`, {
				transports: ["websocket"], reconnection: false, extraHeaders: { cookie: a.cookie },
			});
			const tracker = m.socket("/public-track");
			w.clients.push(tracker);
			if (!(await waitFor(tracker, "connect"))) throw new Error("the tracker never connected");
			w.db.exec("ALTER TABLE sessions RENAME TO sessions_offline");
			try {
				const dflt = m.socket("/");
				w.clients.push(dflt);
				const got = await waitFor(dflt, "connect");
				const id = dflt.id;
				p.gateFailsClosedOnUnreadableStore = !!got && !w.io.of("/").sockets.get(id) &&
					![...w.io.of("/").sockets.values()].some((s) => s.data && s.data.sid === sidOf(a.cookie));
			} finally {
				w.db.exec("ALTER TABLE sessions_offline RENAME TO sessions");
			}
		} finally {
			try { if (m && m.engine) m.engine.close(); } catch { /* closed */ }
			await w.close();
		}
	},

	// §5
	async sweep(sources, p) {
		{
			const w = await startWorld({ sources });
			try {
				const a = await login(w, "alice", PW.alice);
				const b = await login(w, "bob", PW.bob);
				const c = await login(w, "root", PW.root);
				const ta = await connectTab(w, a.cookie);
				const tb = await connectTab(w, b.cookie);
				const tc = await connectTab(w, c.cookie);
				p.sweepOfLiveSessionsIsNoop = w.helpers.sweepSessionlessSockets() === 0 && isOpen(w, ta) && isOpen(w, tb) && isOpen(w, tc);
				// Gone, the way a script clearing `sessions` from a shell leaves it...
				w.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sidOf(a.cookie));
				// ...and present but expired, which the store no longer returns.
				w.db.prepare("UPDATE sessions SET expire = ? WHERE sid = ?").run(new Date(Date.now() - 60000).toISOString(), sidOf(b.cookie));
				const before = logs.length;
				const n = w.helpers.sweepSessionlessSockets();
				p.sweepClosesDeletedSession = await closedByServer(w, ta);
				p.sweepClosesExpiredSession = await closedByServer(w, tb);
				p.sweepSparesLiveSession = isOpen(w, tc);
				p.sweepCountsAndLogs = n === 2 && logs.slice(before).some((l) => /sweep closed 2 live-update socket/.test(l));
			} finally { await w.close(); }
		}
		{
			const w = await startWorld({ sources });
			try {
				const a = await login(w, "alice", PW.alice);
				const ta = await connectTab(w, a.cookie);
				w.db.exec("ALTER TABLE sessions RENAME TO sessions_offline");
				let n;
				try { n = w.helpers.sweepSessionlessSockets(); } finally { w.db.exec("ALTER TABLE sessions_offline RENAME TO sessions"); }
				p.sweepFailsOpen = n === 0 && isOpen(w, ta);
			} finally { await w.close(); }
		}
	},

	// §6 and §7: one transport carrying the signed-in default namespace AND the
	// public tracker, the way a signed-in tab that opens /track shares it.
	async shared(sources, p) {
		const w = await startWorld({ sources });
		let m = null;
		try {
			const a = await login(w, "alice", PW.alice);
			// A Manager opens its transport as it is constructed, so the cookie
			// goes in here: this one handshake is what both namespaces share.
			m = new ioClient.Manager(`http://127.0.0.1:${w.port}`, {
				transports: ["websocket"], reconnection: false, extraHeaders: { cookie: a.cookie },
			});
			const tracker = m.socket("/public-track");
			const dflt = m.socket("/");
			w.clients.push(tracker, dflt);
			const [c1, c2] = await Promise.all([waitFor(tracker, "connect"), waitFor(dflt, "connect")]);
			if (!c1 || !c2) throw new Error("the shared transport never connected");
			const trackerTab = { s: tracker, id: tracker.id, reasons: [] };
			const tab = { s: dflt, id: dflt.id, reasons: [] };
			dflt.on("disconnect", (reason) => tab.reasons.push(reason));
			tracker.emit("subscribe", { loadId: "L-100" });
			const subscribed = await waitUntil(() => inRoom(w, "load:L-100", trackerTab.id, "/public-track"));
			const joined = await joins(w, tab, "dispatch", "dispatch");
			const engineId = m.engine && m.engine.id;
			const onOneTransport = !!engineId && serverSocket(w, tab).conn.id === serverSocket(w, trackerTab, "/public-track").conn.id;

			await request(w.port, "POST", "/api/auth/logout", { cookie: a.cookie });
			p.sharedLogoutClosesDefault = subscribed && joined && onOneTransport && (await closedByServer(w, tab));
			const trackerAlive = () => tracker.connected && isOpen(w, trackerTab, "/public-track");
			p.trackerSurvivesLogout = subscribed && trackerAlive() &&
				(await receives(tracker, "tracker-update", () => w.io.of("/public-track").to("load:L-100").emit("tracker-update", { lat: 3 })));

			// CONNECT again over the SAME transport. The server hands the new socket
			// the handshake's session object, which still names alice.
			if (p.sharedLogoutClosesDefault && m.engine && m.engine.id === engineId) {
				dflt.connect();
				const again = await waitFor(dflt, "connect");
				const reId = dflt.id;
				p.staleReconnectRefused = !!again && m.engine.id === engineId && !w.io.of("/").sockets.get(reId) &&
					![...w.io.of("/").sockets.values()].some((s) => s.data && s.data.sid === sidOf(a.cookie));
			} else {
				p.staleReconnectRefused = false;
			}

			w.helpers.sweepSessionlessSockets();
			p.trackerSurvivesSweep = trackerAlive();
		} finally {
			try { if (m && m.engine) m.engine.close(); } catch { /* closed */ }
			await w.close();
		}
	},
};

async function probe(sources, only = null) {
	const p = {};
	const errors = [];
	for (const [name, run] of Object.entries(SCENARIOS)) {
		if (only && !only.has(name)) continue;
		try {
			await run(sources, p);
		} catch (err) {
			errors.push(`${name}: ${err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err}`);
		}
	}
	return { p, errors };
}

// ─────────────────────────────── §1–§7 the shipped code, property by property
const PROPS = {
	logoutClosesSession: ["logout", "§1 logout must close the live-update sockets of the session it ends (the client sees a server disconnect)"],
	logoutLeavesNoRoom: ["logout", "§1 ...leaving them in no room"],
	logoutSparesOtherDevice: ["logout", "§1 ...and only that session's: the same account on another device stays connected and keeps receiving"],
	refusedLoginClosesNothing: ["login", "§2 a refused sign-in changed no session, so it must close no socket"],
	loginClosesReplacedSession: ["login", "§2 a sign-in must close the sockets of the session it replaced, which may belong to a different person"],
	loginSparesOtherSessions: ["login", "§2 ...and no other session's"],
	newSessionIsNewPerson: ["login", "§2 the new session's socket must be the new person, in their rooms and not the previous person's"],
	setupClosesReplacedSession: ["setup", "§2 first-time setup must close the sockets of the session it replaced"],
	purgeClosesUser: ["purge", "§3 purgeUserSessions() must close the user's sockets on the sessions it revokes"],
	purgeSparesKeptSession: ["purge", "§3 ...but not on the session it spares"],
	purgeSparesOtherUsers: ["purge", "§3 ...and never another user's"],
	purgeWithNoSpareClosesAll: ["purge", "§3 with nothing spared, it must close every socket of the user"],
	renameRevokesTarget: ["userEdit", "§3b PUT /api/users/:id renaming a driver must revoke every session of that account, sparing none: purgeUserSessions(id, null)"],
	renameClosesTargetSockets: ["userEdit", "§3b ...closing their live-update sockets, and the room they joined under the old name"],
	renameSparesAdmin: ["userEdit", "§3b ...and leave the admin who made the change signed in"],
	renameLeavesEditorSession: ["userEdit", "§3b ...on the same session ID, with their socket still in its room: editing someone else rebuilds nothing of the editor's"],
	renameAuditCounts: ["userEdit", "§3b the update_user audit line must record the rename and how many sessions it revoked"],
	selfRenameSparesCurrent: ["userEdit", "§3b a self-edit must spare the session making the request: purgeUserSessions(id, currentSid), the browser staying signed in"],
	selfRenameRevokesOthers: ["userEdit", "§3b ...and revoke the account's other sessions and their sockets"],
	unchangedNameRevokesNothing: ["userEdit", "§3b the same driver name resent (padded or not), or an email / full name / company edit, must revoke nothing"],
	caseOnlyRenameRevokes: ["userEdit", "§3b a case-only rename must revoke: it is a rename, and the cascade has moved every row to the new spelling"],
	clearedNameRevokes: ["userEdit", "§3b clearing the driver name must revoke"],
	roleChangeRevokes: ["userEdit", "§3b a role change must revoke"],
	passwordResetRevokes: ["userEdit", "§3b an admin password reset must revoke"],
	selfEditRefreshesSession: ["selfEdit", "§3c a self-edit of the caller's own driver name must rebuild the spared session from the account row, with exactly the fields login writes"],
	selfEditRotatesSession: ["selfEdit", "§3c ...under a NEW session ID: the response carries its cookie, and the old ID is gone from the store and signs no one in"],
	selfEditEndsOwnSockets: ["selfEdit", "§3c ...and end the old session's live-update sockets, taking them out of the rooms the old identity earned"],
	selfEditReconnectsAsRebuilt: ["selfEdit", "§3c a socket reconnecting on the new cookie must be the rebuilt identity"],
	selfEditStaleTransportRefused: ["selfEdit", "§3c a CONNECT sent again, after a self-demotion, over a transport opened before it must be refused: it presents the retired session ID"],
	selfProfileEditKeepsSession: ["selfEdit", "§3c a self-edit of a profile field only must revoke nothing and leave the session's sockets in their rooms"],
	selfDemotionTakesEffect: ["selfEdit", "§3c a Super Admin who demotes themselves must be refused as one on the very next request (401 on the old cookie, 403 on the new), the session saying Driver"],
	selfDemotionMovesRooms: ["selfEdit", "§3c ...their socket must leave the dispatch room, and reconnect into the driver's room only"],
	selfEditAuditKeepsAuthority: ["selfEdit", "§3c the update_user audit line must record the identity that was authorised to make the change"],
	selfEditRevokedMeanwhileStaysEnded: ["selfEdit", "§3c a session revoked while its own self-edit awaited must stay ended: the rebuild must not save it back"],
	refreshFailsClosed: ["selfEdit", "§3c when the account row cannot be read the session must be ended, sockets included, never left carrying the old identity"],
	selfPasswordResetRotatesSession: ["selfEdit", "§3c a self password reset must sign the account's other sessions out and continue this browser on a new session ID, as change-password does"],
	refreshLogsFailedEnd: ["selfEdit", "§3c a store that fails to end the session must be logged, not swallowed"],
	refreshLogsFailedRotation: ["selfEdit", "§3c a store that fails to rotate the session must be logged, and this browser answered with a session that holds no user"],
	fixRenameRevokesMoved: ["fixName", "§3d fix-driver-name must revoke every account whose stored driver name its cascade changed, in any case, sparing no session"],
	fixRenameClosesSockets: ["fixName", "§3d ...closing their live-update sockets"],
	fixRenameSparesOthers: ["fixName", "§3d ...and no other account: not a full-name-only match (whose full name the cascade did rewrite), not a longer name, not the admin"],
	fixRenameLeavesEditorSession: ["fixName", "§3d renaming someone else must leave the admin's own session as it was: same session ID, socket still in its room"],
	fixMergeRevokesOnlyRenamed: ["fixName", "§3d a MERGE must revoke the renamed account only, not the account that already held the new name"],
	fixRenameAuditCounts: ["fixName", "§3d the fix_driver_name audit line must carry how many sessions ended"],
	fixReadsAfterLastAwait: ["fixName", "§3d the accounts must be read after the route's last await: a change landing during the sheet write decides whose sessions end"],
	fixDryRunRevokesNothing: ["fixName", "§3d a dry run must revoke nothing"],
	fixRefusalRevokesNothing: ["fixName", "§3d a refused rename must revoke nothing"],
	fixSheetFailureRevokesNothing: ["fixName", "§3d a failed sheet write must revoke nothing"],
	fixRollbackRevokesNothing: ["fixName", "§3d a cascade that rolled back (PARTIAL_RENAME) must revoke nothing"],
	fixSelfRenameSparesAndRebuilds: ["fixName", "§3d a self-rename must spare the requesting session and rebuild it, under a new session ID, as the new name, its sockets reconnecting as that name"],
	fixSelfRenameRevokesOthers: ["fixName", "§3d ...and revoke the account's other sessions, counted in the audit line"],
	fixUnchangedAccountNotRevoked: ["fixName", "§3d an account the cascade writes back unchanged (already spelled the new way) must not be revoked"],
	fixCaseOnlyRevokes: ["fixName", "§3d a case-only rename that changes an account's stored name must revoke it"],
	changeClosesThisSessionsSockets: ["change", "§4 change-password must close every socket of the old cookie, the asking tab's included"],
	changeClosesOtherDevices: ["change", "§4 ...and the sockets of the account's other sessions"],
	changeSparesOtherUsers: ["change", "§4 ...and leave other accounts alone"],
	changeNewCookieSocketJoins: ["change", "§4 a socket on the NEW cookie must be accepted and, the flag cleared, join and receive"],
	changeNewCookieIsLive: ["change", "§4 the rotated cookie must be the live session, with the flag cleared"],
	changeSessionHasLoginShape: ["change", "§4 the rotated session must carry exactly the fields login writes, from the account row"],
	revokedMidChangeRefused: ["changeRace", "§4b a session revoked while the change awaited bcrypt must be answered 401 SESSION_ENDED, with no password, cookie or audit row written"],
	revokedMidChangeNotSavedBack: ["changeRace", "§4b ...and the revoked session must not be saved back into the store by the response"],
	demotedMidChangeGetsNewRole: ["changeRace", "§4b a role changed while the change awaited bcrypt must reach the rotated session, and its socket must get the new role's rooms"],
	auditActorIsTheAccountNow: ["changeRace", "§4b ...and the change_password audit row must record the account as re-read, not the incoming copy"],
	gateFailsClosedOnUnreadableStore: ["gateStore", "§6 the connection gate must refuse when the session store cannot be read (fail CLOSED)"],
	changeAudited: ["change", "§4 a password change must write one change_password audit row, as the account itself"],
	auditSaysRequired: ["change", "§4 ...saying the change was required, read after the last await and before the flag is cleared"],
	auditCountsRevoked: ["change", "§4 ...and how many other sessions it signed out"],
	auditHoldsNoSecret: ["change", "§4 the audit row must hold no password, old or new, and no hash ($2 prefix)"],
	auditPlainWhenNotRequired: ["change", "§4 a change nobody required must not be labelled required, and a lone session revokes 0"],
	concurrentChangeRefused: ["change", "§4 a password changed while the request awaited bcrypt must be answered 409, with nothing overwritten, purged or audited"],
	sweepOfLiveSessionsIsNoop: ["sweep", "§5 the sweep must leave sockets whose sessions are live"],
	sweepClosesDeletedSession: ["sweep", "§5 the sweep must close a socket whose session row is gone"],
	sweepClosesExpiredSession: ["sweep", "§5 ...and one whose session has expired (the store's own test)"],
	sweepSparesLiveSession: ["sweep", "§5 ...and nothing else"],
	sweepCountsAndLogs: ["sweep", "§5 ...returning and logging how many it closed"],
	sweepFailsOpen: ["sweep", "§5 an unreadable session store must close NOTHING (never every tab in the fleet once a minute)"],
	sharedLogoutClosesDefault: ["shared", "§6 on a transport shared with the tracker, logout must close the default namespace"],
	staleReconnectRefused: ["shared", "§6 a CONNECT sent again over the old transport after the session ended must be refused"],
	trackerSurvivesLogout: ["shared", "§7 the public tracker on that transport must stay connected and keep receiving"],
	trackerSurvivesSweep: ["shared", "§7 ...and the sweep must never touch it"],
};

// ─────────────────────────────── §8 the source
function sectionSource() {
	const at = (s, needle) => s.indexOf(needle);

	const logout = stripComments(SRCS.logout);
	const lo = at(logout, "disconnectSessionSockets(req.sessionID)");
	ok(lo > 0 && lo < at(logout, "req.session.destroy("), "§8 logout must close the session's sockets BEFORE destroy(), while req.sessionID still names it");

	const login = stripComments(SRCS.login);
	const lDisc = at(login, "disconnectSessionSockets(req.sessionID)");
	const lRot = at(login, "rotating = true;");
	const lRegen = at(login, "req.session.regenerate(");
	ok(lRot > at(login, "await bcrypt.compare(") && lDisc > lRot && lDisc < lRegen,
		"§8 login must close the replaced session's sockets after the password check and BEFORE regenerate()");
	ok((login.match(/disconnectSessionSockets\(/g) || []).length === 1, "§8 ...exactly once");

	const setup = stripComments(SRCS.setup);
	const sDisc = at(setup, "disconnectSessionSockets(req.sessionID)");
	ok(sDisc > 0 && sDisc < at(setup, "req.session.regenerate("), "§8 setup must close the replaced session's sockets BEFORE regenerate()");

	const change = stripComments(SRCS.change);
	const lastAwait = change.lastIndexOf("await ");
	const live = at(change, "const stillLive = liveSessionIds([currentSid]);");
	const refusal = at(change, "if (!stillLive || !stillLive.has(currentSid)) {");
	const destroyed = at(change, "req.session.destroy(() => {});");
	const reread = at(change, 'db.prepare("SELECT * FROM users WHERE id = ?").get(userId)');
	const check = at(change, "if (current.password_hash !== row.password_hash)");
	const flag = at(change, "const requiredChange = !!current.must_change_password;");
	const update = at(change, 'db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?")');
	const purge = at(change, "const sessionsRevoked = purgeUserSessions(userId, currentSid);");
	const audit = at(change, 'logAudit({ session: { user: freshUser } }, "change_password"');
	const fresh = at(change, "const freshUser = {");
	const closeOwn = at(change, "disconnectSessionSockets(currentSid);");
	const regen = at(change, "req.session.regenerate(");
	const assign = at(change, "req.session.user = freshUser;");
	const save = at(change, "req.session.save(");
	ok(lastAwait > 0 && live > lastAwait && refusal > live && destroyed > refusal && reread > destroyed &&
		check > reread && flag > check && update > flag,
		"§8 after its LAST await, change-password must confirm its session is live (refusing and destroying otherwise), re-read the whole account row, refuse a changed hash and read the required flag, all before the UPDATE");
	ok(update < purge && purge < fresh && fresh < audit && audit < closeOwn && closeOwn < regen,
		"§8 ...then UPDATE → purge (other sessions and their sockets) → rebuild the session → audit (as the rebuilt account) → close this session's sockets → rotate");
	ok(regen < assign && assign < save, "§8 ...and the rotated session is the rebuilt one, assigned inside the rotation before the save");
	const freshSrc = fresh > 0 ? change.slice(fresh, change.indexOf("};", fresh)) : "";
	const LOGIN_FIELDS = ["id: current.id", "username: current.username", "role: current.role", "driverName: current.driver_name",
		"email: current.email", "fullName: current.full_name", "companyName: current.company_name", "mustChangePassword: false"];
	ok(LOGIN_FIELDS.every((f) => freshSrc.includes(f)),
		"§8 the rotated session is built from the re-read row, field by field, with the flag the UPDATE cleared");
	ok(!/\.\.\.\s*req\.session\b/.test(change) && !/Object\.assign\([^)]*req\.session/.test(change),
		"§8 ...and never copied from the session the request arrived with, which a change in the bcrypt window leaves stale");
	ok(!/DELETE FROM sessions/.test(change), "§8 change-password must revoke through purgeUserSessions(); a hand-copied DELETE would leave the sockets up");
	ok(!/moveSessionSockets/.test(stripComments(SRC)), "§8 no socket follows a rotated session: the old cookie's sockets are closed, never re-pointed");
	const auditCall = change.slice(audit, change.indexOf(");", audit));
	ok(audit > 0 && !/newPassword|currentPassword|\bhash\b|password_hash|\brow\b|\bcurrent\b/.test(auditCall),
		"§8 the change_password audit row must be built from no password and no hash");

	const purgeSrc = stripComments(SRCS.purge);
	const pDisc = at(purgeSrc, "disconnectUserSockets(userId, { exceptSid });");
	ok(pDisc > 0 && pDisc < at(purgeSrc, "DELETE FROM sessions"), "§8 purgeUserSessions() must close the user's sockets, sparing exceptSid, before the DELETE");

	const upd = stripComments(SRCS.updateUser);
	const uTxn = at(upd, "db.transaction(() => {");
	const uPurge = at(upd, "purgeUserSessions(id, ");
	const uAudit = at(upd, 'logAudit(req, "update_user"');
	ok(uTxn > 0 && uPurge > uTxn && uAudit > uPurge && (upd.match(/purgeUserSessions\(/g) || []).length === 1,
		"§8 PUT /api/users/:id must revoke through purgeUserSessions() exactly once, after its transaction commits and before its update_user audit line (which reports the count)");
	ok(upd.lastIndexOf("await ") < uTxn, "§8 ...synchronously: no await between the write and the revocation");
	const uRolledBack = at(upd, '"UPDATE_ROLLED_BACK"');
	ok(uRolledBack > uTxn && uRolledBack < uPurge && !/\breturn\b|\bres\./.test(upd.slice(uRolledBack, uPurge)),
		"§8 ...and nothing after the rollback answer can return or respond before it, so a committed change always reaches the revocation");
	ok(!/DELETE FROM sessions/.test(upd), "§8 ...and never through a hand-copied DELETE, which would leave the sockets up");
	const uRefresh = at(upd, "refreshOwnSession(req)");
	ok(uRefresh > uAudit && uRefresh < at(upd, "res.json({ success: true, renamed })") && (upd.match(/refreshOwnSession\(/g) || []).length === 1,
		"§8 PUT /api/users/:id rebuilds a self-edited session once, after its audit line and before it answers");

	const fx = stripComments(SRCS.fixName);
	const fLastAwait = fx.lastIndexOf("await ");
	const fRead = at(fx, "renamedAccountIds = driverRenameAccountIds(oldTrim, newTrim);");
	const fCascade = at(fx, "applyDriverRenameSqlite({");
	const fPartial = at(fx, '"PARTIAL_RENAME"');
	const fPurge = at(fx, "purgeUserSessions(uid, ");
	const fAudit = at(fx, 'logAudit(req, "fix_driver_name"');
	const fRefresh = at(fx, "refreshOwnSession(req)");
	ok(fLastAwait > 0 && fRead > fLastAwait && fCascade > fRead && !/\bawait\b|\breturn\b|\bres\./.test(fx.slice(fRead, fCascade)),
		"§8 fix-driver-name reads the renamed accounts after its last await, immediately before the cascade, with nothing between");
	ok(fPartial > fCascade && fPurge > fPartial && fAudit > fPurge && !/\breturn\b|\bres\./.test(fx.slice(fPartial, fPurge)),
		"§8 ...revokes after the cascade commits, with nothing that can return or respond in between, and before its audit line (which reports the count)");
	ok((fx.match(/purgeUserSessions\(/g) || []).length === 1 && !/DELETE FROM sessions/.test(fx),
		"§8 ...once, through purgeUserSessions(), never a hand-copied DELETE");
	ok(fRefresh > fAudit && fRefresh < at(fx, "fixed: sheetChanged,") && (fx.match(/refreshOwnSession\(/g) || []).length === 1,
		"§8 ...and rebuilds a self-renamed session after its audit line and before it answers");

	const acct = stripComments(SRCS.accountIds);
	ok(/DRIVER_RENAME_TARGETS\.find\(\(t\) => t\.key === "users"\)/.test(acct) && acct.includes("driverRenameWhereSql(leg, opts)") &&
		acct.includes("driverRenameWhereArgs(leg, oldLower, opts)") && acct.includes("driverRenameNewValue(leg, "),
		"§8 driverRenameAccountIds() reads through the cascade's own users leg (target, WHERE, arguments, written value), never a copy of it");

	const rf = stripComments(SRCS.refresh);
	const rLive = at(rf, "liveSessionIds([oldSid])");
	const rRead = at(rf, 'db.prepare("SELECT * FROM users WHERE id = ?").get(uid)');
	const rDisc = at(rf, "disconnectSessionSockets(oldSid);");
	const rRegen = at(rf, "req.session.regenerate(");
	const rAssign = at(rf, "req.session.user = rebuilt;");
	ok(rLive > 0 && rRead > rLive && rDisc > rRead && rRegen > rDisc && rAssign > rRegen && at(rf, "req.session.destroy(") > 0,
		"§8 refreshOwnSession() confirms the session is still in the store, re-reads the row, ends the old ID's sockets, then rebuilds under a new ID; otherwise it destroys the session");
	ok(!/req\.session\.user\s*=\s*\{/.test(rf) && (rf.match(/req\.session\.user\s*=/g) || []).length === 1,
		"§8 ...and never edits the session in place: the rebuilt user is assigned once, inside the rotation");
	const REFRESH_FIELDS = ["id: row.id", "username: row.username", "role: row.role", "driverName: row.driver_name",
		"email: row.email", "fullName: row.full_name", "companyName: row.company_name", "mustChangePassword: !!row.must_change_password"];
	ok(REFRESH_FIELDS.every((f) => rf.includes(f)) && /^function refreshOwnSession\(req\) \{/.test(rf),
		"§8 ...rebuilds it field by field from the row it re-read, and takes no account id: only the requesting session's own account");

	const handler = stripComments(SRCS.ioHandler);
	const gate = at(handler, "liveSessionIds([sid])");
	const dataSid = at(handler, "socket.data.sid = sid;");
	const dataUid = at(handler, "socket.data.userId = ");
	const register = at(handler, 'socket.on("register"');
	ok(at(handler, "socket.request?.session?.user") < gate && gate > 0 && gate < dataSid && dataSid < register && dataUid > 0 && dataUid < register,
		"§8 the connection gate must consult the store, then record who the socket is, before any room can be joined");
	ok(!/\.join\(\s*["'`](sid|user):/.test(handler), "§8 identity must never be a room: sid:/user: rooms share a namespace with the name rooms");

	const helpers = stripComments(SRCS.helpers);
	ok(!/disconnect\(\s*true\s*\)/.test(helpers), "§8 the helpers close the default namespace only, never the transport it may share with the tracker");
	ok(/io\.of\("\/"\)\.sockets/.test(helpers) && !/public-track/.test(helpers), "§8 the helpers walk the default namespace, and only it");
	ok(/datetime\('now'\) < datetime\(expire\)/.test(helpers), "§8 liveness is the session store's own test: the row exists AND has not expired");

	const code = stripComments(SRC);
	const schedules = code.split("\n").filter((l) => /setInterval\(\s*sweepSessionlessSockets\b/.test(l));
	ok(schedules.length === 1 && /setInterval\(sweepSessionlessSockets, SOCKET_SESSION_SWEEP_MS\)/.test(schedules[0]),
		`§8 the sweep must be scheduled exactly once (found ${schedules.length})`);
	ok(/\nconst SOCKET_SESSION_SWEEP_MS = 60 \* 1000;\n/.test(code), "§8 ...every 60 seconds");
	ok(/\nconst socketSessionSweepTimer = setInterval\(sweepSessionlessSockets, SOCKET_SESSION_SWEEP_MS\);\nif \(typeof socketSessionSweepTimer\.unref === "function"\) socketSessionSweepTimer\.unref\(\);\n/.test(code),
		"§8 ...on an unref'd timer");
	ok(/\napp\.use\(sessionMiddleware\);\nio\.engine\.use\(sessionMiddleware\);\n/.test(SRC),
		"§8 the socket handshake must keep reading the same session middleware as HTTP");
}

// ─────────────────────────────── §9 discrimination: one mutant per call site
const dropLine = (re) => (s) => s.replace(re, "");
const MUTANTS = [
	{
		name: "logout does not close the session's sockets",
		target: "logout",
		mutate: dropLine(/^\s*disconnectSessionSockets\(req\.sessionID\);\n/m),
		caughtBy: ["logoutClosesSession", "logoutLeavesNoRoom", "sharedLogoutClosesDefault"],
	},
	{
		name: "login does not close the replaced session's sockets",
		target: "login",
		mutate: dropLine(/^\s*disconnectSessionSockets\(req\.sessionID\);\n/m),
		caughtBy: ["loginClosesReplacedSession"],
	},
	{
		name: "login closes sockets AFTER regenerate() (so it names the new session)",
		target: "login",
		mutate: (s) => {
			const moved = s.replace(/^\s*disconnectSessionSockets\(req\.sessionID\);\n/m, "");
			const anchor = "\t\t// ⚠️ RE-READ AFTER THE LAST AWAIT";
			return moved.includes(anchor) ? moved.replace(anchor, "\t\tdisconnectSessionSockets(req.sessionID);\n" + anchor) : s;
		},
		caughtBy: ["loginClosesReplacedSession"],
	},
	{
		name: "setup does not close the replaced session's sockets",
		target: "setup",
		mutate: dropLine(/^\s*disconnectSessionSockets\(req\.sessionID\);\n/m),
		caughtBy: ["setupClosesReplacedSession"],
	},
	{
		name: "purgeUserSessions() revokes the sessions but not their sockets",
		target: "purge",
		mutate: dropLine(/^\s*disconnectUserSockets\(userId, \{ exceptSid \}\);\n/m),
		caughtBy: ["purgeClosesUser", "purgeWithNoSpareClosesAll", "changeClosesOtherDevices"],
	},
	{
		// The condition as it stood before the driver name joined it.
		name: "PUT /api/users/:id does not revoke on a driver-name change",
		target: "updateUser",
		mutate: (s) => s.replace("|| passwordHash || driverNameChanged) {", "|| passwordHash) {"),
		caughtBy: ["renameRevokesTarget", "renameClosesTargetSockets", "renameAuditCounts", "selfRenameRevokesOthers",
			"caseOnlyRenameRevokes", "clearedNameRevokes"],
	},
	{
		name: "a case-only rename treated as no change (a case-folded compare)",
		target: "updateUser",
		mutate: (s) => s.replace('driverName.trim() !== (user.driver_name || "")',
			'driverName.trim().toLowerCase() !== (user.driver_name || "").toLowerCase()'),
		caughtBy: ["caseOnlyRenameRevokes"],
	},
	{
		name: "stray padding counted as a rename (the raw value compared, not the stored one)",
		target: "updateUser",
		mutate: (s) => s.replace('driverName.trim() !== (user.driver_name || "")', 'driverName !== (user.driver_name || "")'),
		caughtBy: ["unchangedNameRevokesNothing"],
	},
	{
		name: "a self-edit revokes the session making the request",
		target: "updateUser",
		mutate: (s) => s.replace("purgeUserSessions(id, selfEdit ? req.sessionID : null)", "purgeUserSessions(id, null)"),
		caughtBy: ["selfRenameSparesCurrent"],
	},
	{
		name: "a role change no longer revokes",
		target: "updateUser",
		mutate: (s) => s.replace("if (roleChanged || passwordHash || driverNameChanged) {", "if (passwordHash || driverNameChanged) {"),
		caughtBy: ["roleChangeRevokes"],
	},
	{
		name: "a password reset no longer revokes",
		target: "updateUser",
		mutate: (s) => s.replace("|| passwordHash || driverNameChanged) {", "|| driverNameChanged) {"),
		caughtBy: ["passwordResetRevokes"],
	},
	{
		// §3c. The behaviour before the rebuild: a spared session kept its sign-in
		// identity until it signed in again.
		name: "PUT /api/users/:id leaves a self-edited session as it signed in",
		target: "updateUser",
		mutate: dropLine(/^\s*if \(selfEdit && \(roleChanged \|\| passwordHash \|\| driverNameChanged\)\) refreshOwnSession\(req\);\n/m),
		caughtBy: ["selfEditRefreshesSession", "selfEditEndsOwnSockets", "selfEditReconnectsAsRebuilt", "selfDemotionTakesEffect", "selfDemotionMovesRooms"],
	},
	{
		name: "a self password reset keeps the session ID (a copied cookie outlives it)",
		target: "updateUser",
		mutate: (s) => s.replace("if (selfEdit && (roleChanged || passwordHash || driverNameChanged)) refreshOwnSession(req);",
			"if (selfEdit && (roleChanged || driverNameChanged)) refreshOwnSession(req);"),
		caughtBy: ["selfPasswordResetRotatesSession"],
	},
	{
		name: "PUT /api/users/:id rebuilds the session BEFORE its audit line (the row then names the demoted identity)",
		target: "updateUser",
		mutate: (s) => {
			const REFRESH = "\t\tif (selfEdit && (roleChanged || passwordHash || driverNameChanged)) refreshOwnSession(req);\n";
			const AUDIT = '\t\tlogAudit(req, "update_user", "user", id,';
			const cut = s.replace(REFRESH, "");
			return cut === s || !cut.includes(AUDIT) ? s : cut.replace(AUDIT, REFRESH + AUDIT);
		},
		caughtBy: ["selfEditAuditKeepsAuthority"],
	},
	{
		name: "PUT /api/users/:id rebuilds the session on a profile-only self-edit too",
		target: "updateUser",
		mutate: (s) => s.replace("if (selfEdit && (roleChanged || passwordHash || driverNameChanged)) refreshOwnSession(req);", "if (selfEdit) refreshOwnSession(req);"),
		caughtBy: ["selfProfileEditKeepsSession"],
	},
	{
		name: "the rebuild leaves the session's sockets in their old rooms",
		target: "refresh",
		mutate: dropLine(/^\s*disconnectSessionSockets\(oldSid\);\n/m),
		caughtBy: ["selfEditEndsOwnSockets", "selfDemotionMovesRooms"],
	},
	{
		name: "the rebuild keeps the session ID (edits the session in place)",
		target: "refresh",
		mutate: (s) => s.replace(/\tlet rotated = false;\n[\s\S]*?\n\treturn rotated;/, "\treq.session.user = rebuilt;\n\treturn true;"),
		caughtBy: ["selfEditRotatesSession", "selfEditStaleTransportRefused"],
	},
	{
		name: "PUT /api/users/:id rebuilds the editor's own session when editing someone else",
		target: "updateUser",
		mutate: (s) => s.replace("if (selfEdit && (roleChanged || passwordHash || driverNameChanged)) refreshOwnSession(req);",
			"if (roleChanged || passwordHash || driverNameChanged) refreshOwnSession(req);"),
		caughtBy: ["renameLeavesEditorSession"],
	},
	{
		name: "fix-driver-name rebuilds the editor's own session whenever it renames anyone",
		target: "fixName",
		mutate: (s) => s.replace("if (renamedAccountIds.includes(selfId)) refreshOwnSession(req);", "if (renamedAccountIds.length) refreshOwnSession(req);"),
		caughtBy: ["fixRenameLeavesEditorSession"],
	},
	{
		name: "the rebuild copies the session the request arrived with, not the account row",
		target: "refresh",
		mutate: (s) => s.replace('row = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);',
			"row = { id: uid, username: req.session.user.username, role: req.session.user.role, driver_name: req.session.user.driverName, " +
			"email: req.session.user.email, full_name: req.session.user.fullName, company_name: req.session.user.companyName, " +
			"must_change_password: req.session.user.mustChangePassword ? 1 : 0 };"),
		caughtBy: ["selfEditRefreshesSession", "selfDemotionTakesEffect"],
	},
	{
		name: "the rebuild does not check the session is still in the store (a revoked one is saved back)",
		target: "refresh",
		mutate: (s) => s.replace("if (live && live.has(oldSid)) {", "if (true) {"),
		caughtBy: ["selfEditRevokedMeanwhileStaysEnded"],
	},
	{
		name: "an unreadable account row leaves the session as it was",
		target: "refresh",
		mutate: (s) => s.replace(/\t\treq\.session\.destroy\(\(err\) => \{\n[\s\S]*?\n\t\t\}\);\n\t\treturn false;/, "\t\treturn false;"),
		caughtBy: ["refreshFailsClosed"],
	},
	{
		name: "a store that fails to end the session is not logged",
		target: "refresh",
		mutate: (s) => s.replace('if (err) console.error("session refresh: ending the session failed:", err.message);', ""),
		caughtBy: ["refreshLogsFailedEnd"],
	},
	{
		// §3d. The behaviour before this route revoked anything.
		name: "fix-driver-name ends no sessions",
		target: "fixName",
		mutate: (s) => s.replace("sessionsRevoked += purgeUserSessions(uid, uid === selfId ? req.sessionID : null);", ""),
		caughtBy: ["fixRenameRevokesMoved", "fixRenameClosesSockets", "fixRenameAuditCounts", "fixSelfRenameRevokesOthers", "fixCaseOnlyRevokes"],
	},
	{
		name: "fix-driver-name reads the renamed accounts before its last await (the plan's view, not the commit's)",
		target: "fixName",
		mutate: (s) => {
			const READ = "\t\t\trenamedAccountIds = driverRenameAccountIds(oldTrim, newTrim);\n";
			const DECL = "\t\tlet renamedAccountIds = [];\n";
			const ANCHOR = "\t\tlet sheetChanged = 0;\n";
			const cut = s.replace(READ, "").replace(DECL, "");
			if (cut === s || !cut.includes(ANCHOR)) return s;
			return cut.replace(ANCHOR, "\t\tconst renamedAccountIds = driverRenameAccountIds(oldTrim, newTrim);\n" + ANCHOR);
		},
		caughtBy: ["fixReadsAfterLastAwait"],
	},
	{
		name: "fix-driver-name revokes before its cascade commits (a rolled-back rename still signs people out)",
		target: "fixName",
		mutate: (s) => s.replace("\t\t\trenamedAccountIds = driverRenameAccountIds(oldTrim, newTrim);\n",
			"\t\t\trenamedAccountIds = driverRenameAccountIds(oldTrim, newTrim);\n\t\t\tfor (const uid of renamedAccountIds) purgeUserSessions(uid, null);\n"),
		caughtBy: ["fixRollbackRevokesNothing"],
	},
	{
		name: "a self-rename through fix-driver-name revokes the session making the request",
		target: "fixName",
		mutate: (s) => s.replace("purgeUserSessions(uid, uid === selfId ? req.sessionID : null)", "purgeUserSessions(uid, null)"),
		caughtBy: ["fixSelfRenameSparesAndRebuilds"],
	},
	{
		name: "fix-driver-name leaves a self-renamed session as it signed in",
		target: "fixName",
		mutate: dropLine(/^\s*if \(renamedAccountIds\.includes\(selfId\)\) refreshOwnSession\(req\);\n/m),
		caughtBy: ["fixSelfRenameSparesAndRebuilds"],
	},
	{
		name: "fix-driver-name's audit line omits the count",
		target: "fixName",
		mutate: dropLine(/^\s*sessionsRevoked,\n/m),
		caughtBy: ["fixRenameAuditCounts"],
	},
	{
		name: "the renamed accounts read with a hand-written exact-case match instead of the cascade's leg",
		target: "accountIds",
		mutate: (s) => s.replace("WHERE ${driverRenameWhereSql(leg, opts)}`)\n\t\t.all(...driverRenameWhereArgs(leg, oldLower, opts))",
			"WHERE \"${leg.column}\" = ?`)\n\t\t.all(String(oldName).trim())"),
		caughtBy: ["fixRenameRevokesMoved"],
	},
	{
		name: "the renamed accounts include ones the cascade writes back unchanged",
		target: "accountIds",
		mutate: dropLine(/^\s*\.filter\(\(r\) => r\.v !== written\)\n/m),
		caughtBy: ["fixUnchangedAccountNotRevoked"],
	},
	{
		name: "change-password revokes with its old hand-copied DELETE",
		target: "change",
		mutate: (s) => s.replace("const sessionsRevoked = purgeUserSessions(userId, currentSid);",
			"const sessionsRevoked = db.prepare(\"DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ? AND sid != ?\").run(userId, currentSid).changes;"),
		caughtBy: ["changeClosesOtherDevices"],
	},
	{
		name: "change-password leaves the old cookie's sockets open",
		target: "change",
		mutate: dropLine(/^\s*disconnectSessionSockets\(currentSid\);\n/m),
		caughtBy: ["changeClosesThisSessionsSockets"],
	},
	{
		name: "no session check after the last await (a revoked session carries on)",
		target: "change",
		mutate: (s) => s.replace("if (!stillLive || !stillLive.has(currentSid)) {", "if (false) {"),
		caughtBy: ["revokedMidChangeRefused", "revokedMidChangeNotSavedBack"],
	},
	{
		name: "the 401 leaves the in-memory session to be saved back",
		target: "change",
		mutate: dropLine(/^\s*req\.session\.destroy\(\(\) => \{\}\);\n/m),
		caughtBy: ["revokedMidChangeNotSavedBack"],
	},
	{
		name: "the audit row's actor taken from the incoming session copy",
		target: "change",
		mutate: (s) => s.replace('logAudit({ session: { user: freshUser } }, "change_password"', 'logAudit(req, "change_password"'),
		caughtBy: ["auditActorIsTheAccountNow"],
	},
	{
		name: "the rotated session copied from the session the request arrived with",
		target: "change",
		mutate: (s) => {
			const REGEN = "\t\treq.session.regenerate((regenErr) => {";
			if (!s.includes(REGEN) || !s.includes("req.session.user = freshUser;")) return s;
			return s
				.replace(REGEN, "\t\tconst staleCopy = Object.assign({}, req.session.user, { mustChangePassword: false });\n" + REGEN)
				.replace("req.session.user = freshUser;", "req.session.user = staleCopy;");
		},
		caughtBy: ["demotedMidChangeGetsNewRole"],
	},
	{
		name: "change-password writes no audit row",
		target: "change",
		mutate: (s) => s.replace(/\n\t\tlogAudit\(\{ session: \{ user: freshUser \} \}, "change_password"[\s\S]*?\);\n/, "\n"),
		caughtBy: ["changeAudited", "auditPlainWhenNotRequired"],
	},
	{
		name: "the audit row carries the new password",
		target: "change",
		mutate: (s) => s.replace("`Password changed${", "`Password changed to ${newPassword}${"),
		caughtBy: ["auditHoldsNoSecret"],
	},
	{
		name: "the audit row carries the new hash",
		target: "change",
		mutate: (s) => s.replace("`Password changed${", "`Password changed (${hash})${"),
		caughtBy: ["auditHoldsNoSecret"],
	},
	{
		name: "the required flag read after the UPDATE cleared it",
		target: "change",
		mutate: (s) => {
			const UPDATE = 'db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hash, userId);';
			const cut = s.replace(/^\s*const requiredChange = !!current\.must_change_password;\n/m, "");
			return cut === s ? s : cut.replace(UPDATE,
				UPDATE + '\n\t\tconst requiredChange = !!db.prepare("SELECT must_change_password FROM users WHERE id = ?").get(userId).must_change_password;');
		},
		caughtBy: ["auditSaysRequired"],
	},
	{
		name: "no re-check of the hash after the last await",
		target: "change",
		mutate: (s) => s.replace("if (current.password_hash !== row.password_hash) {", "if (false) {"),
		caughtBy: ["concurrentChangeRefused"],
	},
	{
		name: "the connection handler does not record who the socket is",
		target: "ioHandler",
		mutate: dropLine(/^\s*socket\.data\.sid = sid;\n\s*socket\.data\.userId = [^\n]*\n/m),
		caughtBy: ["logoutClosesSession", "purgeClosesUser", "changeClosesThisSessionsSockets", "sweepSparesLiveSession"],
	},
	{
		name: "the connection gate trusts the handshake's session object (no store check)",
		target: "ioHandler",
		mutate: (s) => s.replace("if (!live || !live.has(sid)) {", "if (!sid) {"),
		caughtBy: ["staleReconnectRefused"],
	},
	{
		name: "the connection gate fails OPEN when the store cannot be read",
		target: "ioHandler",
		mutate: (s) => s.replace("if (!live || !live.has(sid)) {", "if (live && !live.has(sid)) {"),
		caughtBy: ["gateFailsClosedOnUnreadableStore"],
	},
	{
		name: "the helpers close the whole transport (disconnect(true))",
		target: "helpers",
		mutate: (s) => s.replace("\t\t\tsocket.disconnect();\n", "\t\t\tsocket.disconnect(true);\n"),
		caughtBy: ["trackerSurvivesLogout"],
	},
	{
		name: "the sweep fails CLOSED on an unreadable store",
		target: "helpers",
		mutate: (s) => s.replace("if (!live) return 0;", "if (!live) return endSockets(sockets);"),
		caughtBy: ["sweepFailsOpen"],
	},
	{
		name: "liveness ignores expiry (a row that is merely present counts as live)",
		target: "helpers",
		mutate: (s) => s.replace(" AND datetime('now') < datetime(expire)", ""),
		caughtBy: ["sweepClosesExpiredSession"],
	},
	{
		// Every call site at once: the behaviour before this change, where ending a
		// session reached the cookie and never the socket.
		name: "the pre-fix behaviour (no call site at all)",
		edits: {
			logout: dropLine(/^\s*disconnectSessionSockets\(req\.sessionID\);\n/m),
			login: dropLine(/^\s*disconnectSessionSockets\(req\.sessionID\);\n/m),
			setup: dropLine(/^\s*disconnectSessionSockets\(req\.sessionID\);\n/m),
			purge: dropLine(/^\s*disconnectUserSockets\(userId, \{ exceptSid \}\);\n/m),
			ioHandler: (s) => s.replace("if (!live || !live.has(sid)) {", "if (!sid) {"),
			change: (s) => s
				.replace("const sessionsRevoked = purgeUserSessions(userId, currentSid);",
					"const sessionsRevoked = db.prepare(\"DELETE FROM sessions WHERE json_extract(sess, '$.user.id') = ? AND sid != ?\").run(userId, currentSid).changes;")
				.replace(/^\s*disconnectSessionSockets\(currentSid\);\n/m, "")
				.replace(/\n\t\tlogAudit\(\{ session: \{ user: freshUser \} \}, "change_password"[\s\S]*?\);\n/, "\n")
				.replace("if (!stillLive || !stillLive.has(currentSid)) {", "if (false) {")
				.replace("if (current.password_hash !== row.password_hash) {", "if (false) {"),
		},
		caughtBy: [
			"logoutClosesSession", "loginClosesReplacedSession", "setupClosesReplacedSession", "purgeClosesUser",
			"changeClosesThisSessionsSockets", "changeClosesOtherDevices", "changeAudited", "concurrentChangeRefused",
			"revokedMidChangeRefused", "staleReconnectRefused",
		],
	},
];

async function sectionMutants(shipped) {
	for (const m of MUTANTS) {
		const edits = m.edits || { [m.target]: m.mutate };
		const sources = { ...SRCS };
		let changed = true;
		for (const [target, mutate] of Object.entries(edits)) {
			const src = mutate(SRCS[target]);
			if (typeof src !== "string" || src === SRCS[target]) changed = false;
			else sources[target] = src;
		}
		ok(changed, `§9 mutant "${m.name}" did not change the source — its marker text moved`);
		if (!changed) continue;
		const only = new Set(m.caughtBy.map((prop) => PROPS[prop][0]));
		const { p, errors } = await probe(sources, only);
		// A mutant must be caught by an ASSERTION, not by crashing the harness.
		ok(errors.length === 0, `§9 mutant "${m.name}" crashed a scenario instead of being caught: ${errors.join(" || ")}`);
		for (const prop of m.caughtBy) {
			ok(shipped[prop] === true && p[prop] === false,
				`§9 MUTANT NOT CAUGHT — "${m.name}" must flip ${prop} (shipped ${shipped[prop]}, mutant ${p[prop]})`);
		}
	}
}

function finish() {
	restoreConsole();
	console.log(`\n${"=".repeat(64)}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		if (logs.length) console.log(`\nlogged during the run (last 8):\n  ${logs.slice(-8).join("\n  ")}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed`);
	process.exit(0);
}

(async () => {
	HASH = {
		alice: bcrypt.hashSync(PW.alice, 4),
		bob: bcrypt.hashSync(PW.bob, 4),
		carol: bcrypt.hashSync(PW.carol, 4),
		root: bcrypt.hashSync(PW.root, 4),
	};
	sectionSource();

	const { p: shipped, errors } = await probe(SRCS);
	ok(errors.length === 0, `the shipped code crashed a scenario: ${errors.join(" || ")}`);
	for (const [prop, [scenario, message]] of Object.entries(PROPS)) {
		ok(shipped[prop] === true, `${message} [${scenario}: ${prop} = ${shipped[prop]}]`);
	}
	const unlisted = Object.keys(shipped).filter((k) => !PROPS[k]);
	ok(unlisted.length === 0, `every probed property must be described in PROPS: ${unlisted.join(", ")}`);

	await sectionMutants(shipped);
	finish();
})().catch((e) => {
	restoreConsole();
	console.error(e);
	process.exit(1);
});
