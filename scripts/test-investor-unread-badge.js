#!/usr/bin/env node
/**
 * scripts/test-investor-unread-badge.js — the Dispatch inbox counts and clears
 * messages to both staff desks, for the staff who read each.
 *
 * An investor writes to the "admin" desk (#589: the investor portal's one
 * desk; staff reply as "Dispatch"). The Messages inbox (/messages) is where
 * staff read both desks, so its unread badge counts a message to "admin" the
 * way it counts one to "Dispatch", and opening the conversation clears it.
 * Investor conversations are Super Admin only (P1): a Dispatcher's inbox holds
 * none, so his badge counts the "Dispatch" desk only
 * (scripts/test-investor-chats-super-admin-only.js covers every path).
 *
 *   §1 GET /api/messages, lifted from server.js (scripts/lib/server-lift.js)
 *      over an in-memory SQLite: for a Super Admin, each conversation's
 *      `unread` counts its unread messages to either desk ("Dispatch" or
 *      "admin", any letter case); a Dispatcher's lists no investor and counts
 *      the driver's as before. Not counted: a message staff sent (to a driver
 *      or an investor), a message already read, and a look-alike name that is
 *      no desk ("admin2", "administrator").
 *   §2 PUT /api/messages/read then GET /api/messages: a Super Admin marking an
 *      investor's "admin" messages read clears that conversation's count; a
 *      Dispatcher's mark leaves them unread. An Investor marks only messages
 *      addressed to him (his own "admin" messages stay unread), and a Driver
 *      cannot mark the investor's either.
 *
 * The client half (stores/messages.js marking "admin" messages read when the
 * conversation opens) is scripts/test-investor-unread-badge-store.mjs.
 *
 * FIXTURES: an in-memory SQLite, made-up names only. No network, no app.db.
 * Run: node scripts/test-investor-unread-badge.js
 *      SERVER_JS=/path/to/base/server.js node scripts/test-investor-unread-badge.js   # the base: fails §1
 */

"use strict";
const fs = require("fs");
const path = require("path");
const { closure } = require("./lib/server-lift");

let failed = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`); }
};
const eq = (name, got, want) => ok(`${name} (want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want), got);
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

let Database;
try {
	Database = require("better-sqlite3");
} catch (e) {
	die(`better-sqlite3 did not load (${e.message}); run npm ci under the .nvmrc Node`);
}

const SRC = require("./lib/server-source").serverSource();

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const DRIVER = "Tamsin Vale";
const INVESTOR = "inv_t";
const INVESTOR_2 = "inv_u";
const U = {
	sa: { id: 1, role: "Super Admin", username: "boss_t", driverName: "" },
	disp: { id: 2, role: "Dispatcher", username: "desk_t", driverName: "" },
	drv: { id: 10, role: "Driver", username: "drv_t", driverName: DRIVER },
	inv: { id: 50, role: "Investor", username: INVESTOR, driverName: "" },
};

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL,
		message TEXT NOT NULL, load_id TEXT DEFAULT '', read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		asset_ref TEXT DEFAULT '', attachment_url TEXT DEFAULT '', attachment_type TEXT DEFAULT '',
		voice_file TEXT DEFAULT '', voice_duration_ms INTEGER DEFAULT 0, party_user_id INTEGER)`);
	// The accounts: who is an Investor decides which conversations are investor
	// conversations (server.js INVESTOR_CHAT_SQL).
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL, driver_name TEXT DEFAULT '')");
	const add = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, ?, ?)");
	for (const u of [...Object.values(U), { id: 51, role: "Investor", username: INVESTOR_2, driverName: "" }]) add.run(u.id, u.username, u.role, u.driverName);
	return db;
}
let clock = 0;
function addMessage(db, from, to, message, { loadId = "", read = 0 } = {}) {
	clock++;
	const ts = `2026-10-22T1${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, "0")}:00.000Z`;
	return db.prepare(`INSERT INTO messages (timestamp, "from", "to", message, load_id, read) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(ts, from, to, message, loadId, read).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// The two routes as shipped, everything around them stubbed
// ---------------------------------------------------------------------------
const HEADS = {
	list: 'app.get("/api/messages", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	read: 'app.put("/api/messages/read", requireAuth, driverWriteLimiter, (req, res) => {',
};
const PROVIDED = ["app", "db", "console", "require", "requireAuth", "requireRole", "driverWriteLimiter",
	"loadIdWithheldFor", "currentShownLoadIdIndex", "shownLoadId", "loadKeyFor", "voiceNotes"];

let LIFTED;
try {
	LIFTED = closure(SRC, { roots: [], routes: Object.values(HEADS), provided: PROVIDED, denied: ["server", "httpServer", "sheets"] }).text;
} catch (e) {
	die(`the message routes could not be lifted: ${e.message}`);
}

function mount(db) {
	const handlers = new Map();
	const reg = (method) => (p, ...fns) => handlers.set(`${method} ${p}`, fns[fns.length - 1]);
	const env = {
		app: { get: reg("GET"), put: reg("PUT"), post: reg("POST"), delete: reg("DELETE") },
		db,
		console: { log() {}, warn() {}, error() {} },
		require,
		requireAuth: () => {},
		requireRole: () => () => {},
		driverWriteLimiter: () => {},
		// The per-role Load ID split (#549) is not this runner's subject: every
		// load reads as stored.
		loadIdWithheldFor: (req) => req.session.user.role !== "Super Admin",
		currentShownLoadIdIndex: () => null,
		shownLoadId: (req, raw) => raw,
		// Nor are the withheld-load keys (scripts/test-withheld-load-key-routes.js): none served.
		loadKeyFor: () => "",
		voiceNotes: { VOICE_FILE_RE: /^vn-[a-z0-9]+\.m4a$/ },
	};
	const names = Object.keys(env);
	new Function(...names, `"use strict";\n${LIFTED}`)(...names.map((k) => env[k]));
	const list = handlers.get("GET /api/messages");
	const read = handlers.get("PUT /api/messages/read");
	if (typeof list !== "function" || typeof read !== "function") die("the lifted routes registered no handler");
	const call = (handler, user, body) => {
		const out = { status: 200, body: null };
		const res = {
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; return this; },
			end() { return this; },
		};
		handler({ body: body || {}, query: {}, params: {}, session: { user } }, res);
		return out;
	};
	return {
		list: (user) => call(list, user),
		markRead: (user, messageIds) => call(read, user, { messageIds }),
	};
}

// unread per conversation, keyed by the conversation's name and load.
function unreadBy(r) {
	const out = {};
	for (const c of (r.body && r.body.conversations) || []) out[`${c.driver}|${c.loadId}`] = c.unread;
	return out;
}
const isRead = (db, id) => db.prepare("SELECT read FROM messages WHERE id = ?").get(id).read === 1;

// ---------------------------------------------------------------------------
// §1 the unread count covers both desks
// ---------------------------------------------------------------------------
function section1() {
	console.log("§1 GET /api/messages: unread counts messages to either staff desk");
	const db = makeDb();
	const m = mount(db);
	// The driver's thread, as before.
	addMessage(db, DRIVER, "Dispatch", "At the shipper", { loadId: "L-100" });
	addMessage(db, "Dispatch", DRIVER, "Call when loaded", { loadId: "L-100" });
	// The investor's thread: two unread to "admin", one already read, one in
	// another letter case, and staff's reply (to the investor, not counted).
	addMessage(db, INVESTOR, "admin", "Question about my statement");
	addMessage(db, INVESTOR, "admin", "And one more");
	addMessage(db, INVESTOR, "admin", "Read earlier", { read: 1 });
	addMessage(db, INVESTOR, "Admin", "Older spelling");
	addMessage(db, "Dispatch", INVESTOR, "Statement attached");
	// A second investor whose only message is read.
	addMessage(db, INVESTOR_2, "admin", "Thanks", { read: 1 });
	// Look-alike names that are no desk.
	addMessage(db, "Orrin Cade", "admin2", "not a desk");
	addMessage(db, "Orrin Cade", "administrator", "not a desk either");

	{
		const r = m.list(U.sa);
		eq("§1 Super Admin: 200", r.status, 200);
		const u = unreadBy(r);
		eq("§1 Super Admin: the driver's message to \"Dispatch\" counts, as before", u[`${DRIVER}|L-100`], 1);
		eq("§1 Super Admin: the investor's three unread messages to \"admin\" count (any case; the read one and staff's reply do not)", u[`${INVESTOR}|`], 3);
		eq("§1 Super Admin: an investor whose only message is read counts 0", u[`${INVESTOR_2}|`], 0);
		eq("§1 Super Admin: a look-alike desk name counts 0", u["Orrin Cade|"], 0);
		const total = Object.values(u).reduce((s, n) => s + n, 0);
		eq("§1 Super Admin: the inbox total is 4", total, 4);
	}
	{
		const r = m.list(U.disp);
		eq("§1 Dispatcher: 200", r.status, 200);
		const u = unreadBy(r);
		eq("§1 Dispatcher: the driver's message to \"Dispatch\" counts, as before", u[`${DRIVER}|L-100`], 1);
		eq("§1 Dispatcher: no investor's conversation is listed or counted", [u[`${INVESTOR}|`], u[`${INVESTOR_2}|`]], [undefined, undefined]);
		eq("§1 Dispatcher: a look-alike desk name counts 0", u["Orrin Cade|"], 0);
		const total = Object.values(u).reduce((s, n) => s + n, 0);
		eq("§1 Dispatcher: the inbox total is the dispatch desk's, 1", total, 1);
	}
}

// ---------------------------------------------------------------------------
// §2 opening the conversation clears it
// ---------------------------------------------------------------------------
function section2() {
	console.log("§2 PUT /api/messages/read clears the investor's count for a Super Admin only");
	{
		const db = makeDb();
		const m = mount(db);
		const a = addMessage(db, INVESTOR, "admin", "Question about my statement");
		const b = addMessage(db, INVESTOR, "admin", "And one more");
		const drv = addMessage(db, DRIVER, "Dispatch", "At the shipper");

		// Neither the investor, a driver nor a Dispatcher can clear the desk's
		// unread investor messages.
		eq("§2 an Investor marking his own \"admin\" messages: 200", m.markRead(U.inv, [a, b]).status, 200);
		ok("§2 ...they stay unread (not addressed to him)", !isRead(db, a) && !isRead(db, b));
		m.markRead(U.drv, [a, b]);
		ok("§2 a Driver cannot mark them either", !isRead(db, a) && !isRead(db, b));
		eq("§2 a Dispatcher marking them: 200", m.markRead(U.disp, [a, b]).status, 200);
		ok("§2 ...they stay unread (an investor conversation is Super Admin only)", !isRead(db, a) && !isRead(db, b));
		eq("§2 the Super Admin's count is still 2", unreadBy(m.list(U.sa))[`${INVESTOR}|`], 2);

		eq("§2 Super Admin marks the investor's \"admin\" messages: 200", m.markRead(U.sa, [a, b]).status, 200);
		ok("§2 Super Admin: both are read", isRead(db, a) && isRead(db, b));
		const after = unreadBy(m.list(U.sa));
		eq("§2 Super Admin: the investor's conversation counts 0", after[`${INVESTOR}|`], 0);
		eq("§2 Super Admin: the driver's conversation is untouched", after[`${DRIVER}|`], 1);
		ok("§2 Super Admin: the driver's message is still unread", !isRead(db, drv));

		eq("§2 a Dispatcher marks the driver's message: 200", m.markRead(U.disp, [drv]).status, 200);
		ok("§2 ...it is read, as before", isRead(db, drv));
		eq("§2 ...the Dispatcher's inbox counts 0", unreadBy(m.list(U.disp))[`${DRIVER}|`], 0);
	}
}

section1();
section2();

if (failed) {
	console.log(`\n${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("\nall checks passed");
