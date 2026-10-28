#!/usr/bin/env node
/**
 * scripts/test-investor-picker-account-username.js — a Super Admin starts a
 * conversation with an investor from the Messages picker.
 *
 * GET /api/users/investors answers each investor's full name as `username`
 * (the truck owner pickers show it). POST /api/messages addresses an investor
 * by his account's sign-in username (users.username), so a picker that sent
 * the full name was refused 422 MESSAGE_RECIPIENT whenever the two differ.
 *
 *   §1 a Super Admin's answer carries `accountUsername`, the linked Investor
 *      account's sign-in username; null for an investor with no linked
 *      account, or one linked to an account that is not an Investor. `username`
 *      and `CompanyName` keep the full name, in the same order as before.
 *   §2 a Dispatcher's answer is the old one, byte for byte: no new field.
 *   §3 POST /api/messages, as a Super Admin, accepts the `accountUsername` a
 *      picked investor carries (the row goes to that account), and still
 *      refuses the full name (422 MESSAGE_RECIPIENT).
 *
 * Both routes are lifted from server.js (scripts/lib/server-lift.js) over an
 * in-memory SQLite. FIXTURES: made-up names only. No network, no app.db.
 * Run: node scripts/test-investor-picker-account-username.js
 *      SERVER_JS=/path/to/base/server.js node scripts/test-investor-picker-account-username.js   # fails on the base
 */

"use strict";
const fs = require("fs");
const path = require("path");
const { closure } = require("./lib/server-lift");

let failed = 0;
const ok = (name, cond) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}`); }
};
const eq = (name, got, want) => ok(`${name} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want));
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

let Database, chatFiles;
try {
	Database = require("better-sqlite3");
	chatFiles = require("../lib/chat-files");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

const SRC = require("./lib/server-source").serverSource();

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const SA = { id: 1, role: "Super Admin", username: "boss_q", driverName: "" };
const DISP = { id: 2, role: "Dispatcher", username: "desk_q", driverName: "" };
// Full names that differ from the sign-in usernames.
const INV_A = { id: 50, username: "fenwick_q", fullName: "Marla Fenwick" };
const INV_B = { id: 51, username: "oduya_q", fullName: "Benedict Oduya" };
// A directory row whose user_id names a Dispatcher account, and one with none.
const MISLINKED = { fullName: "Cyrus Lamb", userId: DISP.id };
const UNLINKED = { fullName: "Anouk Prell" };

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL DEFAULT '',
		role TEXT NOT NULL, driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT DEFAULT '')`);
	db.exec(`CREATE TABLE investors (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, full_name TEXT NOT NULL DEFAULT '',
		carrier_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Active', notes TEXT NOT NULL DEFAULT '')`);
	db.exec("CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT COLLATE NOCASE UNIQUE)");
	db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL,
		message TEXT NOT NULL, load_id TEXT DEFAULT '', read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		asset_ref TEXT DEFAULT '', attachment_url TEXT DEFAULT '', attachment_type TEXT DEFAULT '')`);
	if (chatFiles.CHAT_UPLOADS_SCHEMA_SQL) db.exec(chatFiles.CHAT_UPLOADS_SCHEMA_SQL);
	const addUser = db.prepare("INSERT INTO users (id, username, role, full_name) VALUES (?, ?, ?, ?)");
	addUser.run(SA.id, SA.username, SA.role, "");
	addUser.run(DISP.id, DISP.username, DISP.role, "");
	addUser.run(INV_A.id, INV_A.username, "Investor", INV_A.fullName);
	addUser.run(INV_B.id, INV_B.username, "Investor", INV_B.fullName);
	const addInv = db.prepare("INSERT INTO investors (user_id, full_name, carrier_name) VALUES (?, ?, ?)");
	addInv.run(INV_B.id, INV_B.fullName, "Oduya Haulage");
	addInv.run(INV_A.id, INV_A.fullName, "Fenwick Freight");
	addInv.run(MISLINKED.userId, MISLINKED.fullName, "Lamb Lines");
	addInv.run(null, UNLINKED.fullName, "Prell Transport");
	return db;
}

function captureApp() {
	const handlers = new Map();
	const reg = (method) => (p, ...fns) => handlers.set(`${method} ${p}`, fns[fns.length - 1]);
	return { app: { post: reg("POST"), put: reg("PUT"), delete: reg("DELETE"), get: reg("GET") }, handlers };
}
async function call(handler, user, body, query = {}) {
	const out = { status: 200, body: null, raw: null };
	const res = {
		status(c) { out.status = c; return this; },
		json(b) { out.body = b; out.raw = JSON.stringify(b); return this; },
		send(b) { out.body = b; return this; },
		end() { return this; },
	};
	const req = { body, query, params: {}, session: { user }, headers: {}, ip: "127.0.0.1", get: () => "" };
	await handler(req, res);
	return out;
}

function mount(db, head, key, provided, env) {
	let lifted;
	try {
		lifted = closure(SRC, { roots: [], routes: [head], provided, denied: ["server", "httpServer", "sheets"] }).text;
	} catch (e) {
		die(`${key} could not be lifted: ${e.message}`);
	}
	const { app, handlers } = captureApp();
	const full = { app, db, ...env };
	const names = Object.keys(full);
	new Function(...names, `"use strict";\n${lifted}`)(...names.map((k) => full[k]));
	const handler = handlers.get(key);
	if (typeof handler !== "function") die(`the lifted ${key} registered no handler`);
	return handler;
}

const LIST_HEAD = 'app.get("/api/users/investors", requireRole("Super Admin", "Dispatcher"), (req, res) => {';
const MESSAGES_HEAD = 'app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {';

(async () => {
	const db = makeDb();
	const list = mount(db, LIST_HEAD, "GET /api/users/investors", ["app", "db", "requireRole"], { requireRole: () => () => {} });
	const quietConsole = { log() {}, warn() {}, error() {} };
	const insertNotification = { run: () => ({ lastInsertRowid: 1 }) };
	const io = { to: () => ({ emit() {}, except: () => ({ emit() {} }) }) };
	const send = mount(db, MESSAGES_HEAD, "POST /api/messages",
		["app", "db", "requireAuth", "driverWriteLimiter", "chatFiles", "console", "require", "insertNotification", "io",
			"shownLoadId", "emitDispatchByRole", "logAudit", "logAuditRefusal"],
		{ requireAuth: () => {}, driverWriteLimiter: () => {}, chatFiles, console: quietConsole, require, insertNotification, io,
			shownLoadId: (who, raw) => raw, emitDispatchByRole: () => {}, logAudit: () => {}, logAuditRefusal: () => {} });

	// The answer before this change, read straight from the table.
	const oldShape = db.prepare("SELECT user_id AS id, full_name AS username, full_name AS CompanyName FROM investors ORDER BY full_name ASC").all();

	// ── §1 a Super Admin's answer ──────────────────────────────────────────────
	const sa = await call(list, SA, undefined);
	const rows = (sa.body && sa.body.investors) || [];
	eq("§1 Super Admin: 200 with every investor, ordered by full name", [sa.status, rows.map((r) => r.username)],
		[200, oldShape.map((r) => r.username)]);
	const byName = Object.fromEntries(rows.map((r) => [r.username, r]));
	eq("§1 a linked investor carries his sign-in username as accountUsername",
		[byName[INV_A.fullName] && byName[INV_A.fullName].accountUsername, byName[INV_B.fullName] && byName[INV_B.fullName].accountUsername],
		[INV_A.username, INV_B.username]);
	const nullTarget = (r) => !!r && Object.prototype.hasOwnProperty.call(r, "accountUsername") && r.accountUsername === null;
	eq("§1 an investor with no linked account, or one linked to a non-Investor account, has accountUsername null",
		[nullTarget(byName[UNLINKED.fullName]), nullTarget(byName[MISLINKED.fullName])], [true, true]);
	eq("§1 username, CompanyName and id keep their meaning (full name, full name, linked user id)",
		rows.map((r) => [r.id, r.username, r.CompanyName]), oldShape.map((r) => [r.id, r.username, r.CompanyName]));

	// ── §2 a Dispatcher's answer ───────────────────────────────────────────────
	const disp = await call(list, DISP, undefined);
	eq("§2 Dispatcher: 200, the old answer byte for byte", [disp.status, disp.raw], [200, JSON.stringify({ investors: oldShape })]);
	ok("§2 Dispatcher: no row carries accountUsername",
		((disp.body && disp.body.investors) || []).every((r) => !Object.prototype.hasOwnProperty.call(r, "accountUsername")));

	// ── §3 the picked investor's name is accepted by POST /api/messages ────────
	const picked = byName[INV_A.fullName] && byName[INV_A.fullName].accountUsername;
	const before = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
	const r1 = await call(send, SA, { from: "Dispatch", to: picked, message: "Made-up hello", loadId: "" });
	const row = db.prepare('SELECT "from" AS f, "to" AS t, load_id AS l FROM messages ORDER BY id DESC LIMIT 1').get();
	eq("§3 Super Admin to the picked accountUsername: 200 and one row to that account (General)",
		[r1.status, db.prepare("SELECT COUNT(*) AS n FROM messages").get().n - before, row && row.t, row && row.l],
		[200, 1, INV_A.username, ""]);
	const r2 = await call(send, SA, { from: "Dispatch", to: INV_A.fullName, message: "Made-up hello", loadId: "" });
	eq("§3 the full name is still no recipient: 422 MESSAGE_RECIPIENT", [r2.status, r2.body && r2.body.code], [422, "MESSAGE_RECIPIENT"]);

	if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
	console.log("\nall checks passed");
})().catch((e) => die(e.stack || e.message));
