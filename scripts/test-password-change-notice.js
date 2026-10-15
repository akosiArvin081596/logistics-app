#!/usr/bin/env node
/**
 * B21: every password change emails the account it changed.
 *
 *   "Your LogisX password was changed on <date and time, APP_TIMEZONE> by <an
 *    administrator | you>. If this wasn't you, contact <ADMIN_NOTIFY_EMAIL, else
 *    your administrator>."
 *
 * WHAT IS ASSERTED
 *   §1 lib/password-change-notice.js: the sentence, the time in the zone it is
 *      given (EDT and EST for US Eastern, another zone's own label), the
 *      contact, HTML escaping, which addresses it will try (one "@", no
 *      whitespace or line breaks, each once), and that a false or throwing
 *      sender, or no address, is logged and never rejects
 *   §2 POST /api/auth/change-password: one notice to the account's own address
 *      saying "by you", no password in it, the same answer whether or not the
 *      account has an address, the account's other sessions signed out and
 *      this one kept (on its rotated cookie)
 *   §3 PUT /api/users/:id: a password reset by another Super Admin sends "by an
 *      administrator", no password in it, and signs the account out of every
 *      session (the update_user audit line keeps "password reset" and reports
 *      "sessions revoked: N"); a Super Admin resetting their own password is
 *      told "you" and keeps the session they made it from; an edit with no
 *      password sends nothing; a reset that also changes the address goes to
 *      the address on file before the edit and to the new one
 *   §4 delivery never decides the change: a sender answering false, a sender
 *      that throws and an account with no address all leave the new password
 *      saved, answer 200 and log by account id
 *   §5 server.js's real sendEmail() behind the notice: a replica sends nothing
 *      (no transport is created), nor does a mailbox missing GMAIL_USER or
 *      GMAIL_APP_PASSWORD; with both set, the branded email reaches the
 *      account with no password in it
 *   §6 SOURCE pins (comment-stripped): each route calls the notice once, after
 *      its write, without awaiting it, and hands it no password; both check a
 *      new password through lib/password-rules.js; the reset compares with the
 *      acting admin's hash beside its hashing, above the guards
 *   §7 lib/password-rules.js: change-password's rule, word for word (at least
 *      8 characters of text, at most 200, upper, lower, number, symbol)
 *   §8 PUT /api/users/:id applies that rule: a non-string, short, weak or long
 *      password is a 400 PASSWORD_WEAK with no internal error text and nothing
 *      written; resetting ANOTHER account to the acting admin's own password is
 *      a 400 PASSWORD_IS_YOURS (the B21 incident: a saved login filled into
 *      both fields); "" or null keeps the current password; change-password
 *      answers exactly as before
 *
 * Runs the SHIPPED code: the login, change-password and PUT /api/users/:id
 * routes, notifyPasswordChanged(), sendEmail(), invoiceEmailHtml(),
 * purgeUserSessions(), refreshOwnSession(), liveSessionIds(), logAudit(),
 * requireAuth, requireRole and the session middleware are lifted out of
 * server.js and wired to the real express-session and its SQLite store, over
 * an in-memory database built from server.js's own CREATE statements.
 * PUT /api/users/:id's period, sheet and rename machinery is stubbed to
 * "nothing blocks" (scripts/test-session-sockets.js does the same). nodemailer
 * is replaced by a recorder: nothing here can send a real email. Loopback on
 * 127.0.0.1:0.
 *
 *   node scripts/test-password-change-notice.js
 *   LOGISX_ROOT=/path/to/base node scripts/test-password-change-notice.js   # a base checkout: fails
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { once } = require("events");

const ROOT = process.env.LOGISX_ROOT || path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const LIB_PATH = path.join(ROOT, "lib", "password-change-notice.js");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// The shipped code logs on purpose; the notice's own lines are asserted on.
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

let express, session, Database, bcrypt, SqliteStoreFactory;
try {
	express = require("express");
	session = require("express-session");
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
	SqliteStoreFactory = require("better-sqlite3-session-store");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const SqliteStoreBase = SqliteStoreFactory(session);

// ── lift the shipped code ───────────────────────────────────────────────────
function count(needle) { return SRC.split(needle).length - 1; }
function liftRoute(head) {
	if (count(head) !== 1) die(`expected exactly 1 statement starting ${JSON.stringify(head)}`);
	const a = SRC.indexOf(head);
	const end = SRC.indexOf("\n});", a);
	return SRC.slice(a, end + "\n});".length);
}
// A top-level function, to the `}` that closes it in column 0. `null` when
// server.js has no such function (the base, for the one this change adds).
function liftFunction(head, { optional = false } = {}) {
	const needle = `\n${head}`;
	const hits = count(needle);
	if (hits !== 1) {
		if (optional && hits === 0) return null;
		die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits}`);
	}
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	return SRC.slice(a, end + 2);
}
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

const SRCS = {
	login: liftRoute('app.post("/api/auth/login", loginLimiter, async (req, res) => {'),
	change: liftRoute('app.post("/api/auth/change-password", requireAuth, changePasswordLimiter, async (req, res) => {'),
	updateUser: liftRoute('app.put("/api/users/:id", requireRole("Super Admin"), async (req, res) => {'),
	purge: liftFunction("function purgeUserSessions(userId, exceptSid) {"),
	refresh: liftFunction("function refreshOwnSession(req) {"),
	live: liftFunction("function liveSessionIds(sids) {"),
	stamp: liftFunction("function stampLastLogin(userId) {"),
	audit: liftFunction("function logAudit(req, action, entity, entityId, details) {"),
	requireAuth: liftFunction("function requireAuth(req, res, next) {"),
	requireRole: liftFunction("function requireRole(...roles) {"),
	currentFlag: liftFunction("function currentMustChangePassword(sessionUser) {"),
	refreshFlag: liftFunction("function refreshPasswordChangeFlag(req, res, next) {"),
	normalize: liftFunction("function normalizeDriverName(s) {"),
	companyChange: liftFunction("function accountCompanyChange(user, companyName) {"),
	sendEmail: liftFunction("async function sendEmail(to, subject, htmlBody, attachments = [], { replyTo } = {}) {"),
	emailHtml: liftFunction("function invoiceEmailHtml({ heading, bodyHtml, ctaText = \"\", ctaHref = \"\" }) {"),
	notify: liftFunction("function notifyPasswordChanged(userId, addresses, { byAdmin }) {", { optional: true }),
};
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

let lib = null;
try { lib = require(LIB_PATH); } catch { lib = null; }
// The shared new-password rule (lib/password-rules.js). On a base without it a
// stand-in that refuses nothing is injected, so the routes still run and the
// assertions say what is missing.
let rules = null;
try { rules = require(path.join(ROOT, "lib", "password-rules.js")); } catch { rules = null; }
ok(!!rules, "§7 lib/password-rules.js exists and loads");
const passwordRules = rules || { newPasswordRefusal: () => null };
ok(!!lib, "§1 lib/password-change-notice.js exists and loads");
ok(!!SRCS.notify, "§2 server.js defines notifyPasswordChanged(userId, addresses, { byAdmin })");

// ── fixtures ────────────────────────────────────────────────────────────────
const SECRET = "b21-password-notice-secret-not-a-real-one";
const TZ = "America/New_York";
const PW = { alice: "Alice-Pass-1!", bob: "Bob-Pass-2!", root: "Root-Pass-4!", ops: "Ops-Pass-6!" };
const NEW_PW = "Fresh-Pass-77!";
const RESET_PW = "Admin-Reset-5!";
const ALL_PASSWORDS = [...Object.values(PW), NEW_PW, RESET_PW];
let HASH = null;
// "October 15, 2026 at 1:40 PM EDT": the shape the notice prints its time in.
const WHEN_RE = /on (January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4} at \d{1,2}:\d{2} (AM|PM) E[SD]T by /;

function makeDb() {
	const db = new Database(":memory:");
	db.exec(USERS_CREATE);
	for (const alter of USERS_ALTERS) db.exec(alter);
	db.exec(AUDIT_CREATE);
	const ins = db.prepare(
		"INSERT INTO users (id, username, password_hash, role, driver_name, email, full_name, company_name, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
	);
	ins.run(1, "alice", HASH.alice, "Dispatcher", "", "alice@example.test", "Alice Dispatch", "");
	ins.run(2, "bob", HASH.bob, "Super Admin", "", "bob@example.test", "Bob Admin", "");
	ins.run(4, "root", HASH.root, "Super Admin", "", "root@example.test", "", "");
	ins.run(5, "ops", HASH.ops, "Dispatcher", "", "", "", "");
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

const fastBcrypt = { compare: (pw, h) => bcrypt.compare(pw, h), hash: (pw) => bcrypt.hash(pw, 4) };

// mailer: "ok" | "fail" | "throw" | "real" (server.js's own sendEmail over a
// recording nodemailer). `replica` is the REPLICA object sendEmail reads.
async function startWorld({ mailer = "ok", replica = null, adminEmail = "" } = {}) {
	const db = makeDb();
	class TestStore extends SqliteStoreBase {}
	const sessionMiddleware = buildSessionMiddleware(db, TestStore);
	const flags = new Function("db", `${SRCS.currentFlag}\n${SRCS.refreshFlag}\nreturn { currentMustChangePassword, refreshPasswordChangeFlag };`)(db);
	const app = express();
	app.use(express.json());
	app.use(sessionMiddleware);
	app.use(flags.refreshPasswordChangeFlag);
	const server = http.createServer(app);

	const noSockets = () => {};
	const liveSessionIds = new Function("db", `${SRCS.live}\nreturn liveSessionIds;`)(db);
	const purgeUserSessions = new Function("db", "disconnectUserSockets", `${SRCS.purge}\nreturn purgeUserSessions;`)(db, noSockets);
	const refreshOwnSession = new Function("db", "disconnectSessionSockets", "liveSessionIds", `${SRCS.refresh}\nreturn refreshOwnSession;`)(
		db, noSockets, liveSessionIds);
	const logAudit = new Function("db", `${SRCS.audit}\nreturn logAudit;`)(db);
	const stampLastLogin = new Function("db", `${SRCS.stamp}\nreturn stampLastLogin;`)(db);
	const requireAuth = new Function(`${SRCS.requireAuth}\nreturn requireAuth;`)();
	const requireRole = new Function(`${SRCS.requireRole}\nreturn requireRole;`)();
	const passThrough = (req, res, next) => next();

	// What reached the mailer: { to, subject, html }.
	const sent = [];
	const transports = [];
	let sendEmail;
	if (mailer === "real") {
		const nodemailer = {
			createTransport: (opts) => {
				transports.push(opts);
				return { sendMail: async (m) => { sent.push({ to: m.to, subject: m.subject, html: m.html }); } };
			},
		};
		sendEmail = new Function("REPLICA", "nodemailer", `${SRCS.sendEmail}\nreturn sendEmail;`)(replica, nodemailer);
	} else {
		sendEmail = async (to, subject, html) => {
			sent.push({ to, subject, html });
			if (mailer === "throw") throw new Error("simulated SMTP outage");
			return mailer !== "fail";
		};
	}
	const invoiceEmailHtml = new Function(`${SRCS.emailHtml}\nreturn invoiceEmailHtml;`)();
	const notifyPasswordChanged = SRCS.notify && lib
		? new Function("passwordChangeNotice", "ADMIN_NOTIFY_EMAIL", "APP_TIMEZONE", "sendEmail", "invoiceEmailHtml",
			`${SRCS.notify}\nreturn notifyPasswordChanged;`)(lib, adminEmail, TZ, sendEmail, invoiceEmailHtml)
		: () => Promise.resolve();

	new Function("app", "loginLimiter", "db", "bcrypt", "stampLastLogin", "disconnectSessionSockets", "APP_TIMEZONE", SRCS.login)(
		app, passThrough, db, fastBcrypt, stampLastLogin, noSockets, TZ);
	new Function("app", "requireAuth", "changePasswordLimiter", "db", "bcrypt", "purgeUserSessions", "logAudit", "liveSessionIds",
		"disconnectSessionSockets", "notifyPasswordChanged", "passwordRules", SRCS.change)(
		app, requireAuth, passThrough, db, fastBcrypt, purgeUserSessions, logAudit, liveSessionIds, noSockets, notifyPasswordChanged, passwordRules);

	const noSheetRows = async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [["Load ID", "Driver"]] } }) } } });
	const auditText = (v, max) => String(v == null ? "" : v).slice(0, max);
	const normalizeDriverName = new Function(`${SRCS.normalize}\nreturn normalizeDriverName;`)();
	new Function("app", "requireRole", "db", "getSheets", "SPREADSHEET_ID", "auditText", "recordPeriodRefusal", "userUpdateLockBlockers",
		"periodLabel", "driverRenameMergeScan", "applyDriverRenameSqlite", "syncDriverToCarrierSheet", "purgeUserSessions", "logAudit",
		"notifyChange", "refreshOwnSession", "normalizeDriverName", "findDriverNameClash", "findDriverNameClashes",
		"accountDirectorySync", "accountDirectorySyncLock", "getJobTrackingCached", "periodBlockedResponse", "periodLockUnreadableResponse",
		"accountCompanyChange", "findDirectoryRowForDriver", "investorCompanyMoves", "investorCompanyLockBlockers", "notifyPasswordChanged", "passwordRules",
		SRCS.updateUser)(
		app, requireRole, db, noSheetRows, "b21-not-a-sheet", auditText, () => {},
		() => ({ unreadable: false, blockers: [] }), (period) => period, () => ({ mergeTargets: {}, mergeRows: 0 }), () => ({ counts: {} }),
		() => {}, purgeUserSessions, logAudit, () => {}, refreshOwnSession, normalizeDriverName, () => null, () => [],
		() => null, () => null, async () => ({ headers: [], data: [] }), () => {}, () => {},
		new Function(`${SRCS.companyChange}\nreturn accountCompanyChange;`)(),
		() => null, () => [], () => null, notifyPasswordChanged, passwordRules);

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		db, sent, transports,
		port: server.address().port,
		close: async () => {
			if (server.closeAllConnections) server.closeAllConnections();
			await Promise.race([new Promise((r) => server.close(() => r())), new Promise((r) => setTimeout(r, 1000))]);
			db.close();
		},
	};
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function request(port, method, urlPath, { cookie, body } = {}) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const headers = { "x-requested-with": "XMLHttpRequest" };
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
				resolve({ status: res.statusCode, json, raw: buf, cookie: cookieOut });
			});
		});
		r.on("error", reject);
		if (data !== null) r.write(data);
		r.end();
	});
}
async function login(w, username, password) {
	const r = await request(w.port, "POST", "/api/auth/login", { body: { username, password } });
	if (r.status !== 200 || !r.cookie) throw new Error(`login as ${username} failed (${r.status})`);
	return r.cookie;
}
const changePassword = (w, cookie, currentPassword, newPassword) =>
	request(w.port, "POST", "/api/auth/change-password", { cookie, body: { currentPassword, newPassword } });
const editUser = (w, cookie, id, body) => request(w.port, "PUT", `/api/users/${id}`, { cookie, body });
const sessionsOf = (db, userId) =>
	db.prepare("SELECT sid FROM sessions WHERE json_extract(sess, '$.user.id') = ?").all(userId).map((r) => r.sid);
function sidOf(cookie) {
	if (!cookie) return null;
	const v = decodeURIComponent(cookie.slice("connect.sid=".length));
	return v.startsWith("s:") ? v.slice(2, v.lastIndexOf(".")) : v;
}
const liveSid = (w, cookie) => {
	const sid = sidOf(cookie);
	return !!sid && !!w.db.prepare("SELECT 1 FROM sessions WHERE sid = ?").get(sid);
};
const storedHash = (db, id) => db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id).password_hash;
const auditDetails = (db, action) => db.prepare("SELECT details FROM audit_trail WHERE action = ? ORDER BY id").all(action).map((r) => r.details);
// The notice is sent without the route waiting for it: let it finish.
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const logsSince = (n) => logs.slice(n).join("\n");

// Visible text of an HTML email, in one forward scan with no pattern
// stripping: any "<" … ">" tag becomes a space; then the entities the
// template writes are decoded (&amp; last) and whitespace collapsed.
function textOf(html) {
	const s = String(html || "");
	let out = "";
	let i = 0;
	while (i < s.length) {
		const lt = s.indexOf("<", i);
		if (lt === -1) { out += s.slice(i); break; }
		out += s.slice(i, lt) + " ";
		const gt = s.indexOf(">", lt + 1);
		i = gt === -1 ? s.length : gt + 1;
	}
	return out.split("&#39;").join("'").split("&quot;").join("\"").split("&lt;").join("<").split("&gt;").join(">").split("&amp;").join("&")
		.split(/\s+/).filter(Boolean).join(" ");
}
const noPassword = (m) => !ALL_PASSWORDS.some((p) => String(m.html).includes(p) || String(m.subject).includes(p) || String(m.to).includes(p));

// ═══ §1 the notice ══════════════════════════════════════════════════════════
async function sectionLib() {
	if (!lib) return;
	const edt = new Date("2026-10-15T17:40:00Z");
	const est = new Date("2026-12-01T05:05:00Z");
	const admin = lib.buildPasswordChangeNotice({ when: edt, byAdmin: true, adminEmail: "", timeZone: TZ });
	ok(admin.text === "Your LogisX password was changed on October 15, 2026 at 1:40 PM EDT by an administrator. If this wasn't you, contact your administrator.",
		`§1 an admin change, no ADMIN_NOTIFY_EMAIL: the exact sentence (${admin.text})`);
	ok(admin.subject === "Your LogisX password was changed", "§1 the subject");
	const self = lib.buildPasswordChangeNotice({ when: est, byAdmin: false, adminEmail: " help@example.test ", timeZone: TZ });
	ok(self.text === "Your LogisX password was changed on December 1, 2026 at 12:05 AM EST by you. If this wasn't you, contact help@example.test.",
		`§1 a self change in winter: EST, "by you", the admin inbox as the contact (${self.text})`);
	const central = lib.buildPasswordChangeNotice({ when: edt, byAdmin: false, adminEmail: "", timeZone: "America/Chicago" });
	ok(central.text.includes("October 15, 2026 at 12:40 PM CDT"), `§1 the time is the zone it is given (APP_TIMEZONE), never the server's (${central.text})`);
	const hostile = lib.buildPasswordChangeNotice({ when: edt, byAdmin: true, adminEmail: "<b>x</b>@example.test", timeZone: TZ });
	ok(!hostile.bodyHtml.includes("<b>") && hostile.bodyHtml.includes("&lt;b&gt;") && textOf(hostile.bodyHtml) === hostile.text,
		"§1 the HTML body is the same sentence, escaped");
	ok(textOf(admin.bodyHtml) === admin.text, "§1 the HTML body reads exactly as the text");

	ok(lib.usableAddress("a@example.test") === "a@example.test" && lib.usableAddress("  a@example.test ") === "a@example.test", "§1 a plain address is used, trimmed");
	for (const bad of ["", "   ", "no-at-sign", "@example.test", "a@", "a@b@example.test", "a b@example.test", "a@example.test\r\nBcc: x@example.test",
		"a@exam\nple.test", "a@example.test\u0000", `${"x".repeat(250)}@example.test`, null, undefined, 42, {}]) {
		ok(lib.usableAddress(bad) === "", `§1 not an address the notice tries: ${JSON.stringify(bad)}`);
	}
	ok(JSON.stringify(lib.noticeRecipients(["a@example.test", "A@Example.test", "", null, "b@example.test"])) === JSON.stringify(["a@example.test", "b@example.test"]),
		"§1 each address once, letter case aside, unusable ones dropped");

	const quiet = { lines: [], warn(m) { this.lines.push(m); }, error(m) { this.lines.push(m); } };
	const calls = [];
	const r1 = await lib.sendPasswordChangeNotice({ userId: 7, addresses: ["a@example.test"], byAdmin: true, adminEmail: "", timeZone: TZ, now: edt,
		send: async (to, n) => { calls.push([to, n.subject]); return true; }, logger: quiet });
	ok(r1.sent === 1 && calls.length === 1 && calls[0][0] === "a@example.test" && quiet.lines.length === 0, "§1 a delivered notice logs nothing");
	quiet.lines = [];
	const r2 = await lib.sendPasswordChangeNotice({ userId: 7, addresses: ["a@example.test"], byAdmin: true, timeZone: TZ, send: async () => false, logger: quiet });
	ok(r2.sent === 0 && quiet.lines.length === 1 && quiet.lines[0].includes("user 7") && quiet.lines[0].includes("not sent"),
		"§1 a sender answering false: logged by account id");
	quiet.lines = [];
	let rejected = false;
	const r3 = await lib.sendPasswordChangeNotice({ userId: 7, addresses: ["a@example.test"], byAdmin: false, timeZone: TZ,
		send: async () => { throw new Error("boom"); }, logger: quiet }).catch(() => { rejected = true; });
	ok(!rejected && r3 && r3.sent === 0 && quiet.lines.some((l) => l.includes("boom")) && quiet.lines.every((l) => !l.includes("a@example.test")),
		"§1 a throwing sender: logged (by id, not by address), never rejects");
	quiet.lines = [];
	let asked = 0;
	const r4 = await lib.sendPasswordChangeNotice({ userId: 7, addresses: ["", null], byAdmin: true, timeZone: TZ, send: async () => { asked++; return true; }, logger: quiet });
	ok(r4.recipients === 0 && asked === 0 && quiet.lines.length === 1 && quiet.lines[0].includes("no usable email"),
		"§1 no usable address: nothing is sent and it is logged");
	ok(!/require\(/.test(stripComments(fs.readFileSync(LIB_PATH, "utf8"))), "§1 the module is pure: it requires nothing (the sender is passed in)");
}

// ═══ §2 change-password ═════════════════════════════════════════════════════
async function sectionSelfChange() {
	const w = await startWorld({ adminEmail: "help@example.test" });
	try {
		const here = await login(w, "alice", PW.alice);
		const other = await login(w, "alice", PW.alice);
		const r = await changePassword(w, here, PW.alice, NEW_PW);
		await settle();
		ok(r.status === 200 && r.raw === JSON.stringify({ success: true }), `§2 change-password answers exactly {"success":true} (${r.status} ${r.raw})`);
		ok(w.sent.length === 1, `§2 one notice is sent (${w.sent.length})`);
		const m = w.sent[0] || {};
		const t = textOf(m.html);
		ok(m.to === "alice@example.test", "§2 ...to the account's own address");
		ok(m.subject === "Your LogisX password was changed", "§2 ...with the notice's subject");
		ok(WHEN_RE.test(t) && t.includes("by you. If this wasn't you, contact help@example.test."),
			`§2 ...saying when (US Eastern), "by you", and ADMIN_NOTIFY_EMAIL as the contact (${t.slice(0, 160)})`);
		ok(noPassword(m), "§2 ...and carrying no password, old or new");
		ok(bcrypt.compareSync(NEW_PW, storedHash(w.db, 1)), "§2 the new password is saved");
		ok(!liveSid(w, other), "§2 the account's other session is signed out");
		ok(!!r.cookie && liveSid(w, r.cookie) && !liveSid(w, here), "§2 this session is kept, on its rotated cookie");
		ok(auditDetails(w.db, "change_password").length === 1, "§2 the change_password audit row is still written");

		// The same answer when the account has no address: nothing tells a
		// non-admin whether an address is on file.
		const ops = await login(w, "ops", PW.ops);
		const before = w.sent.length;
		const mark = logs.length;
		const r2 = await changePassword(w, ops, PW.ops, NEW_PW);
		await settle();
		ok(r2.status === 200 && r2.raw === r.raw, `§2 an account with no address gets the same answer (${r2.status} ${r2.raw})`);
		ok(w.sent.length === before && bcrypt.compareSync(NEW_PW, storedHash(w.db, 5)), "§2 ...nothing is sent and the change is saved");
		ok(logsSince(mark).includes("[password-notice] user 5 has no usable email"), "§2 ...and the missing address is logged by account id");
	} finally {
		await w.close();
	}
}

// ═══ §3 PUT /api/users/:id ══════════════════════════════════════════════════
async function sectionAdminReset() {
	const w = await startWorld();
	try {
		const admin = await login(w, "root", PW.root);
		const bob1 = await login(w, "bob", PW.bob);
		const bob2 = await login(w, "bob", PW.bob);
		ok(sessionsOf(w.db, 2).length === 2, "§3 setup: the account holds two sessions");
		const r = await editUser(w, admin, 2, { role: "Super Admin", driverName: "", email: "bob@example.test", fullName: "Bob Admin", password: RESET_PW });
		await settle();
		ok(r.status === 200, `§3 an admin reset answers 200 (${r.status} ${r.raw})`);
		ok(w.sent.length === 1, `§3 one notice is sent (${w.sent.length})`);
		const m = w.sent[0] || {};
		const t = textOf(m.html);
		ok(m.to === "bob@example.test", "§3 ...to the account whose password changed");
		ok(WHEN_RE.test(t) && t.includes("by an administrator. If this wasn't you, contact your administrator."),
			`§3 ...saying "by an administrator", and "your administrator" with no ADMIN_NOTIFY_EMAIL (${t.slice(0, 160)})`);
		ok(noPassword(m), "§3 ...and carrying no password");
		ok(bcrypt.compareSync(RESET_PW, storedHash(w.db, 2)), "§3 the new password is saved");
		ok(!liveSid(w, bob1) && !liveSid(w, bob2) && sessionsOf(w.db, 2).length === 0, "§3 the account is signed out of every session");
		ok(liveSid(w, admin), "§3 the admin who made the change stays signed in");
		const line = auditDetails(w.db, "update_user").pop() || "";
		ok(line.includes("password reset") && line.includes("sessions revoked: 2"), `§3 the update_user audit line: "password reset", "sessions revoked: 2" (${line})`);
		ok(!ALL_PASSWORDS.some((p) => line.includes(p)), "§3 ...and no password in it");

		// An edit that sets no password sends nothing (blank keeps the current one).
		const before = w.sent.length;
		const r2 = await editUser(w, admin, 1, { role: "Dispatcher", driverName: "", email: "alice@example.test", fullName: "Alice D" });
		const r3 = await editUser(w, admin, 1, { role: "Dispatcher", password: "" });
		await settle();
		ok(r2.status === 200 && r3.status === 200 && w.sent.length === before, "§3 an edit with no password, or a blank one, sends nothing");
		ok(bcrypt.compareSync(PW.alice, storedHash(w.db, 1)), "§3 ...and keeps the current password");

		// A reset that also changes the address reaches both.
		w.sent.length = 0;
		const r4 = await editUser(w, admin, 1, { email: "alice.new@example.test", password: RESET_PW });
		await settle();
		const tos = w.sent.map((x) => x.to).sort();
		ok(r4.status === 200 && JSON.stringify(tos) === JSON.stringify(["alice.new@example.test", "alice@example.test"]),
			`§3 a reset that changes the address notifies the address on file before the edit and the new one (${tos.join(", ")})`);

		// A Super Admin resetting their OWN password here is told "you", and
		// keeps the session they made it from (rebuilt under a new ID).
		w.sent.length = 0;
		const r5 = await editUser(w, admin, 4, { password: NEW_PW });
		await settle();
		ok(r5.status === 200 && w.sent.length === 1 && w.sent[0].to === "root@example.test" && textOf(w.sent[0].html).includes(" by you. "),
			`§3 a self reset on the Users page says "by you" (${w.sent.map((x) => textOf(x.html)).join(" | ").slice(0, 160)})`);
		ok(!!r5.cookie && liveSid(w, r5.cookie) && !liveSid(w, admin), "§3 ...and keeps this session, on a new ID");
	} finally {
		await w.close();
	}
}

// ═══ §4 delivery never decides the change ═══════════════════════════════════
async function sectionFailures() {
	for (const mailer of ["fail", "throw"]) {
		const w = await startWorld({ mailer });
		try {
			const admin = await login(w, "root", PW.root);
			const bob = await login(w, "bob", PW.bob);
			let mark = logs.length;
			const r = await editUser(w, admin, 2, { password: RESET_PW });
			await settle();
			ok(r.status === 200 && bcrypt.compareSync(RESET_PW, storedHash(w.db, 2)), `§4 mailer ${mailer}: the admin reset is saved and answers 200 (${r.status})`);
			ok(w.sent.length === 1 && logsSince(mark).includes("[password-notice]") && logsSince(mark).includes("user 2"),
				`§4 mailer ${mailer}: the failed notice is logged by account id`);
			ok(!liveSid(w, bob), `§4 mailer ${mailer}: the account is still signed out`);
			mark = logs.length;
			const alice = await login(w, "alice", PW.alice);
			const r2 = await changePassword(w, alice, PW.alice, NEW_PW);
			await settle();
			ok(r2.status === 200 && r2.raw === JSON.stringify({ success: true }) && bcrypt.compareSync(NEW_PW, storedHash(w.db, 1)),
				`§4 mailer ${mailer}: a self change is saved and answers as usual`);
			ok(logsSince(mark).includes("[password-notice]") && logsSince(mark).includes("user 1"), `§4 mailer ${mailer}: ...and its failed notice is logged`);
		} finally {
			await w.close();
		}
	}
	const w = await startWorld();
	try {
		const admin = await login(w, "root", PW.root);
		const mark = logs.length;
		const r = await editUser(w, admin, 5, { password: RESET_PW });
		await settle();
		ok(r.status === 200 && w.sent.length === 0 && bcrypt.compareSync(RESET_PW, storedHash(w.db, 5)),
			"§4 an account with no address: the reset is saved, nothing is sent");
		ok(logsSince(mark).includes("[password-notice] user 5 has no usable email"), "§4 ...and that is logged by account id");
	} finally {
		await w.close();
	}
}

// ═══ §5 the real sendEmail() ════════════════════════════════════════════════
async function sectionRealMailer() {
	const saved = { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };
	const setEnv = (user, pass) => {
		if (user === undefined) delete process.env.GMAIL_USER; else process.env.GMAIL_USER = user;
		if (pass === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = pass;
	};
	try {
		// A replica: mail is off even with a configured mailbox.
		const offs = [];
		setEnv("mailer@example.test", "not-a-real-app-password");
		let w = await startWorld({ mailer: "real", replica: { off: (what) => offs.push(what) } });
		try {
			const admin = await login(w, "root", PW.root);
			const r = await editUser(w, admin, 2, { password: RESET_PW });
			const alice = await login(w, "alice", PW.alice);
			const r2 = await changePassword(w, alice, PW.alice, NEW_PW);
			await settle();
			ok(r.status === 200 && r2.status === 200, "§5 replica: both changes are saved");
			ok(w.transports.length === 0 && w.sent.length === 0, `§5 replica: no transport is created and nothing is sent (${w.transports.length}/${w.sent.length})`);
			ok(offs.includes("email (SMTP)"), "§5 replica: the replica's mail switch is what stopped it");
		} finally {
			await w.close();
		}
		// A mailbox missing either half is not configured.
		for (const [user, pass, what] of [["mailer@example.test", undefined, "no GMAIL_APP_PASSWORD"], [undefined, "not-a-real-app-password", "no GMAIL_USER"]]) {
			setEnv(user, pass);
			w = await startWorld({ mailer: "real" });
			try {
				const admin = await login(w, "root", PW.root);
				const r = await editUser(w, admin, 2, { password: RESET_PW });
				await settle();
				ok(r.status === 200 && w.transports.length === 0 && w.sent.length === 0, `§5 ${what}: the change is saved and nothing is sent`);
			} finally {
				await w.close();
			}
		}
		// Both set: the branded email reaches the account.
		setEnv("mailer@example.test", "not-a-real-app-password");
		w = await startWorld({ mailer: "real" });
		try {
			const admin = await login(w, "root", PW.root);
			const r = await editUser(w, admin, 2, { password: RESET_PW });
			await settle();
			const m = w.sent[0] || {};
			ok(r.status === 200 && w.transports.length === 1 && w.sent.length === 1 && m.to === "bob@example.test",
				`§5 configured: one email to the account (${w.transports.length}/${w.sent.length})`);
			ok(m.subject === "Your LogisX password was changed" && textOf(m.html).includes("by an administrator") && String(m.html).includes("LogisX"),
				"§5 configured: the notice inside the house email template");
			ok(noPassword(m), "§5 configured: no password in it");
		} finally {
			await w.close();
		}
	} finally {
		setEnv(saved.user, saved.pass);
	}
}

// ═══ §7 the shared new-password rule ════════════════════════════════════════
const WEAK_LENGTH = { code: "PASSWORD_WEAK", error: "New password must be at least 8 characters", failed: ["length"] };
const TOO_LONG = { code: "PASSWORD_WEAK", error: "New password is too long", failed: ["length"] };
function sectionRule() {
	if (!rules) return;
	const r = rules.newPasswordRefusal;
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	ok(r("Abc-1234!") === null && r(RESET_PW) === null && r(NEW_PW) === null, "§7 a password meeting every rule passes");
	ok(same(r("Ab-1234"), WEAK_LENGTH), "§7 7 characters: too short");
	for (const v of [123, true, {}, ["Abc-1234!"], null, undefined, ""]) {
		ok(same(r(v), WEAK_LENGTH), `§7 not a string (or empty): refused as too short, never handed to bcrypt (${JSON.stringify(v)})`);
	}
	ok(same(r(`Ab1!${"x".repeat(197)}`), TOO_LONG) && r(`Ab1!${"x".repeat(196)}`) === null, "§7 at most 200 characters");
	ok(same(r("abc-12345!"), { code: "PASSWORD_WEAK", error: "Password must include an uppercase letter.", failed: ["uppercase"] }), "§7 no uppercase letter");
	ok(same(r("ABC-12345!"), { code: "PASSWORD_WEAK", error: "Password must include a lowercase letter.", failed: ["lowercase"] }), "§7 no lowercase letter");
	ok(same(r("Abc-defgh!"), { code: "PASSWORD_WEAK", error: "Password must include a number.", failed: ["digit"] }), "§7 no number");
	ok(same(r("abcdefgh"), { code: "PASSWORD_WEAK", error: "Password must include an uppercase letter, a number, a symbol (!@#$ etc.).", failed: ["uppercase", "digit", "symbol"] }),
		"§7 every missing kind is listed, in change-password's wording");
	ok(!JSON.stringify(r("abcdefgh")).includes("abcdefgh"), "§7 the refusal never echoes the password");
	ok(!/require\(/.test(stripComments(fs.readFileSync(path.join(ROOT, "lib", "password-rules.js"), "utf8"))), "§7 the module is pure");
}

// ═══ §8 PUT /api/users/:id: the reset's input rules ═════════════════════════
async function sectionResetRules() {
	const w = await startWorld();
	try {
		const admin = await login(w, "root", PW.root);
		const bob = await login(w, "bob", PW.bob);
		const bobHash = storedHash(w.db, 2);
		const unchanged = () => storedHash(w.db, 2) === bobHash && liveSid(w, bob) && w.sent.length === 0;
		for (const [what, password] of [["a number", 123], ["true", true], ["an object", {}], ["an array", ["Abc-1234!"]]]) {
			const r = await editUser(w, admin, 2, { email: "changed@example.test", password });
			await settle();
			ok(r.status === 400 && r.json && r.json.code === "PASSWORD_WEAK", `§8 a password that is ${what}: 400 PASSWORD_WEAK (${r.status} ${r.raw})`);
			ok(!/bcrypt|Illegal arguments|salt|undefined/i.test(r.raw), `§8 ...with no internal error text (${r.raw})`);
		}
		ok(unchanged() && w.db.prepare("SELECT email FROM users WHERE id = 2").get().email === "bob@example.test",
			"§8 ...and nothing is written: not the password, not the other fields; no notice; the account stays signed in");
		const short = await editUser(w, admin, 2, { password: "Ab-1234" });
		ok(short.status === 400 && short.raw === JSON.stringify(WEAK_LENGTH), `§8 a 7-character password: change-password's 400 (${short.raw})`);
		const weak = await editUser(w, admin, 2, { password: "abc-12345!" });
		ok(weak.status === 400 && weak.json && weak.json.code === "PASSWORD_WEAK" && JSON.stringify(weak.json.failed) === JSON.stringify(["uppercase"]),
			`§8 a password without an uppercase letter: 400 PASSWORD_WEAK naming it (${weak.raw})`);
		const long = await editUser(w, admin, 2, { password: `Ab1!${"x".repeat(197)}` });
		ok(long.status === 400 && long.raw === JSON.stringify(TOO_LONG), `§8 a 201-character password: 400 (${long.status})`);
		await settle();
		ok(unchanged(), "§8 no refused reset wrote anything or sent a notice");

		// The incident: the admin's saved login filled into both fields.
		const mark = auditDetails(w.db, "update_user").length;
		const own = await editUser(w, admin, 2, { password: PW.root });
		await settle();
		ok(own.status === 400 && own.json && own.json.error === "This is your own password. Enter a new password for this user.",
			`§8 resetting another account to the admin's own password: 400 with the plain message (${own.status} ${own.raw})`);
		ok(own.json && own.json.code === "PASSWORD_IS_YOURS", "§8 ...code PASSWORD_IS_YOURS");
		ok(!own.raw.includes(PW.root), "§8 ...which never echoes the password");
		ok(unchanged() && auditDetails(w.db, "update_user").length === mark, "§8 ...and nothing is written, audited as an update, or sent; the account stays signed in");

		// Allowed: blank or null keeps the current password; a different
		// password goes through; a Super Admin may set their own account to
		// anything that meets the rules (the refusal is about SOMEONE ELSE).
		const blank = await editUser(w, admin, 2, { fullName: "Bob A", password: "" });
		const nul = await editUser(w, admin, 2, { fullName: "Bob B", password: null });
		await settle();
		ok(blank.status === 200 && nul.status === 200 && unchanged(), `§8 "" or null keeps the current password and sends nothing (${blank.status}/${nul.status})`);
		const good = await editUser(w, admin, 2, { password: RESET_PW });
		await settle();
		ok(good.status === 200 && bcrypt.compareSync(RESET_PW, storedHash(w.db, 2)), "§8 a password that meets the rules and is not the admin's own is saved");
		const self = await editUser(w, admin, 4, { password: PW.root });
		ok(self.status === 200, `§8 a Super Admin re-setting their OWN account's password is not refused as "your own" (${self.status} ${self.raw})`);

		// change-password answers with the same rule, unchanged.
		const alice = await login(w, "alice", PW.alice);
		const cp1 = await changePassword(w, alice, PW.alice, "Ab-1234");
		const cp2 = await changePassword(w, alice, PW.alice, "abc-12345!");
		const cp3 = await changePassword(w, alice, PW.alice, 12345678);
		ok(cp1.status === 400 && cp1.raw === JSON.stringify(WEAK_LENGTH), `§8 change-password: too short, as before (${cp1.raw})`);
		ok(cp2.status === 400 && cp2.raw === JSON.stringify({ code: "PASSWORD_WEAK", error: "Password must include an uppercase letter.", failed: ["uppercase"] }),
			`§8 change-password: a missing kind, as before (${cp2.raw})`);
		ok(cp3.status === 400 && cp3.raw === JSON.stringify(WEAK_LENGTH), `§8 change-password: not a string, as before (${cp3.raw})`);
	} finally {
		await w.close();
	}
}

// ═══ §6 the source ══════════════════════════════════════════════════════════
function sectionSource() {
	const at = (s, needle) => s.indexOf(needle);
	const callArgs = (s) => {
		const a = s.indexOf("notifyPasswordChanged(");
		return a < 0 ? "" : s.slice(a, s.indexOf(");", a));
	};
	const change = stripComments(SRCS.change);
	const cCall = at(change, "notifyPasswordChanged(");
	ok((change.match(/notifyPasswordChanged\(/g) || []).length === 1, "§6 change-password sends the notice exactly once");
	ok(cCall > at(change, "UPDATE users SET password_hash") && cCall > at(change, '"change_password"'),
		"§6 ...after the new hash is written and the change is audited");
	ok(!/await\s+notifyPasswordChanged/.test(change), "§6 ...without waiting for it");
	ok(cCall > 0 && !/newPassword|currentPassword|\bhash\b|password_hash/.test(callArgs(change)), "§6 ...and hands it no password");
	ok(/notifyPasswordChanged\(userId, \[current\.email\], \{ byAdmin: false \}\)/.test(change), "§6 ...addressed from the account row re-read after the last await, as \"you\"");

	const upd = stripComments(SRCS.updateUser);
	const uCall = at(upd, "notifyPasswordChanged(");
	ok((upd.match(/notifyPasswordChanged\(/g) || []).length === 1, "§6 PUT /api/users/:id sends the notice exactly once");
	ok(uCall > at(upd, "db.transaction(() => {") && uCall > at(upd, 'logAudit(req, "update_user"') && uCall < at(upd, "res.json({ success: true, renamed })"),
		"§6 ...after the write commits and is audited, before it answers");
	ok(/if \(passwordHash\) notifyPasswordChanged\(/.test(upd), "§6 ...only when a password was set");
	ok(!/await\s+notifyPasswordChanged/.test(upd) && upd.lastIndexOf("await ") < at(upd, "db.transaction(() => {"),
		"§6 ...without waiting for it (no await after the write)");
	ok(uCall > 0 && !/password/.test(callArgs(upd)), "§6 ...and hands it no password");
	ok(/byAdmin: !selfEdit/.test(callArgs(upd)), "§6 ...\"an administrator\" unless the Super Admin edited their own account");
	ok(/if \(roleChanged \|\| passwordHash \|\| driverNameChanged\) \{\s*sessionsRevoked = purgeUserSessions\(id, selfEdit \? req\.sessionID : null\);/.test(upd),
		"§6 a password reset still revokes the account's sessions (every one, unless it is the editor's own)");

	const notify = SRCS.notify ? stripComments(SRCS.notify) : "";
	ok(/passwordChangeNotice\.sendPasswordChangeNotice\(/.test(notify) && /adminEmail: ADMIN_NOTIFY_EMAIL/.test(notify) && /timeZone: APP_TIMEZONE/.test(notify),
		"§6 notifyPasswordChanged() sends through the module, with ADMIN_NOTIFY_EMAIL and APP_TIMEZONE");
	ok(/sendEmail\(to, notice\.subject, invoiceEmailHtml\(/.test(notify), "§6 ...over the shared sendEmail(), which holds the replica and mailbox guards");
	ok(/\nconst passwordChangeNotice = require\("\.\/lib\/password-change-notice"\);\n/.test(SRC), "§6 server.js loads the module once");

	// The new-password rule: one copy, in lib/password-rules.js.
	ok(/\nconst passwordRules = require\("\.\/lib\/password-rules"\);\n/.test(SRC), "§6 server.js loads lib/password-rules.js once");
	ok((change.match(/passwordRules\.newPasswordRefusal\(newPassword\)/g) || []).length === 1, "§6 change-password checks the new password through the shared rule");
	ok((upd.match(/passwordRules\.newPasswordRefusal\(password\)/g) || []).length === 1, "§6 PUT /api/users/:id checks it through the same rule");
	ok(!/\/\[A-Z\]\//.test(change) && !/\/\[A-Z\]\//.test(upd), "§6 ...and neither route keeps a copy of the rule's patterns");
	const uRule = at(upd, "passwordRules.newPasswordRefusal(password)");
	const uHash = at(upd, "bcryptMod.hash(password, 10)");
	const uOwn = at(upd, "bcryptMod.compare(password, ");
	// The re-read after the last await (the first read, at the top, is `let user = …`).
	const uReread = at(upd, "const stale = user;");
	ok(uRule > 0 && uRule < uHash, "§6 PUT checks the rule before it hashes (nothing malformed reaches bcrypt)");
	ok(uOwn > 0 && uOwn < uReread && Math.abs(uOwn - uHash) < 600,
		"§6 PUT compares with the acting admin's hash alongside the hashing, in the await block above the re-read and the guards");
	ok(/"PASSWORD_IS_YOURS"/.test(upd) && /This is your own password\. Enter a new password for this user\./.test(upd), "§6 ...and refuses with its code and message");
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
	HASH = Object.fromEntries(Object.entries(PW).map(([k, v]) => [k, bcrypt.hashSync(v, 4)]));
	sectionSource();
	await sectionLib();
	await sectionSelfChange();
	await sectionAdminReset();
	await sectionFailures();
	await sectionRealMailer();
	sectionRule();
	await sectionResetRules();
	finish();
})().catch((e) => {
	restoreConsole();
	console.error(e);
	process.exit(1);
});
