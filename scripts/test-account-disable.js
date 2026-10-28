#!/usr/bin/env node
/**
 * Account disable, end to end on the shipped code: a disabled Super Admin or
 * Dispatcher account can't sign in, its sessions and live-update sockets end,
 * and the server is the gate for every switch.
 *
 * WHAT IS ASSERTED:
 *   §1 sign-in to a disabled account: the right password gets 403
 *      ACCOUNT_DISABLED, no cookie, no stamp, the session it arrived with left
 *      alone, one audit row a minute naming the account and never the typed
 *      text, one admin email an hour; a wrong password keeps the usual 401; a
 *      disable landing while the sign-in yields still refuses
 *   §2 disable: an account signed in on two browsers with a socket each is
 *      signed out everywhere, its session rows go, disable_user is audited
 *   §3 the backstop, disabled_at set with no purge: the old cookie gets 401, a
 *      new socket is refused, register joins no room, one sweep closes the rest
 *   §4 refusals, each audited with nothing written: CANNOT_DISABLE_SELF,
 *      ROLE_NOT_DISABLEABLE, PROTECTED_ACCOUNT (the list unset, valid, invalid)
 *   §5 the last enabled Super Admin: a self-demotion through PUT and a DELETE by
 *      a stale admin session are refused, nothing written
 *   §6 enable: sign-in works again, the columns clear, enable_user is audited;
 *      switching to the state an account is already in writes nothing
 *   §7 change-password: a disabled account's cookie gets 401, and a disable in
 *      its bcrypt window ends it with nothing written
 *   §8 PUT on a disabled account: the role is locked (409 ACCOUNT_DISABLED); a
 *      full-name edit and a password reset go through and leave it disabled
 *   §9 GET /api/users carries Disabled, DisabledAt, DisabledBy, DisabledReason
 *   §10 the notice: one email to ADMIN_NOTIFY_EMAIL per switch, not awaited,
 *      none in replica mode, none for a refusal or an unchanged answer
 *   §11 the switch off: disable 403 ACCOUNT_DISABLE_OFF, enable still works, an
 *      account disabled earlier is still refused
 *   §12 a session whose account row is gone, whose id is missing, 0 or "abc",
 *      or whose cached role the database no longer holds: 401 on its next
 *      request and its socket refused
 *   §13 PUT mid-request: the account disabled, or the acting account disabled
 *      or demoted, while the route awaits: refused, nothing written
 *   §14 escaping: a reason holding HTML is escaped in the email, one line in
 *      the audit row
 *   §15 order and failure direction: a protected-account refusal beats
 *      "unchanged"; with the users table unreadable the connection gate
 *      refuses and the minute sweep keeps sockets open
 *
 * Runs the SHIPPED code: the session configuration, the auth routes, GET, PUT
 * and DELETE /api/users, the switch routes and their helpers, the guards, the
 * refusal audit writers, the session and socket helpers and the connection
 * handler are lifted out of server.js (SERVER_JS=<path> reads another one) and
 * wired to the real express-session, its SQLite store, Socket.IO and
 * socket.io-client. In-memory SQLite with the users and audit_trail tables
 * built from server.js's own statements, loopback on 127.0.0.1:0, made-up
 * accounts only (example.test). PUT's period, sheet and rename machinery and
 * DELETE's period guard and archive are stubbed to "nothing blocks". A piece
 * missing from the server.js read (a base commit) is left out, so each case
 * fails for its own reason.
 *
 * Run: node scripts/test-account-disable.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { once } = require("events");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.env.SERVER_JS || path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// The shipped code logs on purpose (sign-outs, refusals, read errors). Keep it
// out of the run's output; replay the tail only on failure.
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
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
try {
	ioClient = require(require.resolve("socket.io-client", { paths: [path.join(ROOT, "client")] }));
} catch (e) {
	die(`socket.io-client did not load from client/node_modules (${e.message})`);
}
const SqliteStoreBase = SqliteStoreFactory(session);
let lib = null;
try { lib = require(path.join(ROOT, "lib", "account-disable.js")); } catch { lib = null; }
ok(!!lib, "lib/account-disable.js exists and loads");
const passwordRules = require(path.join(ROOT, "lib", "password-rules.js"));
// The sign-in lookup and rows the login route goes through (absent on an older base).
let signInLib = null;
try { signInLib = require(path.join(ROOT, "lib", "sign-in.js")); } catch { signInLib = null; }

// ── lift the shipped code ───────────────────────────────────────────────────
const count = (needle) => SRC.split(needle).length - 1;
// A statement from its exact head to the `});` that closes it in column 0.
function liftRoute(head, { optional = false } = {}) {
	if (count(head) !== 1) {
		if (optional) return null;
		die(`expected exactly 1 statement starting ${JSON.stringify(head)}, found ${count(head)}`);
	}
	const a = SRC.indexOf(head);
	const end = SRC.indexOf("\n});", a);
	if (end < 0) die(`no column-0 "});" after ${head}`);
	return SRC.slice(a, end + "\n});".length);
}
// A top-level function declaration, to the `}` that closes it in column 0.
function liftFunction(head, { optional = false } = {}) {
	const needle = `\n${head}`;
	if (count(needle) !== 1) {
		if (optional) return null;
		die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${count(needle)}`);
	}
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return SRC.slice(a, end + 2);
}
// A one-line `const NAME = …;`, or a block from its head to `close`.
function liftConst(head, close = null) {
	const needle = `\n${head}`;
	if (count(needle) !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}`);
	const a = SRC.indexOf(needle) + 1;
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	if (end < 0) die(`no end found after ${head}`);
	return SRC.slice(a, end + (close ? close.length : 1));
}
// The arrow function handed to `io.on("connection", …)`.
function liftHandler(head, prefix) {
	const stmt = liftRoute(head);
	if (!stmt.startsWith(prefix) || !stmt.endsWith(");")) die(`unexpected shape for ${head}`);
	return stmt.slice(prefix.length, -2);
}

const DISABLE_HEAD = 'app.post("/api/users/:id/disable", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const ENABLE_HEAD = 'app.post("/api/users/:id/enable", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {';
const SRCS = {
	login: liftRoute('app.post("/api/auth/login", loginLimiter, async (req, res) => {'),
	logout: liftRoute('app.post("/api/auth/logout", (req, res) => {'),
	session: liftRoute('app.get("/api/auth/session", (req, res) => {'),
	change: liftRoute('app.post("/api/auth/change-password", requireAuth, changePasswordLimiter, async (req, res) => {'),
	users: liftRoute('app.get("/api/users", requireRole("Super Admin"), (req, res) => {'),
	updateUser: liftRoute('app.put("/api/users/:id", requireRole("Super Admin"), userPasswordResetLimiter, async (req, res) => {'),
	deleteUser: liftRoute('app.delete("/api/users/:id", requireRole("Super Admin"), (req, res) => {'),
	disable: liftRoute(DISABLE_HEAD, { optional: true }),
	enable: liftRoute(ENABLE_HEAD, { optional: true }),
	facts: liftFunction("function accountSwitchFacts(req, id) {", { optional: true }),
	notify: liftFunction("function notifyAccountSwitch(kind, { target, actor, reason }) {", { optional: true }),
	signInRefusal: liftFunction("function disabledSignInRefusal(req, account) {", { optional: true }),
	signInAudit: liftFunction("function auditDisabledSignIn(req, account) {", { optional: true }),
	signInNotice: liftFunction("function noticeDisabledSignIn(account) {", { optional: true }),
	signOut: liftFunction("function signOutEndedAccount(req, res, next) {", { optional: true }),
	purge: liftFunction("function purgeUserSessions(userId, exceptSid) {"),
	refresh: liftFunction("function refreshOwnSession(req) {"),
	stamp: liftFunction("function stampLastLogin(userId) {"),
	requireAuth: liftFunction("function requireAuth(req, res, next) {"),
	requireRole: liftFunction("function requireRole(...roles) {"),
	currentFlag: liftFunction("function currentMustChangePassword(sessionUser) {"),
	refreshFlag: liftFunction("function refreshPasswordChangeFlag(req, res, next) {"),
	helpers: [
		"function socketsWhere(test) {",
		"function endSockets(sockets) {",
		"function disconnectSessionSockets(sid) {",
		"function disconnectUserSockets(userId, { exceptSid = null } = {}) {",
		"function liveSessionIds(sids) {",
		"function sweepSessionlessSockets() {",
	].map((h) => liftFunction(h)).join("\n"),
	ioHandler: liftHandler('io.on("connection", (socket) => {', 'io.on("connection", '),
	sendEmail: liftFunction("async function sendEmail(to, subject, htmlBody, attachments = [], { replyTo } = {}) {"),
	emailHtml: liftFunction('function invoiceEmailHtml({ heading, bodyHtml, ctaText = "", ctaHref = "" }) {'),
	normalize: liftFunction("function normalizeDriverName(s) {"),
	companyChange: liftFunction("function accountCompanyChange(user, companyName) {"),
};
const AUDIT_SRC = [
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftConst("const AUDITED_UPSTREAM = "),
	liftFunction("function logAudit(req, action, entity, entityId, details) {"),
	liftFunction("function logAuditRefusal(req, action, entity, entityId, details, code) {"),
	liftFunction("function scrubPurgeMarker(s) {"),
	liftFunction("function auditText(v, max) {"),
	liftFunction("function periodRefusalDetail(subject, code, periods, note, tail) {"),
	liftFunction("function recordPeriodRefusal(audit, code, periods, subjectFallback) {"),
].join("\n");
const SESSION_CONFIG_SRC = (() => {
	const a = SRC.indexOf("const sessionMiddleware = session({");
	const b = SRC.indexOf("\napp.use(sessionMiddleware);", a);
	if (a < 0 || b < 0) die("could not locate the sessionMiddleware configuration");
	return SRC.slice(a, b);
})();
const USERS_CREATE = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	return `CREATE TABLE users (${m[1]}\n)`;
})();
const USERS_ALTERS = SRC.match(/ALTER TABLE users ADD COLUMN [^"]*/g) || [];
const DISABLE_COLUMNS = { disabled_at: "TEXT DEFAULT NULL", disabled_by: "INTEGER DEFAULT NULL", disabled_reason: "TEXT DEFAULT NULL" };
const MIGRATED = Object.entries(DISABLE_COLUMNS).every(([col, type]) => USERS_ALTERS.includes(`ALTER TABLE users ADD COLUMN ${col} ${type}`));
ok(MIGRATED, "§9 server.js migrates users.disabled_at, disabled_by and disabled_reason");
const AUDIT_CREATE = (() => {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
})();
const ROOMS = new Function(
	`${["function identityRoomKey(name) {", "function driverRoom(name) {", "function userRoom(username) {"].map((h) => liftFunction(h)).join("\n")}\nreturn { identityRoomKey, driverRoom, userRoom };`)();
const socketHandler = new Function(
	`${["function socketHandler(event, fn) {", "function logSocketHandlerFault(event, err) {"].map((h) => liftFunction(h)).join("\n")}\nreturn socketHandler;`)();

// ── fixtures (made up) ──────────────────────────────────────────────────────
const SECRET = "account-disable-test-secret-not-a-real-one";
const ADMIN = "admin@example.test";
const TZ = "America/New_York";
const STAMP = "2026-10-20T14:00:00.000Z";
const ACCOUNTS = [
	[1, "root_admin", "Super Admin", "", "Root-Admin-1!"],
	[7, "owner_named", "Super Admin", "", "Owner-Named-7!"],
	[8, "arvin_named", "Super Admin", "", "Arvin-Named-8!"],
	[9, "desk_sa", "Super Admin", "", "Desk-Sa-9!"],
	[20, "desk_one", "Dispatcher", "", "Desk-One-20!"],
	[30, "dana_driver", "Driver", "Dana Driver", "Dana-Driver-30!"],
	[40, "acme_invest", "Investor", "", "Acme-Invest-40!"],
];
const PW = Object.fromEntries(ACCOUNTS.map(([, u, , , pw]) => [u, pw]));
const HASH = Object.fromEntries(ACCOUNTS.map(([, u, , , pw]) => [u, bcrypt.hashSync(pw, 4)]));

function makeDb() {
	const db = new Database(":memory:");
	db.exec(USERS_CREATE);
	for (const alter of USERS_ALTERS) { try { db.exec(alter); } catch { /* a column the CREATE already has */ } }
	const cols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
	for (const [col, type] of Object.entries(DISABLE_COLUMNS)) if (!cols.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
	db.exec(AUDIT_CREATE);
	// What DELETE /api/users/:id and GET /api/users read and write besides users.
	db.exec(`
		CREATE TABLE expenses (id INTEGER PRIMARY KEY, driver TEXT DEFAULT '');
		CREATE TABLE messages (id INTEGER PRIMARY KEY, "from" TEXT DEFAULT '', "to" TEXT DEFAULT '');
		CREATE TABLE notifications (id INTEGER PRIMARY KEY, driver_name TEXT DEFAULT '');
		CREATE TABLE driver_locations (id INTEGER PRIMARY KEY, driver TEXT DEFAULT '');
		CREATE TABLE load_responses (id INTEGER PRIMARY KEY, driver_name TEXT DEFAULT '');
		CREATE TABLE trucks (id INTEGER PRIMARY KEY, assigned_driver TEXT DEFAULT '', owner_id INTEGER DEFAULT 0);
		CREATE TABLE truck_assignments (id INTEGER PRIMARY KEY, truck_id INTEGER, driver_name TEXT, end_date TEXT DEFAULT '');
		CREATE TABLE onboarding_documents (id INTEGER PRIMARY KEY, user_id INTEGER);
		CREATE TABLE driver_onboarding (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT DEFAULT '');
		CREATE TABLE driver_payment_info (id INTEGER PRIMARY KEY, user_id INTEGER);
		CREATE TABLE investor_config (id INTEGER PRIMARY KEY, owner_id INTEGER);
		CREATE TABLE investors (id INTEGER PRIMARY KEY, user_id INTEGER);
	`);
	const ins = db.prepare(
		"INSERT INTO users (id, username, password_hash, role, driver_name, email, full_name, company_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
	);
	for (const [id, username, role, driverName] of ACCOUNTS) {
		ins.run(id, username, HASH[username], role, driverName, `${username}@example.test`, driverName, role === "Investor" ? "Acme Leasing" : "");
	}
	return db;
}

function buildSessionMiddleware(db, StoreClass) {
	const realSetInterval = global.setInterval;
	global.setInterval = (...args) => {
		const t = realSetInterval(...args);
		if (t && typeof t.unref === "function") t.unref();
		return t;
	};
	try {
		return new Function("session", "SqliteStore", "db", "SESSION_SECRET", "SESSION_COOKIE_SECURE", "SESSION_COOKIE_SAMESITE", "REPLICA",
			`${SESSION_CONFIG_SRC}\nreturn sessionMiddleware;`)(session, StoreClass, db, SECRET, false, "lax", null);
	} finally {
		global.setInterval = realSetInterval;
	}
}

// Registers a lifted route on the real app, with exactly the names it is given.
function mount(src, env) {
	const names = Object.keys(env);
	new Function(...names, src)(...names.map((k) => env[k]));
}
const passThrough = (req, res, next) => next();

// One complete app: HTTP routes and Socket.IO on one loopback server.
//   flagOn   ACCOUNT_DISABLE_ENABLED as the switch routes see it
//   list     the protected-account list (the shape of a parsed RATECON_PDF_VIEWER_IDS)
//   signOut  false leaves signOutEndedAccount() unmounted, to reach a route's own check
//   replica  the real sendEmail() with REPLICA set, and a mail transport that records
//   holdMail every send stays pending forever
//   signInAudit  SIGN_IN_AUDIT_ENABLED as the sign-in writer sees it
async function startWorld({ flagOn = true, list = null, signOut = true, replica = false, holdMail = false, adminEmail = ADMIN, signInAudit = false } = {}) {
	const db = makeDb();
	const holder = {};
	class TestStore extends SqliteStoreBase {
		constructor(opts) { super(opts); holder.store = this; }
	}
	const sessionMiddleware = buildSessionMiddleware(db, TestStore);
	const flags = new Function("db", `${SRCS.currentFlag}\n${SRCS.refreshFlag}\nreturn { currentMustChangePassword, refreshPasswordChangeFlag };`)(db);
	const signOutMw = SRCS.signOut && signOut ? new Function("db", `${SRCS.signOut}\nreturn signOutEndedAccount;`)(db) : null;

	const app = express();
	app.use(express.json());
	app.use(sessionMiddleware);
	app.use(flags.refreshPasswordChangeFlag);
	if (signOutMw) app.use(signOutMw);
	const server = http.createServer(app);
	const io = new SocketServer(server);
	io.engine.use(sessionMiddleware);
	if (signOutMw) io.engine.use(signOutMw);
	const helpers = new Function("io", "db",
		`${SRCS.helpers}\nreturn { socketsWhere, endSockets, disconnectSessionSockets, disconnectUserSockets, liveSessionIds, sweepSessionlessSockets };`)(io, db);
	io.on("connection", new Function("currentMustChangePassword", "liveSessionIds", "identityRoomKey", "driverRoom", "userRoom", "socketHandler", `return (${SRCS.ioHandler});`)(
		flags.currentMustChangePassword, helpers.liveSessionIds, ROOMS.identityRoomKey, ROOMS.driverRoom, ROOMS.userRoom, socketHandler));

	const refusalAuditWindows = new Map();
	const audit = new Function("db", "refusalAuditWindows",
		`${AUDIT_SRC}\nreturn { logAudit, logAuditRefusal, auditText, recordPeriodRefusal };`)(db, refusalAuditWindows);
	let signIn = null;
	if (signInLib) {
		signInLib.ensureSignInNetworkTable(db);
		signIn = signInLib.createSignIn({
			db, logAudit: audit.logAudit, logAuditRefusal: audit.logAuditRefusal,
			networkEvidence: () => ({ ip: "203.0.113.7", ipSource: "peer", userAgent: "account-disable-test" }),
			auditEnabled: signInAudit, uniqueEmail: false, logger: { error() {}, warn() {}, log() {} },
		});
	}
	const purgeUserSessions = new Function("db", "disconnectUserSockets", `${SRCS.purge}\nreturn purgeUserSessions;`)(db, helpers.disconnectUserSockets);
	const requireAuth = new Function(`${SRCS.requireAuth}\nreturn requireAuth;`)();
	const requireRole = new Function(`${SRCS.requireRole}\nreturn requireRole;`)();
	const stampLastLogin = new Function("db", `${SRCS.stamp}\nreturn stampLastLogin;`)(db);
	const refreshOwnSession = new Function("db", "disconnectSessionSockets", "liveSessionIds", `${SRCS.refresh}\nreturn refreshOwnSession;`)(
		db, helpers.disconnectSessionSockets, helpers.liveSessionIds);
	const invoiceEmailHtml = new Function(`${SRCS.emailHtml}\nreturn invoiceEmailHtml;`)();
	const normalizeDriverName = new Function(`${SRCS.normalize}\nreturn normalizeDriverName;`)();

	// Mail. Without replica mode the send is a recorder (the route's call is the
	// subject here, not the transport); in replica mode it is server.js's own
	// sendEmail(), which must send nothing.
	const mail = { sends: [], transports: 0, off: [] };
	let sendEmail;
	if (replica) {
		const REPLICA = { off: (what) => mail.off.push(what) };
		const nodemailer = { createTransport: () => { mail.transports++; return { sendMail: async () => ({}) }; } };
		const realSend = new Function("REPLICA", "nodemailer", `${SRCS.sendEmail}\nreturn sendEmail;`)(REPLICA, nodemailer);
		sendEmail = (to, subject, html) => { mail.sends.push({ to, subject, html }); return realSend(to, subject, html); };
	} else {
		sendEmail = (to, subject, html) => {
			mail.sends.push({ to, subject, html });
			return holdMail ? new Promise(() => {}) : Promise.resolve(true);
		};
	}

	const hooks = { beforeRotate: null, afterCompare: null, duringJobTracking: null };
	const hookedBcrypt = {
		compare: async (pw, h) => {
			const r = await bcrypt.compare(pw, h);
			if (hooks.afterCompare) { const f = hooks.afterCompare; hooks.afterCompare = null; f(); }
			return r;
		},
		hash: (pw) => bcrypt.hash(pw, 4),
	};
	const loginDisconnect = (sid) => {
		if (hooks.beforeRotate) { const f = hooks.beforeRotate; hooks.beforeRotate = null; f(); }
		return helpers.disconnectSessionSockets(sid);
	};
	const disabledSignInRefusal = SRCS.signInRefusal && SRCS.signInAudit && SRCS.signInNotice && lib
		? new Function("logAuditRefusal", "signIn", "ADMIN_NOTIFY_EMAIL", "disabledSignInNotices", "accountDisable", "APP_TIMEZONE", "sendEmail", "invoiceEmailHtml",
			`${SRCS.signInRefusal}\n${SRCS.signInAudit}\n${SRCS.signInNotice}\nreturn disabledSignInRefusal;`)(
			audit.logAuditRefusal, signIn, adminEmail, lib.noticeWindow(60 * 60 * 1000), lib, TZ, sendEmail, invoiceEmailHtml)
		: () => ({ error: "server.js has no disabledSignInRefusal()" });
	mount(SRCS.login, {
		app, loginLimiter: passThrough, db, bcrypt: hookedBcrypt, stampLastLogin, disconnectSessionSockets: loginDisconnect,
		APP_TIMEZONE: TZ, disabledSignInRefusal, signIn,
	});
	mount(SRCS.logout, { app, disconnectSessionSockets: helpers.disconnectSessionSockets, signIn });
	mount(SRCS.session, { app, APP_TIMEZONE: TZ, MESSAGE_VOICE_NOTES_ENABLED: false });
	mount(SRCS.change, {
		app, requireAuth, changePasswordLimiter: passThrough, db, bcrypt: hookedBcrypt, purgeUserSessions, logAudit: audit.logAudit,
		liveSessionIds: helpers.liveSessionIds, disconnectSessionSockets: helpers.disconnectSessionSockets,
		notifyPasswordChanged: () => Promise.resolve({ recipients: 0, sent: 0 }), passwordRules,
	});
	mount(SRCS.users, { app, requireRole, db, signInLib, NAMED_LOGINS_ENABLED: false });
	const changes = [];
	const notifyChange = (domain) => changes.push(domain);
	// PUT's machinery, stubbed to "nothing blocks". The Job Tracking read is one of
	// the route's awaits: a scenario lands a change in it through hooks.duringJobTracking.
	mount(SRCS.updateUser, {
		app, requireRole, db, getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [["Load ID", "Driver"]] } }) } } }),
		SPREADSHEET_ID: "not-a-sheet", auditText: audit.auditText, recordPeriodRefusal: audit.recordPeriodRefusal,
		userUpdateLockBlockers: () => ({ unreadable: false, blockers: [] }), periodLabel: (p) => p,
		driverRenameMergeScan: () => ({ mergeTargets: {}, mergeRows: 0 }), applyDriverRenameSqlite: () => ({ counts: {} }),
		syncDriverToCarrierSheet: () => {}, purgeUserSessions, logAudit: audit.logAudit, notifyChange, refreshOwnSession,
		normalizeDriverName, findDriverNameClash: () => null, findDriverNameClashes: () => [],
		accountDirectorySync: () => (hooks.duringJobTracking ? { name: "x", carrier: "", row: null } : null),
		accountDirectorySyncLock: () => null,
		getJobTrackingCached: async () => {
			await new Promise((resolve) => setImmediate(resolve));
			if (hooks.duringJobTracking) { const f = hooks.duringJobTracking; hooks.duringJobTracking = null; f(); }
			return { headers: [], data: [] };
		},
		periodBlockedResponse: () => {}, periodLockUnreadableResponse: () => {},
		accountCompanyChange: new Function(`${SRCS.companyChange}\nreturn accountCompanyChange;`)(),
		findDirectoryRowForDriver: () => null, investorCompanyMoves: () => [], investorCompanyLockBlockers: () => null,
		notifyPasswordChanged: () => Promise.resolve({ recipients: 0, sent: 0 }), passwordRules, userPasswordResetLimiter: passThrough,
	});
	mount(SRCS.deleteUser, {
		app, requireRole, db, recordPeriodRefusal: audit.recordPeriodRefusal, auditText: audit.auditText,
		userDeleteLockBlockers: () => ({ unreadable: false, blockers: [] }), periodLabel: (p) => p,
		archiveUserSignedArtifacts: () => ({ archived: [], skipped: [] }), logAudit: audit.logAudit, purgeUserSessions,
		syncDriverToCarrierSheet: () => {}, findTruckForDriverAccount: () => null, normalizeDriverName, chatDeskKey: () => null,
		notifyChange, recordPayRateChanges: () => {}, userVoiceNoteFiles: () => [], removeUserVoiceNotes: () => 0, accountDisable: lib,
	});
	if (SRCS.disable && SRCS.enable && SRCS.facts && SRCS.notify && lib) {
		const accountSwitchFacts = new Function("db", "liveSessionIds", `${SRCS.facts}\nreturn accountSwitchFacts;`)(db, helpers.liveSessionIds);
		const notifyAccountSwitch = new Function("ADMIN_NOTIFY_EMAIL", "accountDisable", "APP_TIMEZONE", "sendEmail", "invoiceEmailHtml",
			`${SRCS.notify}\nreturn notifyAccountSwitch;`)(adminEmail, lib, TZ, sendEmail, invoiceEmailHtml);
		const env = {
			app, requireRole, refuseCrossOrigin: passThrough, db, accountDisable: lib, ACCOUNT_DISABLE_ENABLED: flagOn,
			ACCOUNT_DISABLE_LIST: list || lib.UNSET_LIST, accountSwitchFacts, recordPeriodRefusal: audit.recordPeriodRefusal,
			purgeUserSessions, logAudit: audit.logAudit, auditText: audit.auditText, notifyAccountSwitch, notifyChange,
		};
		mount(SRCS.disable, env);
		mount(SRCS.enable, env);
	}
	// A guarded route to ask "does this cookie still sign anyone in?".
	app.get("/api/__probe", requireAuth, (req, res) => res.json({ id: req.session.user.id }));
	app.delete("/api/__probe", requireRole("Super Admin"), (req, res) => res.json({ id: req.session.user.id }));

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const clients = [];
	return {
		db, io, helpers, mail, hooks, changes, refusalAuditWindows, clients,
		store: holder.store,
		port: server.address().port,
		close: async () => {
			for (const c of clients) { try { c.disconnect(); } catch { /* closed */ } }
			const closed = new Promise((resolve) => io.close(() => resolve()));
			if (server.closeAllConnections) server.closeAllConnections();
			await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1000))]);
			db.close();
		},
	};
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function request(port, method, urlPath, { cookie, body, xrw = true } = {}) {
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
const login = (w, username, cookie) => request(w.port, "POST", "/api/auth/login", { cookie, body: { username, password: PW[username] } });
const loginAs = (w, typed, password, cookie) => request(w.port, "POST", "/api/auth/login", { cookie, body: { username: typed, password } });
const disableUser = (w, cookie, id, body = {}) => request(w.port, "POST", `/api/users/${id}/disable`, { cookie, body });
const enableUser = (w, cookie, id) => request(w.port, "POST", `/api/users/${id}/enable`, { cookie, body: {} });
const editUser = (w, cookie, id, body) => request(w.port, "PUT", `/api/users/${id}`, { cookie, body });
const probe = (w, cookie) => request(w.port, "GET", "/api/__probe", { cookie });
async function signedIn(w, cookie) {
	const r = await request(w.port, "GET", "/api/auth/session", { cookie });
	return !!r.json && r.json.authenticated === true;
}
function sidOf(cookie) {
	if (!cookie) return null;
	const v = decodeURIComponent(cookie.slice("connect.sid=".length));
	return v.startsWith("s:") ? v.slice(2, v.lastIndexOf(".")) : v;
}
const signSid = (sid) => `${sid}.${crypto.createHmac("sha256", SECRET).update(sid).digest("base64").replace(/=+$/, "")}`;
const cookieFor = (sid) => `connect.sid=${encodeURIComponent("s:" + signSid(sid))}`;
const storeSet = (store, sid, sess) => new Promise((resolve, reject) => store.set(sid, sess, (err) => (err ? reject(err) : resolve())));
const cookieShape = () => ({ originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: "/" });
const userRow = (db, id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const auditsOf = (db, action) => db.prepare("SELECT * FROM audit_trail WHERE action = ? ORDER BY id").all(action);
const sessionsOf = (db, id) => db.prepare("SELECT sid FROM sessions WHERE json_extract(sess, '$.user.id') = ?").all(id).map((r) => r.sid);
const disableDirect = (db, id, by = 1) => db.prepare("UPDATE users SET disabled_at = ?, disabled_by = ? WHERE id = ?").run(STAMP, by, id);
const fingerprint = (db) => JSON.stringify(db.prepare("SELECT id, role, full_name, password_hash, disabled_at, disabled_by, disabled_reason FROM users ORDER BY id").all());
const networkRows = (db) => { try { return db.prepare("SELECT * FROM sign_in_network ORDER BY id").all(); } catch { return []; } };
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
async function connectTab(w, cookie) {
	const s = ioClient.io(`http://127.0.0.1:${w.port}`, {
		transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: cookie ? { cookie } : {},
	});
	w.clients.push(s);
	const tab = { s, id: null, reasons: [] };
	s.on("disconnect", (reason) => tab.reasons.push(reason));
	if (!(await waitFor(s, "connect"))) throw new Error("a socket never connected");
	tab.id = s.id;
	return tab;
}
const isOpen = (w, tab) => !!w.io.of("/").sockets.get(tab.id);
const inRoom = (w, room, id) => { const r = w.io.of("/").adapter.rooms.get(room); return !!(r && r.has(id)); };
const roomsOf = (w, tab) => { const s = w.io.of("/").sockets.get(tab.id); return s ? [...s.rooms].filter((r) => r !== tab.id) : []; };
async function closedByServer(w, tab) {
	if (isOpen(w, tab)) await waitUntil(() => !isOpen(w, tab), 500);
	if (isOpen(w, tab)) return false;
	if (!tab.reasons.length) await waitFor(tab.s, "disconnect", 500);
	return tab.reasons[0] === "io server disconnect";
}
async function refusedTab(w, cookie) {
	const tab = await connectTab(w, cookie);
	return closedByServer(w, tab);
}
async function joins(w, tab, name, room) {
	if (!isOpen(w, tab)) return false;
	tab.s.emit("register", name);
	return waitUntil(() => inRoom(w, room, tab.id), 500);
}
// After a register the server would have answered within this window.
async function registerJoinsNothing(w, tab, name) {
	if (!isOpen(w, tab)) return false;
	tab.s.emit("register", name);
	await new Promise((r) => setTimeout(r, 150));
	return roomsOf(w, tab).length === 0;
}

// ── the cases ───────────────────────────────────────────────────────────────
const LIST = (state, ids = []) => ({ state, ids, isListedId: (id) => state === "valid" && ids.includes(Number(id)) });
const code = (r) => `${r.status} ${(r.json && r.json.code) || ""}`.trim();

const SECTIONS = {
	async signIn() {
		const w = await startWorld();
		try {
			disableDirect(w.db, 20);
			const before = w.db.prepare("SELECT last_login_at FROM users WHERE id = 20").get().last_login_at;
			const other = await login(w, "dana_driver");
			const r = await loginAs(w, "desk_one@example.test", PW.desk_one, other.cookie);
			ok(r.status === 403 && r.json && r.json.code === "ACCOUNT_DISABLED" && r.json.error === "This account is disabled. Contact your administrator.",
				`§1 the right password on a disabled account: 403 ACCOUNT_DISABLED with its message (got ${code(r)})`);
			ok(!r.cookie && sessionsOf(w.db, 20).length === 0, "§1 ...no signed-in cookie and no session for it");
			ok(w.db.prepare("SELECT last_login_at FROM users WHERE id = 20").get().last_login_at === before, "§1 ...and last_login_at is not stamped");
			ok(await signedIn(w, other.cookie), "§1 ...and the session the request arrived with is left as it was");
			const rows = auditsOf(w.db, "login_refused_disabled");
			ok(rows.length === 1 && rows[0].user_id === 20 && rows[0].username === "desk_one" && rows[0].entity_id === "20" && /\[ACCOUNT_DISABLED\]/.test(rows[0].details),
				`§1 one login_refused_disabled row naming the account's id and username (got ${JSON.stringify(rows)})`);
			ok(rows.length === 1 && !/example\.test/.test(JSON.stringify(rows[0])), "§1 ...never the identifier that was typed (an email here)");
			ok(rows.length === 1 && networkRows(w.db).length === 0, "§1 ...written with SIGN_IN_AUDIT_ENABLED off too, and with it off no IP or browser is kept");
			ok(w.mail.sends.length === 1 && w.mail.sends[0].to === ADMIN && /disabled/i.test(w.mail.sends[0].subject),
				`§1 one email to ADMIN_NOTIFY_EMAIL (got ${w.mail.sends.length})`);
			const again = await loginAs(w, "desk_one", PW.desk_one);
			ok(again.status === 403 && auditsOf(w.db, "login_refused_disabled").length === 1, "§1 a second refusal within the minute adds no row");
			ok(w.mail.sends.length === 1, "§1 ...and no second email within the hour");
			disableDirect(w.db, 9);
			await loginAs(w, "desk_sa", PW.desk_sa);
			ok(w.mail.sends.length === 2 && auditsOf(w.db, "login_refused_disabled").length === 2, "§1 ...while another disabled account gets its own row and email");
			const wrong = await loginAs(w, "desk_one", "Not-The-Password-1!");
			ok(wrong.status === 401 && wrong.json && wrong.json.error === "Invalid credentials" && !wrong.json.code,
				`§1 a wrong password on a disabled account keeps the usual 401 (got ${code(wrong)})`);
			const unknown = await loginAs(w, "nobody_here", "Whatever-1!");
			ok(unknown.status === 401 && unknown.json && unknown.json.error === "Invalid credentials", "§1 ...as does an unknown account");
			w.hooks.beforeRotate = () => disableDirect(w.db, 7);
			const mid = await login(w, "owner_named");
			ok(mid.status === 403 && mid.json && mid.json.code === "ACCOUNT_DISABLED" && !mid.cookie && sessionsOf(w.db, 7).length === 0 &&
				!userRow(w.db, 7).last_login_at, `§1 a disable landing while the sign-in rotates its session still refuses, with no session left (got ${code(mid)})`);
			const fine = await login(w, "root_admin");
			ok(fine.status === 200 && !!fine.cookie, "§1 an enabled account signs in as before");
		} finally { await w.close(); }
	},

	async signInWriter() {
		const w = await startWorld({ signInAudit: true });
		try {
			disableDirect(w.db, 20);
			const r = await loginAs(w, "desk_one", PW.desk_one);
			const rows = auditsOf(w.db, "login_refused_disabled");
			ok(r.status === 403 && rows.length === 1 && rows[0].user_id === 20 && rows[0].username === "desk_one" &&
				rows[0].details === "Sign-in refused: the account is disabled [ACCOUNT_DISABLED]",
				`§1 with SIGN_IN_AUDIT_ENABLED on, the same row goes through the sign-in writer (got ${code(r)} ${JSON.stringify(rows)})`);
			const net = rows.length ? networkRows(w.db).filter((n) => n.audit_id === rows[0].id) : [];
			ok(net.length === 1 && net[0].user_id === 20 && net[0].ip === "203.0.113.7", "§1 ...which keeps the staff account's IP and browser beside it");
			ok(auditsOf(w.db, "login_refused").length === 0, "§1 ...and no login_refused row besides it");
		} finally { await w.close(); }
	},

	async disableEndsSessions() {
		const w = await startWorld();
		try {
			const root = await login(w, "root_admin");
			const a = await login(w, "desk_one");
			const b = await login(w, "desk_one");
			const ta = await connectTab(w, a.cookie);
			const tb = await connectTab(w, b.cookie);
			const joined = (await joins(w, ta, "dispatch", "dispatch")) && (await joins(w, tb, "dispatch", "dispatch"));
			const r = await disableUser(w, root.cookie, 20, { reason: "Left the desk" });
			ok(r.status === 200 && r.json && r.json.success === true && r.json.sessionsEnded === 2,
				`§2 disable answers 200 with the sessions it ended (got ${code(r)} ${JSON.stringify(r.json)})`);
			ok(joined && (await closedByServer(w, ta)) && (await closedByServer(w, tb)), "§2 both of the account's sockets are closed by the server");
			ok((await probe(w, a.cookie)).status === 401 && (await probe(w, b.cookie)).status === 401, "§2 both cookies get 401 on a guarded route");
			ok(!(await signedIn(w, a.cookie)) && !(await signedIn(w, b.cookie)), "§2 ...and GET /api/auth/session says signed out");
			ok(sessionsOf(w.db, 20).length === 0, "§2 the account's session rows are gone");
			const u = userRow(w.db, 20);
			ok(ISO_Z.test(String(u.disabled_at)) && u.disabled_by === 1 && u.disabled_reason === "Left the desk",
				`§2 the account row records when, by whom and why (got ${JSON.stringify([u.disabled_at, u.disabled_by, u.disabled_reason])})`);
			const rows = auditsOf(w.db, "disable_user");
			ok(rows.length === 1 && rows[0].user_id === 1 && rows[0].entity_id === "20" && /sessions ended: 2/.test(rows[0].details) && /Left the desk/.test(rows[0].details),
				`§2 disable_user is audited with the actor, the target, the reason and the count (got ${JSON.stringify(rows)})`);
			ok(await signedIn(w, root.cookie), "§2 the acting session is untouched");
			ok(w.changes.includes("users"), "§2 the Users page is told to refresh");
		} finally { await w.close(); }
	},

	async backstop() {
		const w = await startWorld();
		try {
			const a = await login(w, "desk_one");
			const joinedTab = await connectTab(w, a.cookie);
			const quietTab = await connectTab(w, a.cookie);
			const joined = await joins(w, joinedTab, "dispatch", "dispatch");
			disableDirect(w.db, 20);
			ok(joined && (await registerJoinsNothing(w, quietTab, "dispatch")), "§3 disabled with no purge: register on a live socket joins no room");
			ok(await refusedTab(w, a.cookie), "§3 ...a new socket on the old cookie is refused");
			const closed = w.helpers.sweepSessionlessSockets();
			ok(closed >= 2 && (await closedByServer(w, joinedTab)) && (await closedByServer(w, quietTab)), `§3 ...one sweep closes the live sockets (closed ${closed})`);
			ok((await probe(w, a.cookie)).status === 401, "§3 ...and the old cookie gets 401 on its next request");
			ok(!(await signedIn(w, a.cookie)), "§3 ...and is signed out");
		} finally { await w.close(); }
	},

	async refusals() {
		{
			const w = await startWorld();
			try {
				const root = await login(w, "root_admin");
				const before = fingerprint(w.db);
				const self = await disableUser(w, root.cookie, 1);
				ok(code(self) === "409 CANNOT_DISABLE_SELF", `§4 disabling yourself: 409 CANNOT_DISABLE_SELF (got ${code(self)})`);
				for (const [id, role] of [[30, "Driver"], [40, "Investor"]]) {
					const r = await disableUser(w, root.cookie, id);
					ok(code(r) === "409 ROLE_NOT_DISABLEABLE", `§4 a ${role}: 409 ROLE_NOT_DISABLEABLE (got ${code(r)})`);
				}
				const sa = await disableUser(w, root.cookie, 7);
				ok(code(sa) === "403 PROTECTED_ACCOUNT", `§4 any Super Admin while the protected-account list is unset: 403 PROTECTED_ACCOUNT (got ${code(sa)})`);
				ok(fingerprint(w.db) === before, "§4 ...each refusal writes nothing");
				const blocked = auditsOf(w.db, "disable_user_blocked").map((r) => (r.details.match(/\[([A-Z_]+)\]/) || [])[1]);
				ok(JSON.stringify(blocked.sort()) === JSON.stringify(["CANNOT_DISABLE_SELF", "PROTECTED_ACCOUNT", "ROLE_NOT_DISABLEABLE"]),
					`§4 ...and is audited as disable_user_blocked, one row a minute per code (got ${JSON.stringify(blocked)})`);
				ok(auditsOf(w.db, "disable_user_blocked").every((r) => r.user_id === 1 && r.details.includes("WITHHELD")), "§4 ...naming the actor");
				const desk = await disableUser(w, root.cookie, 20);
				ok(desk.status === 200 && !!userRow(w.db, 20).disabled_at, `§4 a Dispatcher is disabled with the list unset (got ${code(desk)})`);
				const missing = await disableUser(w, root.cookie, 999);
				ok(missing.status === 404, `§4 an unknown account: 404 (got ${missing.status})`);
			} finally { await w.close(); }
		}
		{
			const w = await startWorld({ list: LIST("valid", [1, 7]) });
			try {
				const deskSa = await login(w, "desk_sa");
				const owner = await login(w, "owner_named");
				const before = fingerprint(w.db);
				const r1 = await disableUser(w, deskSa.cookie, 1);
				ok(code(r1) === "403 PROTECTED_ACCOUNT" && fingerprint(w.db) === before,
					`§4 the list set to 1,7: an unlisted Super Admin disabling #1 gets 403 PROTECTED_ACCOUNT, nothing written (got ${code(r1)})`);
				ok(auditsOf(w.db, "disable_user_blocked").some((r) => r.user_id === 9 && /\[PROTECTED_ACCOUNT\]/.test(r.details)), "§4 ...audited");
				const r2 = await disableUser(w, owner.cookie, 1);
				ok(r2.status === 200 && !!userRow(w.db, 1).disabled_at, `§4 ...#7, listed, disables #1 (got ${code(r2)})`);
				const e1 = await enableUser(w, deskSa.cookie, 1);
				ok(code(e1) === "403 PROTECTED_ACCOUNT" && !!userRow(w.db, 1).disabled_at, `§4 enabling #1 follows the same rule (got ${code(e1)})`);
				ok(auditsOf(w.db, "enable_user_blocked").some((r) => r.user_id === 9 && /\[PROTECTED_ACCOUNT\]/.test(r.details)), "§4 ...audited as enable_user_blocked");
				const e2 = await enableUser(w, owner.cookie, 1);
				ok(e2.status === 200 && !userRow(w.db, 1).disabled_at, `§4 ...and #7 enables it (got ${code(e2)})`);
			} finally { await w.close(); }
		}
		{
			const w = await startWorld({ list: LIST("invalid") });
			try {
				const root = await login(w, "root_admin");
				ok(code(await disableUser(w, root.cookie, 7)) === "403 PROTECTED_ACCOUNT", "§4 a list set but invalid refuses disabling any Super Admin");
				disableDirect(w.db, 9);
				ok(code(await enableUser(w, root.cookie, 9)) === "403 PROTECTED_ACCOUNT", "§4 ...and enabling one");
				ok((await disableUser(w, root.cookie, 20)).status === 200, "§4 ...but not a Dispatcher");
			} finally { await w.close(); }
		}
	},

	async lastSuperAdmin() {
		{
			const w = await startWorld();
			try {
				w.db.prepare("DELETE FROM users WHERE id IN (8, 9)").run();
				disableDirect(w.db, 7);
				const root = await login(w, "root_admin");
				const before = fingerprint(w.db);
				const r = await editUser(w, root.cookie, 1, { role: "Dispatcher" });
				ok(code(r) === "409 LAST_SUPER_ADMIN" && fingerprint(w.db) === before,
					`§5 #1 enabled and #7 disabled: #1 demoting itself gets 409 LAST_SUPER_ADMIN, nothing written (got ${code(r)})`);
			} finally { await w.close(); }
		}
		for (const signOut of [true, false]) {
			const w = await startWorld({ signOut });
			try {
				w.db.prepare("DELETE FROM users WHERE id = 9").run();
				disableDirect(w.db, 7);
				const stale = await login(w, "arvin_named");
				w.db.prepare("UPDATE users SET role = 'Dispatcher' WHERE id = 8").run(); // the purge skipped
				const r = await request(w.port, "DELETE", "/api/users/1", { cookie: stale.cookie });
				const want = signOut ? "401" : "409 LAST_SUPER_ADMIN";
				ok(code(r) === want && !!userRow(w.db, 1),
					`§5 DELETE /api/users/1 by a session still cached as Super Admin after its row was demoted: ${want}${signOut ? " (signed out first)" : " (the count)"}, nothing deleted (got ${code(r)})`);
			} finally { await w.close(); }
		}
		{
			const w = await startWorld();
			try {
				disableDirect(w.db, 7);
				const root = await login(w, "root_admin");
				const r = await request(w.port, "DELETE", "/api/users/7", { cookie: root.cookie });
				ok(r.status === 200 && !userRow(w.db, 7), `§5 deleting a disabled Super Admin passes the guard (got ${code(r)})`);
			} finally { await w.close(); }
		}
	},

	async enable() {
		const w = await startWorld();
		try {
			const root = await login(w, "root_admin");
			await disableUser(w, root.cookie, 20, { reason: "Short leave" });
			const n0 = auditsOf(w.db, "disable_user").length;
			const again = await disableUser(w, root.cookie, 20, { reason: "Another reason" });
			ok(again.status === 200 && again.json && again.json.unchanged === true && auditsOf(w.db, "disable_user").length === n0 &&
				userRow(w.db, 20).disabled_reason === "Short leave", `§6 disabling a disabled account: 200 unchanged, nothing written or audited (got ${JSON.stringify(again.json)})`);
			const sends = w.mail.sends.length;
			const r = await enableUser(w, root.cookie, 20);
			const u = userRow(w.db, 20);
			ok(r.status === 200 && r.json && r.json.success === true && u.disabled_at === null && u.disabled_by === null && u.disabled_reason === null,
				`§6 enable answers 200 and clears the three columns (got ${code(r)} ${JSON.stringify([u.disabled_at, u.disabled_by, u.disabled_reason])})`);
			const rows = auditsOf(w.db, "enable_user");
			ok(rows.length === 1 && rows[0].user_id === 1 && rows[0].entity_id === "20", "§6 enable_user is audited");
			ok(w.mail.sends.length === sends + 1 && /enabled/i.test(w.mail.sends[w.mail.sends.length - 1].subject), "§6 ...and the admin is emailed");
			ok((await login(w, "desk_one")).status === 200, "§6 the account signs in again");
			const twice = await enableUser(w, root.cookie, 20);
			ok(twice.status === 200 && twice.json && twice.json.unchanged === true && auditsOf(w.db, "enable_user").length === 1 && w.mail.sends.length === sends + 1,
				"§6 enabling an enabled account: 200 unchanged, nothing audited or sent");
		} finally { await w.close(); }
	},

	async changePassword() {
		const w = await startWorld();
		try {
			const a = await login(w, "desk_one");
			disableDirect(w.db, 20);
			const before = userRow(w.db, 20).password_hash;
			const r = await request(w.port, "POST", "/api/auth/change-password", { cookie: a.cookie, body: { currentPassword: PW.desk_one, newPassword: "Brand-New-Pass-77!" } });
			ok(r.status === 401 && userRow(w.db, 20).password_hash === before, `§7 change-password with a disabled account's cookie: 401, nothing written (got ${code(r)})`);
		} finally { await w.close(); }
		const w2 = await startWorld();
		try {
			const a = await login(w2, "desk_one");
			const before = userRow(w2.db, 20).password_hash;
			w2.hooks.afterCompare = () => disableDirect(w2.db, 20);
			const r = await request(w2.port, "POST", "/api/auth/change-password", { cookie: a.cookie, body: { currentPassword: PW.desk_one, newPassword: "Brand-New-Pass-77!" } });
			ok(r.status === 401 && r.json && r.json.code === "SESSION_ENDED" && userRow(w2.db, 20).password_hash === before && !r.cookie,
				`§7 a disable landing in change-password's bcrypt window: 401 SESSION_ENDED, nothing written, no new session (got ${code(r)})`);
			ok(auditsOf(w2.db, "change_password").length === 0, "§7 ...and no change_password row");
		} finally { await w2.close(); }
	},

	async putOnDisabled() {
		const w = await startWorld();
		try {
			const root = await login(w, "root_admin");
			disableDirect(w.db, 20);
			const r = await editUser(w, root.cookie, 20, { role: "Super Admin" });
			ok(code(r) === "409 ACCOUNT_DISABLED" && userRow(w.db, 20).role === "Dispatcher", `§8 a role change on a disabled account: 409 ACCOUNT_DISABLED (got ${code(r)})`);
			ok(auditsOf(w.db, "update_user_blocked").some((x) => /\[ACCOUNT_DISABLED\]/.test(x.details)), "§8 ...audited as update_user_blocked");
			const name = await editUser(w, root.cookie, 20, { fullName: "Desk One Renamed" });
			ok(name.status === 200 && userRow(w.db, 20).full_name === "Desk One Renamed" && userRow(w.db, 20).disabled_at === STAMP,
				`§8 a full-name edit goes through and leaves the account disabled (got ${code(name)})`);
			const reset = await editUser(w, root.cookie, 20, { password: "Admin-Reset-Pass-5!" });
			ok(reset.status === 200 && userRow(w.db, 20).disabled_at === STAMP, `§8 a password reset goes through and does not enable it (got ${code(reset)})`);
			ok((await loginAs(w, "desk_one", "Admin-Reset-Pass-5!")).status === 403, "§8 ...the new password still meets the disabled sign-in");
		} finally { await w.close(); }
	},

	async usersList() {
		const w = await startWorld();
		try {
			const root = await login(w, "root_admin");
			await disableUser(w, root.cookie, 20, { reason: "Left the desk" });
			const r = await request(w.port, "GET", "/api/users", { cookie: root.cookie });
			const list = (r.json && r.json.users) || [];
			const desk = list.find((u) => u.id === 20) || {};
			const dana = list.find((u) => u.id === 30) || {};
			ok(desk.Disabled === true && ISO_Z.test(String(desk.DisabledAt)) && JSON.stringify(desk.DisabledBy) === JSON.stringify({ id: 1, username: "root_admin" }) &&
				desk.DisabledReason === "Left the desk", `§9 GET /api/users: a disabled account carries Disabled, DisabledAt, DisabledBy and DisabledReason (got ${JSON.stringify(desk)})`);
			ok(dana.Disabled === false && dana.DisabledAt === null && dana.DisabledBy === null && dana.DisabledReason === null,
				`§9 ...an enabled one carries them empty (got ${JSON.stringify(dana)})`);
			w.db.prepare("DELETE FROM users WHERE id = 1").run();
			w.db.prepare("UPDATE users SET disabled_by = 1 WHERE id = 20").run();
			const root7 = await login(w, "owner_named");
			const r2 = await request(w.port, "GET", "/api/users", { cookie: root7.cookie });
			const desk2 = ((r2.json && r2.json.users) || []).find((u) => u.id === 20) || {};
			ok(JSON.stringify(desk2.DisabledBy) === JSON.stringify({ id: 1, username: null }), `§9 ...and the id alone once the disabling account is gone (got ${JSON.stringify(desk2.DisabledBy)})`);
		} finally { await w.close(); }
	},

	async notice() {
		{
			const w = await startWorld({ holdMail: true });
			try {
				const root = await login(w, "root_admin");
				const r = await disableUser(w, root.cookie, 20, { reason: "Left the desk" });
				ok(r.status === 200 && w.mail.sends.length === 1 && w.mail.sends[0].to === ADMIN && /disabled/i.test(w.mail.sends[0].subject),
					`§10 one email to ADMIN_NOTIFY_EMAIL per disable, and the answer does not wait for it (got ${code(r)}, ${w.mail.sends.length} sends)`);
				ok(!w.mail.sends.some((m) => /desk_one@example\.test/.test(m.to)), "§10 ...never to the disabled account");
				await disableUser(w, root.cookie, 30);
				await disableUser(w, root.cookie, 20);
				ok(w.mail.sends.length === 1, "§10 a refusal or an unchanged answer sends nothing");
				const e = await enableUser(w, root.cookie, 20);
				ok(e.status === 200 && w.mail.sends.length === 2 && /enabled/i.test(w.mail.sends[1].subject), "§10 one email per enable too");
			} finally { await w.close(); }
		}
		{
			const w = await startWorld({ replica: true });
			try {
				const root = await login(w, "root_admin");
				const r = await disableUser(w, root.cookie, 20);
				ok(r.status === 200 && w.mail.transports === 0 && w.mail.off.includes("email (SMTP)"),
					`§10 in replica mode nothing is sent (got ${code(r)}, ${w.mail.transports} transports)`);
			} finally { await w.close(); }
		}
		{
			const w = await startWorld({ adminEmail: "" });
			try {
				const root = await login(w, "root_admin");
				const r = await disableUser(w, root.cookie, 20);
				ok(r.status === 200 && w.mail.sends.length === 0, "§10 with ADMIN_NOTIFY_EMAIL unset nothing is sent, and the disable still happens");
			} finally { await w.close(); }
		}
	},

	async flagOff() {
		const w = await startWorld({ flagOn: false });
		try {
			const root = await login(w, "root_admin");
			const before = fingerprint(w.db);
			const r = await disableUser(w, root.cookie, 20);
			ok(code(r) === "403 ACCOUNT_DISABLE_OFF" && fingerprint(w.db) === before, `§11 the switch off: disable answers 403 ACCOUNT_DISABLE_OFF, nothing written (got ${code(r)})`);
			disableDirect(w.db, 9);
			const desk = await login(w, "desk_one");
			disableDirect(w.db, 20);
			ok((await loginAs(w, "desk_sa", PW.desk_sa)).status === 403, "§11 ...an account disabled earlier is still refused at sign-in");
			ok((await probe(w, desk.cookie)).status === 401, "§11 ...and its live session is still signed out");
			const e = await enableUser(w, root.cookie, 9);
			ok(e.status === 200 && !userRow(w.db, 9).disabled_at && auditsOf(w.db, "enable_user").length === 1,
				`§11 ...enable still works, and is audited (got ${code(e)})`);
			ok((await login(w, "desk_sa")).status === 200, "§11 ...and the account signs in again");
		} finally { await w.close(); }
	},

	async staleSessions() {
		const w = await startWorld();
		try {
			const cases = [
				["whose account row is gone", { id: 99, username: "ghost_user", role: "Dispatcher" }],
				["with no user id", { username: "desk_one", role: "Dispatcher" }],
				["whose user id is 0", { id: 0, username: "desk_one", role: "Dispatcher" }],
				["whose user id is \"abc\"", { id: "abc", username: "desk_one", role: "Dispatcher" }],
				["whose cached role differs from the database's", { id: 20, username: "desk_one", role: "Super Admin" }],
			];
			for (const [label, user] of cases) {
				const sid = `stale-${crypto.randomBytes(6).toString("hex")}`;
				await storeSet(w.store, sid, { cookie: cookieShape(), user });
				ok(await refusedTab(w, cookieFor(sid)), `§12 a session ${label}: its socket is refused`);
				const sid2 = `stale-${crypto.randomBytes(6).toString("hex")}`;
				await storeSet(w.store, sid2, { cookie: cookieShape(), user });
				const r = await probe(w, cookieFor(sid2));
				ok(r.status === 401, `§12 a session ${label}: 401 on its next request (got ${r.status})`);
			}
			const sid = `fine-${crypto.randomBytes(6).toString("hex")}`;
			await storeSet(w.store, sid, { cookie: cookieShape(), user: { id: 20, username: "desk_one", role: "Dispatcher" } });
			const tab = await connectTab(w, cookieFor(sid));
			ok(isOpen(w, tab) && (await joins(w, tab, "dispatch", "dispatch")) && (await probe(w, cookieFor(sid))).status === 200,
				"§12 a session matching its enabled account keeps its socket and its requests");
		} finally { await w.close(); }
	},

	async putMidRequest() {
		for (const [label, during, want] of [
			["the account is disabled", (db) => disableDirect(db, 20), "409 ACCOUNT_DISABLED"],
			["the acting account is disabled", (db) => disableDirect(db, 1, 7), "401 SESSION_ENDED"],
			["the acting account is demoted", (db) => db.prepare("UPDATE users SET role = 'Dispatcher' WHERE id = 1").run(), "401 SESSION_ENDED"],
		]) {
			const w = await startWorld();
			try {
				const root = await login(w, "root_admin");
				let snapshot = null;
				w.hooks.duringJobTracking = () => { during(w.db); snapshot = fingerprint(w.db); };
				const r = await editUser(w, root.cookie, 20, { role: "Super Admin", fullName: "Desk Promoted" });
				ok(code(r) === want && snapshot !== null && fingerprint(w.db) === snapshot,
					`§13 PUT /api/users/20 while ${label} in its await: ${want}, nothing written (got ${code(r)})`);
			} finally { await w.close(); }
		}
	},

	async escaping() {
		const w = await startWorld();
		try {
			const root = await login(w, "root_admin");
			const reason = "<b>Left</b> & \"moved\"\non";
			const r = await disableUser(w, root.cookie, 20, { reason });
			const html = (w.mail.sends[0] || {}).html || "";
			ok(r.status === 200 && html.includes("&lt;b&gt;Left&lt;/b&gt; &amp; &quot;moved&quot; on") && !html.includes("<b>Left</b>"),
				"§14 a reason holding HTML is escaped in the email");
			const row = auditsOf(w.db, "disable_user")[0] || {};
			ok(/reason: <b>Left<\/b> & "moved" on;/.test(row.details || "") && !/\n/.test(row.details || ""),
				`§14 ...and is one line in the audit row (got ${JSON.stringify(row.details)})`);
			ok(userRow(w.db, 20).disabled_reason === "<b>Left</b> & \"moved\" on", "§14 ...stored as text, line breaks collapsed");
			const long = await disableUser(w, root.cookie, 9, { reason: "x".repeat(201) });
			ok(code(long) === "400 REASON_TOO_LONG" && !userRow(w.db, 9).disabled_at, `§14 a reason over 200 characters: 400, nothing written (got ${code(long)})`);
		} finally { await w.close(); }
	},

	async orderAndFailure() {
		{
			const w = await startWorld({ list: LIST("valid", [1, 7]) });
			try {
				disableDirect(w.db, 1, 7);
				const deskSa = await login(w, "desk_sa");
				const r = await disableUser(w, deskSa.cookie, 1);
				ok(code(r) === "403 PROTECTED_ACCOUNT", `§15 an actor refused under the protected-account rule gets that refusal, not "unchanged" (got ${code(r)} ${JSON.stringify(r.json)})`);
			} finally { await w.close(); }
		}
		{
			const w = await startWorld();
			try {
				const a = await login(w, "desk_one");
				const live = await connectTab(w, a.cookie);
				const joined = await joins(w, live, "dispatch", "dispatch");
				w.db.exec("ALTER TABLE users RENAME TO users_away");
				ok(await refusedTab(w, a.cookie), "§15 with the users table unreadable, the connection gate refuses a new socket (fails closed)");
				const closed = w.helpers.sweepSessionlessSockets();
				ok(joined && closed === 0 && isOpen(w, live), `§15 ...while the minute sweep keeps live sockets open (fails open; closed ${closed})`);
				w.db.exec("ALTER TABLE users_away RENAME TO users");
			} finally { await w.close(); }
		}
	},
};

(async () => {
	for (const [name, run] of Object.entries(SECTIONS)) {
		try {
			await run();
		} catch (e) {
			failures.push(`${name}: threw ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
		}
	}
	restoreConsole();
	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  ✗ ${f}`);
		if (logs.length) console.log(`\nlogged during the run (last 8):\n  ${logs.slice(-8).join("\n  ")}`);
		process.exit(1);
	}
	process.exit(0);
})();
