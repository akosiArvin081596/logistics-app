#!/usr/bin/env node
/**
 * scripts/test-messages-staff-only.js — who a message may be addressed to, and
 * the staff desk names no account may take.
 *
 * The rule (Arvin, decision 30, 2026-10-21): drivers and investors message
 * staff only (Dispatch, admins, the owner), never each other. POST
 * /api/messages holds it the way the voice-note route (#583) does.
 *
 *   §1 POST /api/messages, lifted from server.js with every declaration it
 *      reaches (scripts/lib/server-lift.js), over an in-memory SQLite:
 *      - a Driver or an Investor sends only to the staff desk. Another driver,
 *        an investor, a staff member's own name or a name no one holds is
 *        403 MESSAGE_RECIPIENT: no row, no notification, no live copy, and the
 *        refusal is audited. A desk name in another case or with edge spaces is
 *        stored as the desk's own spelling ("Dispatch", "admin"). A recipient
 *        that is not a string is refused before anything is written.
 *      - staff send as "Dispatch" or as themselves (422 MESSAGE_SENDER
 *        otherwise), to one existing Driver or Investor account or the desk
 *        (422 MESSAGE_RECIPIENT otherwise, a staff account included).
 *      - unchanged: the driver app's send (to "Dispatch"), the investor
 *        portal's (to "admin"), the dispatch inbox's ("Dispatch" to a driver or
 *        an investor, any case), a Super Admin in the driver app (his own name
 *        to "Dispatch"), a Driver's `from` pinned to his session.
 *   §2 the desk names are reserved: findDriverNameClash() reports "admin" as
 *      reserved, as it does "dispatch" and "investor"; POST /api/users refuses a
 *      username that is a desk name (any case, edge spaces) with 409
 *      USERNAME_RESERVED and writes nothing, and a driver name "Admin" with
 *      409 DRIVER_NAME_TAKEN; an ordinary account still creates.
 *
 * Which desk each role may use (MS2 in the plan) is left unasserted: the
 * driver app names "Dispatch", the investor portal "admin", and both are
 * pinned. The account delete (DELETE /api/users/:id never removing a desk's
 * messages) belongs in scripts/test-user-delete-cascade.js, whose harness
 * mounts that route.
 *
 * FIXTURES: an in-memory SQLite, made-up names only. No network, no app.db.
 * Run: node scripts/test-messages-staff-only.js
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
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

let Database, chatFiles, bcrypt;
try {
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
	chatFiles = require("../lib/chat-files");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const DRIVER_A = "Tamsin Vale";
const DRIVER_B = "Orrin Cade";
const INVESTOR = "inv_t";
const INVESTOR_2 = "inv_u";
const U = {
	sa: { id: 1, role: "Super Admin", username: "boss_t", driverName: "" },
	disp: { id: 2, role: "Dispatcher", username: "desk_t", driverName: "" },
	drvA: { id: 10, role: "Driver", username: "drv_a", driverName: DRIVER_A },
	drvB: { id: 11, role: "Driver", username: "drv_b", driverName: DRIVER_B },
	inv: { id: 50, role: "Investor", username: INVESTOR, driverName: "" },
	inv2: { id: 51, role: "Investor", username: INVESTOR_2, driverName: "" },
};

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL DEFAULT '',
		role TEXT NOT NULL, driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT DEFAULT '',
		must_change_password INTEGER DEFAULT 0)`);
	db.exec("CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT COLLATE NOCASE UNIQUE)");
	db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL,
		message TEXT NOT NULL, load_id TEXT DEFAULT '', read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		asset_ref TEXT DEFAULT '', attachment_url TEXT DEFAULT '', attachment_type TEXT DEFAULT '')`);
	if (chatFiles.CHAT_UPLOADS_SCHEMA_SQL) db.exec(chatFiles.CHAT_UPLOADS_SCHEMA_SQL);
	const add = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, ?, ?)");
	for (const u of Object.values(U)) add.run(u.id, u.username, u.role, u.driverName);
	db.prepare("INSERT INTO drivers_directory (driver_name) VALUES (?)").run(DRIVER_A);
	db.prepare("INSERT INTO drivers_directory (driver_name) VALUES (?)").run(DRIVER_B);
	return db;
}

// A handler registered through app.post/app.put/app.delete, called with a fake
// request and response. The last function argument is the handler; the guards
// before it are the server's and are not this runner's subject.
function captureApp() {
	const handlers = new Map();
	const reg = (method) => (p, ...fns) => handlers.set(`${method} ${p}`, fns[fns.length - 1]);
	return { app: { post: reg("POST"), put: reg("PUT"), delete: reg("DELETE"), get: reg("GET") }, handlers };
}
async function call(handler, user, body) {
	const out = { status: 200, body: null };
	const res = {
		status(c) { out.status = c; return this; },
		json(b) { out.body = b; return this; },
		send(b) { out.body = b; return this; },
		end() { return this; },
	};
	const req = { body, session: { user }, headers: {}, ip: "127.0.0.1", get: () => "" };
	await handler(req, res);
	return out;
}

// ---------------------------------------------------------------------------
// §1 POST /api/messages
// ---------------------------------------------------------------------------
const MESSAGES_HEAD = 'app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {';
const AUDIT_STUBS = ["logAudit", "logAuditRefusal"];
const MESSAGE_PROVIDED = ["app", "db", "requireAuth", "driverWriteLimiter", "chatFiles", "console", "require",
	"insertNotification", "io", "shownLoadId", "emitDispatchByRole", ...AUDIT_STUBS];

function mountMessages(db) {
	let lifted;
	try {
		lifted = closure(SRC, { roots: [], routes: [MESSAGES_HEAD], provided: MESSAGE_PROVIDED, denied: ["server", "httpServer", "sheets"] }).text;
	} catch (e) {
		die(`POST /api/messages could not be lifted: ${e.message}`);
	}
	const log = { notifications: [], emits: [], audits: [] };
	const io = {
		to: (rooms) => ({
			emit: (event, payload) => log.emits.push({ rooms: [].concat(rooms), event, payload }),
			except: () => ({ emit: (event, payload) => log.emits.push({ rooms: [].concat(rooms), event, payload }) }),
		}),
	};
	const insertNotification = { run: (...args) => { log.notifications.push(args); return { lastInsertRowid: log.notifications.length }; } };
	const audit = (kind) => (...args) => log.audits.push({ kind, text: args.map((a) => (typeof a === "string" ? a : "")).join(" | ") });
	const { app, handlers } = captureApp();
	const env = {
		app, db, requireAuth: () => {}, driverWriteLimiter: () => {}, chatFiles, console: { log() {}, warn() {}, error() {} }, require,
		insertNotification, io, shownLoadId: (who, raw) => raw, emitDispatchByRole: () => {},
		logAudit: audit("logAudit"), logAuditRefusal: audit("logAuditRefusal"),
	};
	const names = Object.keys(env);
	new Function(...names, `"use strict";\n${lifted}`)(...names.map((k) => env[k]));
	const handler = handlers.get("POST /api/messages");
	if (typeof handler !== "function") die("the lifted POST /api/messages registered no handler");
	return { send: (user, body) => call(handler, user, body), log };
}

const rowCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
const lastRow = (db) => db.prepare('SELECT "from" AS f, "to" AS t, message, load_id AS loadId FROM messages ORDER BY id DESC LIMIT 1').get();
const audited = (log, code) => log.audits.some((a) => a.text.includes(code));

// A refused send: the status and code, nothing stored, no notification, no
// live copy. Returns the response for the caller's own checks.
async function expectRefused(label, m, db, user, body, status, code) {
	const before = { rows: rowCount(db), notes: m.log.notifications.length, emits: m.log.emits.length };
	let r;
	try { r = await m.send(user, body); } catch (e) { r = { status: "threw", body: { error: e.message } }; }
	const got = `${r.status} ${(r.body && r.body.code) || ""}`.trim();
	ok(`${label}: ${status} ${code} (got ${got})`, r.status === status && r.body && r.body.code === code);
	ok(`${label}: nothing stored, no notification, no live copy`,
		rowCount(db) === before.rows && m.log.notifications.length === before.notes && m.log.emits.length === before.emits);
	return r;
}
async function expectSent(label, m, db, user, body, check) {
	const before = rowCount(db);
	let r;
	try { r = await m.send(user, body); } catch (e) { r = { status: "threw", body: { error: e.message } }; }
	const row = rowCount(db) === before + 1 ? lastRow(db) : null;
	ok(`${label}: 200, one row (got ${r.status})`, r.status === 200 && r.body && r.body.success === true && !!row);
	if (check) ok(`${label}: ${check.name}`, !!row && check.test(row));
	return { r, row };
}

async function section1() {
	const db = makeDb();
	const m = mountMessages(db);

	// What must not change.
	await expectSent("§1 the driver app's send (Driver to \"Dispatch\")", m, db, U.drvA,
		{ from: DRIVER_A, to: "Dispatch", message: "At the shipper", loadId: "L-100" },
		{ name: "stored from the driver to \"Dispatch\" with the load", test: (row) => row.f === DRIVER_A && row.t === "Dispatch" && row.loadId === "L-100" });
	const note = m.log.notifications[m.log.notifications.length - 1];
	ok("§1 ...the desk's notification and the dispatch room's live copy, as before",
		!!note && note[0] === "dispatch" && m.log.emits.some((e) => e.rooms.includes("dispatch") && e.event === "new-message"));
	await expectSent("§1 a Driver's `from` stays his own (sending as \"Dispatch\" is ignored)", m, db, U.drvA,
		{ from: "Dispatch", to: "Dispatch", message: "Running late" },
		{ name: "stored from the driver", test: (row) => row.f === DRIVER_A });
	await expectSent("§1 the investor portal's send (Investor to \"admin\")", m, db, U.inv,
		{ from: INVESTOR, to: "admin", message: "Question about my statement" },
		{ name: "stored from the investor to \"admin\"", test: (row) => row.f === INVESTOR && row.t === "admin" });
	await expectSent("§1 the dispatch inbox: a Dispatcher, as \"Dispatch\", to a driver", m, db, U.disp,
		{ from: "Dispatch", to: DRIVER_A, message: "Call when loaded", loadId: "L-100" },
		{ name: "stored from \"Dispatch\" to the driver", test: (row) => row.f === "Dispatch" && row.t.toLowerCase() === DRIVER_A.toLowerCase() });
	await expectSent("§1 the dispatch inbox: a Super Admin, as \"Dispatch\", to an investor", m, db, U.sa,
		{ from: "Dispatch", to: INVESTOR, message: "Statement attached" },
		{ name: "stored to the investor", test: (row) => row.f === "Dispatch" && row.t.toLowerCase() === INVESTOR });
	await expectSent("§1 the dispatch inbox: a driver named in another case (the fleet list's spelling)", m, db, U.disp,
		{ from: "Dispatch", to: "tamsin vale", message: "Check in please" },
		{ name: "stored to that driver", test: (row) => row.t.toLowerCase() === DRIVER_A.toLowerCase() });
	await expectSent("§1 a Super Admin in the driver app: his own name to \"Dispatch\"", m, db, U.sa,
		{ from: U.sa.username, to: "Dispatch", message: "Testing the driver chat" },
		{ name: "stored from his own name", test: (row) => row.f === U.sa.username && row.t === "Dispatch" });

	// The rule: a Driver or an Investor sends to the staff desk only.
	const r1 = await expectRefused("§1 Driver to another driver", m, db, U.drvA, { from: DRIVER_A, to: DRIVER_B, message: "hey" }, 403, "MESSAGE_RECIPIENT");
	ok("§1 ...the refusal is audited (MESSAGE_RECIPIENT)", audited(m.log, "MESSAGE_RECIPIENT"));
	ok("§1 ...and the answer names no other account", !!r1.body && !JSON.stringify(r1.body).includes(DRIVER_B));
	await expectRefused("§1 Driver to another driver, in another case", m, db, U.drvA, { from: DRIVER_A, to: "ORRIN CADE", message: "hey" }, 403, "MESSAGE_RECIPIENT");
	await expectRefused("§1 Driver to an investor", m, db, U.drvA, { from: DRIVER_A, to: INVESTOR, message: "hey" }, 403, "MESSAGE_RECIPIENT");
	await expectRefused("§1 Driver to a staff member's own name", m, db, U.drvA, { from: DRIVER_A, to: U.sa.username, message: "hey" }, 403, "MESSAGE_RECIPIENT");
	await expectRefused("§1 Driver to a name no one holds", m, db, U.drvA, { from: DRIVER_A, to: "Nobody Here", message: "hey" }, 403, "MESSAGE_RECIPIENT");
	await expectRefused("§1 Driver to himself", m, db, U.drvA, { from: DRIVER_A, to: DRIVER_A, message: "note to self" }, 403, "MESSAGE_RECIPIENT");
	await expectRefused("§1 Investor to another investor", m, db, U.inv, { from: INVESTOR, to: INVESTOR_2, message: "hey" }, 403, "MESSAGE_RECIPIENT");
	await expectRefused("§1 Investor to a driver", m, db, U.inv, { from: INVESTOR, to: DRIVER_A, message: "hey" }, 403, "MESSAGE_RECIPIENT");
	await expectRefused("§1 Investor to the investors' room name", m, db, U.inv, { from: INVESTOR, to: "investor", message: "hey" }, 403, "MESSAGE_RECIPIENT");
	{
		const before = rowCount(db);
		let r;
		try { r = await m.send(U.drvA, { from: DRIVER_A, to: ["Dispatch", DRIVER_B], message: "hey" }); } catch (e) { r = { status: "threw" }; }
		ok(`§1 a recipient that is not a string is refused at the boundary, 400 or 403 (got ${r.status})`, r.status === 400 || r.status === 403);
		ok("§1 ...and nothing is stored", rowCount(db) === before);
	}
	await expectSent("§1 a desk name with edge spaces and another case", m, db, U.drvA,
		{ from: DRIVER_A, to: " dispatch ", message: "Loaded" },
		{ name: "is stored as the desk's own spelling, \"Dispatch\"", test: (row) => row.t === "Dispatch" });
	await expectSent("§1 the investor desk in another case", m, db, U.inv,
		{ from: INVESTOR, to: "ADMIN", message: "Hello" },
		{ name: "is stored as \"admin\"", test: (row) => row.t === "admin" });

	// Staff: as "Dispatch" or as themselves, to one Driver or Investor account or the desk.
	await expectRefused("§1 a Dispatcher sending as a driver", m, db, U.disp, { from: DRIVER_B, to: DRIVER_A, message: "hey" }, 422, "MESSAGE_SENDER");
	await expectRefused("§1 staff to a name no account holds", m, db, U.disp, { from: "Dispatch", to: "Nobody Here", message: "hey" }, 422, "MESSAGE_RECIPIENT");
	await expectRefused("§1 staff to another staff account", m, db, U.disp, { from: "Dispatch", to: U.sa.username, message: "hey" }, 422, "MESSAGE_RECIPIENT");
}

// ---------------------------------------------------------------------------
// §2 desk names are reserved
// ---------------------------------------------------------------------------
const USERS_HEAD = 'app.post("/api/users", requireRole("Super Admin"), async (req, res) => {';
const USERS_STUBS = {
	requireRole: () => () => {},
	syncDriverToCarrierSheet: () => {},
	syncCarrierDriverHistory: () => {},
	notifyChange: () => {},
	recordPayRateChanges: () => {},
	// The month-end locks are scripts/test-account-directory-row-lock.js's and
	// scripts/test-investor-company-lock.js's subject; here they judge nothing.
	accountDirectoryRowJudged: () => false,
	accountDirectoryRowLock: () => null,
	investorCompanyMoves: () => [],
	investorCompanyLockBlockers: () => null,
	getJobTrackingCached: async () => ({ headers: [], data: [] }),
	periodLockUnreadableResponse: (req, res) => res.status(503).json({ code: "PERIOD_LOCK_UNREADABLE" }),
	periodBlockedResponse: (req, res) => res.status(409).json({ code: "PERIOD_FINALIZED" }),
};

const USERS_PROVIDED = ["app", "db", "bcrypt", "console", "require", ...AUDIT_STUBS, ...Object.keys(USERS_STUBS)];
let usersLifted = null;
function mountUsers(db) {
	if (!usersLifted) {
		try {
			usersLifted = closure(SRC, { roots: ["findDriverNameClash"], routes: [USERS_HEAD], provided: USERS_PROVIDED, denied: ["server", "httpServer", "io", "sheets"] }).text;
		} catch (e) {
			die(`POST /api/users could not be lifted: ${e.message}`);
		}
	}
	const lifted = usersLifted;
	const { app, handlers } = captureApp();
	let clash = null;
	const env = {
		app, db, bcrypt: { hash: (pw) => bcrypt.hash(pw, 4) }, console: { log() {}, warn() {}, error() {} }, require,
		logAudit: () => {}, logAuditRefusal: () => {}, ...USERS_STUBS,
		exposeClash: (fn) => { clash = fn; },
	};
	const names = Object.keys(env);
	new Function(...names, `"use strict";\n${lifted}\nexposeClash(findDriverNameClash);`)(...names.map((k) => env[k]));
	const handler = handlers.get("POST /api/users");
	if (typeof handler !== "function") die("the lifted POST /api/users registered no handler");
	return { create: (body) => call(handler, U.sa, body), clash };
}

async function section2() {
	const u = mountUsers(makeDb());
	const reserved = (name) => { const hit = u.clash(name); return !!hit && hit.source === "reserved"; };
	ok("§2 \"dispatch\" is a reserved name, as before", reserved("dispatch") && reserved(" Dispatch "));
	ok("§2 \"investor\" is a reserved name, as before", reserved("investor"));
	ok("§2 \"admin\", the investor portal's desk, is a reserved name", reserved("admin"));
	ok("§2 ...in any case, with edge spaces", reserved(" ADMIN "));

	const count = (db) => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
	// Each refusal on its own database, so no case leans on an account an
	// earlier case created.
	const refusedName = async (label, body, code) => {
		const db = makeDb();
		const fresh = mountUsers(db);
		const before = count(db);
		let r;
		try { r = await fresh.create(body); } catch (e) { r = { status: "threw", body: { error: e.message } }; }
		const got = `${r.status} ${(r.body && r.body.code) || ""}`.trim();
		ok(`§2 POST /api/users ${label}: 409 ${code} (got ${got})`, r.status === 409 && r.body && r.body.code === code);
		ok(`§2 ...${label}: no account written`, count(db) === before);
	};
	await refusedName("username \"admin\" (an Investor)", { username: "admin", password: "made-up-pw-1", role: "Investor" }, "USERNAME_RESERVED");
	await refusedName("username \" Admin \" (a Super Admin)", { username: " Admin ", password: "made-up-pw-1", role: "Super Admin" }, "USERNAME_RESERVED");
	await refusedName("username \"DISPATCH\" (a Dispatcher)", { username: "DISPATCH", password: "made-up-pw-1", role: "Dispatcher" }, "USERNAME_RESERVED");
	await refusedName("username \"investor\" (a Driver)", { username: "investor", password: "made-up-pw-1", role: "Driver", driverName: "Wren Holt" }, "USERNAME_RESERVED");
	await refusedName("driver name \"Admin\"", { username: "wren_h", password: "made-up-pw-1", role: "Driver", driverName: "Admin" }, "DRIVER_NAME_TAKEN");

	const db = makeDb();
	const plain = mountUsers(db);
	const before = count(db);
	const r = await plain.create({ username: "wren_h", password: "made-up-pw-1", role: "Investor" });
	ok(`§2 an ordinary username still creates (got ${r.status})`, r.status === 200 && count(db) === before + 1);
	const r2 = await plain.create({ username: "admin_wren", password: "made-up-pw-1", role: "Investor" });
	ok(`§2 a username that only contains a desk name still creates (got ${r2.status})`, r2.status === 200 && count(db) === before + 2);
}

(async () => {
	await section1();
	await section2();
	console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
	process.exit(failed ? 1 : 0);
})().catch((e) => die(e.stack || e.message));
