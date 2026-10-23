#!/usr/bin/env node
/**
 * scripts/test-investor-chats-super-admin-only.js — investor conversations are
 * Super Admin only (P1, Arvin 2026-10-22).
 *
 * An investor conversation is every message with the investor desk ("admin")
 * or an Investor account's username on either side, trimmed and in any letter
 * case (server.js INVESTOR_CHAT_SQL). Super Admins read them and the investor
 * reads his own; a Dispatcher reads none. Driver <-> Dispatch conversations stay
 * as they were for him.
 *
 *   §1 GET /api/messages: a Dispatcher's list holds no investor conversation and
 *      its unread total is the dispatch desk's; a Super Admin's lists and counts
 *      both desks, as before.
 *   §2 GET /api/messages/:driverName: a Dispatcher asking for an investor's name
 *      or the investor desk (any case, edge spaces) gets 404 and no message; a
 *      staff name's thread and the desk's are served without their investor
 *      messages; a driver's thread as before, its voice note playable. A Super
 *      Admin gets the investor's thread whole. No row carries investor_chat.
 *   §3 PUT /api/messages/read: a Dispatcher's mark leaves an investor's messages
 *      unread and marks a driver's; a Super Admin marks the investor's.
 *   §4 GET /api/messages/:id/voice: a Dispatcher is 404 on an investor
 *      conversation's voice note and plays a driver's; a Super Admin and that
 *      investor play it; another investor is 404.
 *   §5 /uploads/chat/, the guard as server.js builds it: a Dispatcher is 404 on a
 *      file sent in an investor conversation and opens a driver's (the first
 *      message naming the file decides); a Super Admin and that investor open it.
 *   §6 POST /api/messages, the live copy, delivered to sockets in the rooms
 *      `register` joins: an investor's message and every staff message to an
 *      investor or the investor desk reach the parties and the Super Admins, never
 *      a Dispatcher (his own name's room included), each socket once. A driver's
 *      message and Dispatch's to a driver reach the Dispatcher as before. A
 *      Dispatcher's own send to an investor or the investor desk is refused (403
 *      MESSAGE_RECIPIENT): no row, no notification, no live copy.
 *   §7 the investor still reads his own thread (GET /api/investor/messages).
 *   §8 the rule's desk is the investor portal's desk (CHAT_DESK_BY_ROLE), and
 *      no desk's name is ever read as an investor's username.
 *   §9 a legacy Investor account named like the dispatch desk leaves the
 *      driver's conversations with Dispatch as they were.
 *
 * Every route is lifted from server.js with each declaration it reaches
 * (scripts/lib/server-lift.js) over an in-memory SQLite; notifications, sockets
 * and audit are recording stubs. Made-up names only. No network, no app.db.
 * Run: node scripts/test-investor-chats-super-admin-only.js
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { closure } = require("./lib/server-lift");

let failed = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 300)}`}`); }
};
const eq = (name, got, want) => ok(`${name} (want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want), got);
const die = (msg) => { console.error(`FAIL  ${msg}`); process.exit(1); };

const ROOT = path.join(__dirname, "..");
let Database, chatFiles, voiceNotes;
try {
	Database = require("better-sqlite3");
	chatFiles = require(path.join(ROOT, "lib", "chat-files"));
	voiceNotes = require(path.join(ROOT, "lib", "voice-notes"));
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const DRIVER = "Tamsin Vale";
const INVESTOR = "inv_t";
const INVESTOR_2 = "inv_u";
const U = {
	sa: { id: 1, role: "Super Admin", username: "boss_t", driverName: "" },
	disp: { id: 2, role: "Dispatcher", username: "desk_t", driverName: "" },
	drv: { id: 10, role: "Driver", username: "drv_a", driverName: DRIVER },
	inv: { id: 50, role: "Investor", username: INVESTOR, driverName: "" },
	inv2: { id: 51, role: "Investor", username: INVESTOR_2, driverName: "" },
};
const VOICE_DRIVER = "vn_8_0123456789abcdef.m4a";
const VOICE_INVESTOR = "vn_9_fedcba9876543210.m4a";
const FILE_INV = "chat_1788000000005_eeeee.pdf";   // first sent by the investor to "admin"
const FILE_DRV = "chat_1788000000001_aaaaa.pdf";   // first sent by Dispatch to the driver
const FILE_DRV_LATER_INV = "chat_1788000000002_bbbbb.pdf"; // first in the driver's thread, later named in an investor's
const FILE_INV_LATER_DRV = "chat_1788000000003_ccccc.pdf"; // first in an investor's thread, later named in the driver's
const C = (name) => `/uploads/chat/${name}`;

function makeDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL DEFAULT '',
		role TEXT NOT NULL, driver_name TEXT DEFAULT '', email TEXT DEFAULT '', full_name TEXT DEFAULT '', company_name TEXT DEFAULT '',
		must_change_password INTEGER DEFAULT 0)`);
	db.exec("CREATE TABLE drivers_directory (id INTEGER PRIMARY KEY AUTOINCREMENT, driver_name TEXT COLLATE NOCASE UNIQUE)");
	db.exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, "from" TEXT NOT NULL, "to" TEXT NOT NULL,
		message TEXT NOT NULL, load_id TEXT DEFAULT '', read INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		asset_ref TEXT DEFAULT '', attachment_url TEXT DEFAULT '', attachment_type TEXT DEFAULT '',
		sender_user_id INTEGER, client_key TEXT, party_user_id INTEGER, voice_file TEXT DEFAULT '', voice_duration_ms INTEGER DEFAULT 0,
		voice_bytes INTEGER DEFAULT 0)`);
	db.exec(chatFiles.CHAT_UPLOADS_SCHEMA_SQL);
	const add = db.prepare("INSERT INTO users (id, username, role, driver_name) VALUES (?, ?, ?, ?)");
	for (const u of Object.values(U)) add.run(u.id, u.username, u.role, u.driverName);
	db.prepare("INSERT INTO drivers_directory (driver_name) VALUES (?)").run(DRIVER);
	return db;
}

let clock = 0;
function addMessage(db, from, to, message, { loadId = "", read = 0, url = "", type = "", voice = "", party = null, ms = 0 } = {}) {
	clock++;
	const ts = `2026-10-22T1${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, "0")}:00.000Z`;
	return Number(db.prepare(`INSERT INTO messages (timestamp, "from", "to", message, load_id, read, attachment_url, attachment_type, voice_file, party_user_id, voice_duration_ms)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ts, from, to, message, loadId, read, url, type, voice, party, ms).lastInsertRowid);
}

// Every kind of row the inbox holds. Returns the ids by name.
function seed(db) {
	const id = {};
	id.drvToDesk = addMessage(db, DRIVER, "Dispatch", "At the shipper", { loadId: "L-100" });
	id.deskToDrv = addMessage(db, "Dispatch", DRIVER, "Call when loaded", { loadId: "L-100" });
	id.invToAdmin = addMessage(db, INVESTOR, "admin", "Question about my statement");
	id.invToAdminCase = addMessage(db, INVESTOR, "Admin", "Older spelling");
	id.deskToInv = addMessage(db, "Dispatch", INVESTOR, "Statement attached");
	id.saToInvCase = addMessage(db, U.sa.username, "INV_T", "Your payout went out");
	id.inv2Read = addMessage(db, INVESTOR_2, "admin", "Thanks", { read: 1 });
	id.drvVoice = addMessage(db, DRIVER, "Dispatch", "Voice note (0:04)", { type: "voice", voice: VOICE_DRIVER, party: U.drv.id, ms: 4200 });
	id.invVoice = addMessage(db, INVESTOR, "admin", "Voice note (0:05)", { type: "voice", voice: VOICE_INVESTOR, party: U.inv.id, ms: 5100 });
	id.invFile = addMessage(db, INVESTOR, "admin", "My statement", { url: C(FILE_INV), type: "file" });
	id.drvFile = addMessage(db, "Dispatch", DRIVER, "Your rate con", { url: C(FILE_DRV), type: "file" });
	id.saToDesk = addMessage(db, U.sa.username, "admin", "Testing the investor chat", { read: 1 });
	id.dispToInv = addMessage(db, U.disp.username, "Inv_T", "An older reply under his own name");
	id.drvFileFirst = addMessage(db, "Dispatch", DRIVER, "Shared file", { url: C(FILE_DRV_LATER_INV), type: "file" });
	id.invFileLater = addMessage(db, INVESTOR, "admin", "Same file again", { url: C(FILE_DRV_LATER_INV), type: "file" });
	id.invFileFirst = addMessage(db, INVESTOR, "admin", "Another file", { url: C(FILE_INV_LATER_DRV), type: "file" });
	id.drvFileLater = addMessage(db, "Dispatch", DRIVER, "Same file again", { url: C(FILE_INV_LATER_DRV), type: "file" });
	return id;
}

// ---------------------------------------------------------------------------
// The routes as shipped, everything around them stubbed
// ---------------------------------------------------------------------------
const HEADS = {
	list: 'app.get("/api/messages", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	thread: 'app.get("/api/messages/:driverName", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	read: 'app.put("/api/messages/read", requireAuth, driverWriteLimiter, (req, res) => {',
	voice: 'app.get("/api/messages/:id/voice", requireAuth, voiceNotePlaybackLimiter, uploadMissLimiter, (req, res) => {',
	send: 'app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {',
	investorThread: 'app.get("/api/investor/messages", requireRole("Super Admin", "Investor"), (req, res) => {',
};
const PROVIDED = ["app", "db", "path", "DATA_DIR", "console", "require", "requireAuth", "requireRole", "driverWriteLimiter",
	"voiceNotePlaybackLimiter", "uploadMissLimiter", "chatFiles", "voiceNotes", "insertNotification", "io", "shownLoadId",
	"emitDispatchByRole", "logAudit", "logAuditRefusal", "loadIdWithheldFor", "currentShownLoadIdIndex", "loadKeyFor",
	"resolvePreviewUser"];

let LIFTED;
try {
	LIFTED = closure(SRC, { roots: ["chatAttachmentGuard"], routes: Object.values(HEADS), provided: PROVIDED, denied: ["server", "httpServer", "sheets"] }).text;
} catch (e) {
	die(`the message routes could not be lifted: ${e.message}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "investor-chats-"));
const CHAT_DIR = path.join(TMP, "uploads", "chat");
fs.mkdirSync(CHAT_DIR, { recursive: true });
for (const f of [FILE_INV, FILE_DRV, FILE_DRV_LATER_INV, FILE_INV_LATER_DRV]) {
	fs.writeFileSync(path.join(CHAT_DIR, f), Buffer.from("%PDF-1.4\n% made-up attachment\n%%EOF\n", "latin1"));
}

// The sockets of each account, in the rooms `register` joins for its role
// (server.js io.on("connection")): staff the dispatch room, a Super Admin also
// the super-admin room, each his own name's user room; an investor the investor
// room and his user room; a driver his driver room.
const SOCKETS = {
	sa: ["dispatch", "super-admin", `user:${U.sa.username}`],
	disp: ["dispatch", `user:${U.disp.username}`],
	inv: ["investor", `user:${INVESTOR}`],
	inv2: ["investor", `user:${INVESTOR_2}`],
	drv: [`driver:${DRIVER.toLowerCase()}`],
};

function mount(db) {
	const handlers = new Map();
	const reg = (method) => (p, ...fns) => handlers.set(`${method} ${p}`, fns[fns.length - 1]);
	const log = { emits: [], notifications: [] };
	const io = {
		to: (rooms) => ({
			emit: (event, payload) => log.emits.push({ rooms: [].concat(rooms), except: [], event, payload }),
			except: (ex) => ({ emit: (event, payload) => log.emits.push({ rooms: [].concat(rooms), except: [].concat(ex), event, payload }) }),
		}),
	};
	const env = {
		app: { get: reg("GET"), put: reg("PUT"), post: reg("POST"), delete: reg("DELETE") },
		db,
		path,
		DATA_DIR: TMP,
		console: { log() {}, warn() {}, error() {} },
		require,
		requireAuth: () => {},
		requireRole: () => () => {},
		driverWriteLimiter: () => {},
		voiceNotePlaybackLimiter: () => {},
		uploadMissLimiter: () => {},
		chatFiles,
		voiceNotes,
		insertNotification: { run: (...args) => { log.notifications.push(args); return { lastInsertRowid: log.notifications.length }; } },
		io,
		// The per-role Load ID split (#549) is not this runner's subject: every
		// load reads as stored, and no load key is served.
		shownLoadId: (who, raw) => raw,
		// As server.js's, with broker-contact value redaction on (production).
		emitDispatchByRole: (event, full, redacted) => {
			io.to("super-admin").emit(event, full);
			io.to("dispatch").except("super-admin").emit(event, redacted);
		},
		logAudit: () => {},
		logAuditRefusal: () => {},
		loadIdWithheldFor: (req) => req.session.user.role !== "Super Admin",
		currentShownLoadIdIndex: () => null,
		loadKeyFor: () => "",
		resolvePreviewUser: (req) => ({ targetMissing: false, effectiveUsername: req.session.user.username, isPreview: false }),
	};
	const names = Object.keys(env);
	const built = new Function(...names, `"use strict";\n${LIFTED}\nreturn { chatAttachmentGuard };`)(...names.map((k) => env[k]));
	const call = async (key, user, { body = {}, params = {}, query = {} } = {}) => {
		const handler = handlers.get(key);
		if (typeof handler !== "function") die(`the lifted ${key} registered no handler`);
		const out = { status: 200, body: null, file: null };
		const res = {
			headersSent: false,
			status(c) { out.status = c; return this; },
			json(b) { out.body = b; return this; },
			end() { return this; },
			setHeader() {},
			sendFile(name, opts, cb) { out.file = name; if (cb) cb(); return this; },
		};
		await handler({ body, params, query, session: { user }, headers: {}, ip: "127.0.0.1", get: () => "" }, res);
		return out;
	};
	const guard = async (user, file) => {
		const out = { status: 200, next: false };
		const res = {
			headersSent: false, destroyed: false, writableEnded: false,
			status(c) { out.status = c; return this; },
			end() { return this; },
			json() { return this; },
			setHeader() {},
			once() {},
		};
		await built.chatAttachmentGuard({ method: "GET", session: { user } }, res, () => { out.next = true; }, C(file), file);
		return out;
	};
	return {
		log,
		list: (user) => call("GET /api/messages", user),
		thread: (user, name, query) => call("GET /api/messages/:driverName", user, { params: { driverName: encodeURIComponent(name) }, query: query || {} }),
		markRead: (user, messageIds) => call("PUT /api/messages/read", user, { body: { messageIds } }),
		voice: (user, id) => call("GET /api/messages/:id/voice", user, { params: { id: String(id) } }),
		send: (user, body) => call("POST /api/messages", user, { body }),
		investorThread: (user) => call("GET /api/investor/messages", user),
		guard,
	};
}

const conversationsOf = (r) => (r.body && r.body.conversations) || [];
const unreadBy = (r) => Object.fromEntries(conversationsOf(r).map((c) => [`${c.driver}|${c.loadId}`, c.unread]));
const totalUnread = (r) => conversationsOf(r).reduce((s, c) => s + c.unread, 0);
const isRead = (db, id) => db.prepare("SELECT read FROM messages WHERE id = ?").get(id).read === 1;
const INVESTOR_SIDE = new Set([INVESTOR, INVESTOR_2, "inv_t", "admin", U.sa.username, U.disp.username].map((n) => n.toLowerCase()));

// ---------------------------------------------------------------------------
// §1 the inbox list and its unread count
// ---------------------------------------------------------------------------
async function section1() {
	console.log("§1 GET /api/messages");
	const db = makeDb();
	seed(db);
	const m = mount(db);

	const d = await m.list(U.disp);
	eq("§1 Dispatcher: 200", d.status, 200);
	const dNames = conversationsOf(d).map((c) => c.driver.trim().toLowerCase());
	ok("§1 Dispatcher: no investor conversation is listed (an investor, the desk, a staff name's reply to one)",
		dNames.length > 0 && dNames.every((n) => !INVESTOR_SIDE.has(n)), dNames);
	ok("§1 Dispatcher: no conversation's last line is an investor's message",
		conversationsOf(d).every((c) => !/statement|payout|investor chat|older reply|voice note \(0:05\)/i.test(c.lastText)), conversationsOf(d).map((c) => c.lastText));
	const du = unreadBy(d);
	eq("§1 Dispatcher: the driver's load conversation counts its unread message to \"Dispatch\", as before", du[`${DRIVER}|L-100`], 1);
	eq("§1 Dispatcher: the driver's other conversation counts his voice note", du[`${DRIVER}|`], 1);
	eq("§1 Dispatcher: the inbox total is the dispatch desk's only (2)", totalUnread(d), 2);

	const s = await m.list(U.sa);
	eq("§1 Super Admin: 200", s.status, 200);
	const su = unreadBy(s);
	eq("§1 Super Admin: the investor's conversation is listed with its six unread messages to \"admin\"", su[`${INVESTOR}|`], 6);
	eq("§1 Super Admin: the read investor's conversation is listed, 0 unread", su[`${INVESTOR_2}|`], 0);
	eq("§1 Super Admin: the driver's conversations as before", [su[`${DRIVER}|L-100`], su[`${DRIVER}|`]], [1, 1]);
	eq("§1 Super Admin: the inbox total counts both desks (8)", totalUnread(s), 8);
}

// ---------------------------------------------------------------------------
// §2 the thread
// ---------------------------------------------------------------------------
async function section2() {
	console.log("§2 GET /api/messages/:driverName");
	const db = makeDb();
	const id = seed(db);
	const m = mount(db);

	for (const name of [INVESTOR, " INV_T ", INVESTOR_2, "admin", "Admin"]) {
		const r = await m.thread(U.disp, name);
		ok(`§2 Dispatcher asking for ${JSON.stringify(name)}: 404 and no message (got ${r.status})`,
			r.status === 404 && !(r.body && Array.isArray(r.body.messages)));
	}
	const asked = await m.thread(U.disp, INVESTOR, { loadId: "L-100" });
	ok(`§2 Dispatcher asking for the investor with a load: 404 (got ${asked.status})`, asked.status === 404);

	const idsOf = (r) => ((r.body && r.body.messages) || []).map((x) => x.id);
	const staffSa = await m.thread(U.disp, U.sa.username);
	eq("§2 Dispatcher: a Super Admin's name's thread holds none of his investor messages", [staffSa.status, idsOf(staffSa)], [200, []]);
	const own = await m.thread(U.disp, U.disp.username);
	eq("§2 Dispatcher: his own name's thread holds none of his old replies to an investor", [own.status, idsOf(own)], [200, []]);
	const desk = await m.thread(U.disp, "Dispatch");
	ok("§2 Dispatcher: the \"Dispatch\" thread holds the driver's messages and none to an investor",
		desk.status === 200 && idsOf(desk).includes(id.drvToDesk) && !idsOf(desk).includes(id.deskToInv), idsOf(desk));

	const drv = await m.thread(U.disp, DRIVER);
	eq("§2 Dispatcher: the driver's thread as before", idsOf(drv), [id.drvToDesk, id.deskToDrv, id.drvVoice, id.drvFile, id.drvFileFirst, id.drvFileLater]);
	const vrow = ((drv.body && drv.body.messages) || []).find((x) => x.id === id.drvVoice);
	ok("§2 Dispatcher: the driver's voice note is playable in his thread", !!vrow && vrow.voice_duration_ms === 4200, vrow);
	const drvLoad = await m.thread(U.disp, DRIVER, { loadId: "L-100" });
	eq("§2 Dispatcher: the driver's load thread as before", idsOf(drvLoad), [id.drvToDesk, id.deskToDrv]);

	const sa = await m.thread(U.sa, INVESTOR);
	ok("§2 Super Admin: the investor's thread whole (his messages, Dispatch's and staff's replies)",
		sa.status === 200 && [id.invToAdmin, id.invToAdminCase, id.deskToInv, id.saToInvCase, id.invVoice, id.dispToInv].every((x) => idsOf(sa).includes(x)), idsOf(sa));
	const savoice = ((sa.body && sa.body.messages) || []).find((x) => x.id === id.invVoice);
	ok("§2 Super Admin: the investor's voice note is playable", !!savoice && savoice.voice_duration_ms === 5100, savoice);
	const all = [...((sa.body && sa.body.messages) || []), ...((drv.body && drv.body.messages) || [])];
	ok("§2 no thread row carries investor_chat or party_user_id", all.length > 0 && all.every((x) => !("investor_chat" in x) && !("party_user_id" in x)));
}

// ---------------------------------------------------------------------------
// §3 marking read
// ---------------------------------------------------------------------------
async function section3() {
	console.log("§3 PUT /api/messages/read");
	const db = makeDb();
	const id = seed(db);
	const m = mount(db);
	eq("§3 Dispatcher marking a driver's and an investor's messages: 200",
		(await m.markRead(U.disp, [id.drvToDesk, id.invToAdmin, id.invToAdminCase, id.invVoice])).status, 200);
	ok("§3 ...the driver's message is read", isRead(db, id.drvToDesk));
	ok("§3 ...the investor's stay unread", !isRead(db, id.invToAdmin) && !isRead(db, id.invToAdminCase) && !isRead(db, id.invVoice));
	eq("§3 ...the Super Admin's count of the investor's conversation is still 6", unreadBy(await m.list(U.sa))[`${INVESTOR}|`], 6);
	eq("§3 Super Admin marking the investor's: 200", (await m.markRead(U.sa, [id.invToAdmin, id.invToAdminCase])).status, 200);
	ok("§3 ...they are read", isRead(db, id.invToAdmin) && isRead(db, id.invToAdminCase));
	eq("§3 ...the investor's conversation counts 4", unreadBy(await m.list(U.sa))[`${INVESTOR}|`], 4);
}

// ---------------------------------------------------------------------------
// §4 voice notes
// ---------------------------------------------------------------------------
async function section4() {
	console.log("§4 GET /api/messages/:id/voice");
	const db = makeDb();
	const id = seed(db);
	const m = mount(db);
	const played = (r) => r.status === 200 && !!r.file;
	const refused = (r) => r.status === 404 && !r.file;
	ok("§4 Dispatcher: an investor conversation's voice note is 404", refused(await m.voice(U.disp, id.invVoice)));
	ok("§4 Dispatcher: a driver's voice note plays, as before", played(await m.voice(U.disp, id.drvVoice)));
	ok("§4 Super Admin plays the investor's", played(await m.voice(U.sa, id.invVoice)));
	ok("§4 the investor plays his own", played(await m.voice(U.inv, id.invVoice)));
	ok("§4 another investor is 404", refused(await m.voice(U.inv2, id.invVoice)));
	ok("§4 the driver plays his own", played(await m.voice(U.drv, id.drvVoice)));
}

// ---------------------------------------------------------------------------
// §5 chat files
// ---------------------------------------------------------------------------
async function section5() {
	console.log("§5 /uploads/chat/ (the guard as server.js builds it)");
	const db = makeDb();
	seed(db);
	const m = mount(db);
	const opens = (r) => r.next && r.status === 200;
	const refused = (r) => !r.next && r.status === 404;
	ok("§5 Dispatcher: a file an investor sent is 404", refused(await m.guard(U.disp, FILE_INV)));
	ok("§5 Dispatcher: a file first sent in an investor conversation is 404, though the driver's thread names it later",
		refused(await m.guard(U.disp, FILE_INV_LATER_DRV)));
	ok("§5 Dispatcher: a file in the driver's thread opens, as before", opens(await m.guard(U.disp, FILE_DRV)));
	ok("§5 Dispatcher: a file first sent to the driver opens, though an investor's message names it later",
		opens(await m.guard(U.disp, FILE_DRV_LATER_INV)));
	ok("§5 Super Admin opens the investor's file", opens(await m.guard(U.sa, FILE_INV)));
	ok("§5 the investor opens his own file", opens(await m.guard(U.inv, FILE_INV)));
	ok("§5 another investor is 404", refused(await m.guard(U.inv2, FILE_INV)));
	ok("§5 the driver opens his own", opens(await m.guard(U.drv, FILE_DRV)));
}

// ---------------------------------------------------------------------------
// §6 the live copy
// ---------------------------------------------------------------------------
// The sockets an emit list reaches, with copies per socket.
function deliveries(emits) {
	const got = Object.fromEntries(Object.keys(SOCKETS).map((k) => [k, 0]));
	for (const e of emits) {
		if (e.event !== "new-message") continue;
		for (const [k, rooms] of Object.entries(SOCKETS)) {
			if (e.rooms.some((r) => rooms.includes(r)) && !e.except.some((r) => rooms.includes(r))) got[k]++;
		}
	}
	return got;
}
const receivers = (got) => Object.keys(got).filter((k) => got[k] > 0).sort();

async function section6() {
	console.log("§6 POST /api/messages: the live copy");
	const db = makeDb();
	const m = mount(db);
	const cases = [
		["an investor to the investor desk", U.inv, { to: "admin", message: "Question about my payout" }, ["inv", "sa"]],
		["a Super Admin as \"Dispatch\" to the investor", U.sa, { from: "Dispatch", to: INVESTOR, message: "Statement attached" }, ["inv", "sa"]],
		["a Super Admin under his own name to the investor desk", U.sa, { from: U.sa.username, to: "admin", message: "Testing" }, ["sa"]],
		["a Super Admin under his own name to the investor", U.sa, { from: U.sa.username, to: ` ${INVESTOR} `, message: "Hello" }, ["inv", "sa"]],
		["the driver to \"Dispatch\" (as before)", U.drv, { to: "Dispatch", message: "At the shipper" }, ["disp", "drv", "sa"]],
		["a Dispatcher as \"Dispatch\" to the driver (as before)", U.disp, { from: "Dispatch", to: DRIVER, message: "Call when loaded" }, ["disp", "drv", "sa"]],
	];
	for (const [label, user, body, want] of cases) {
		const before = m.log.emits.length;
		const r = await m.send(user, body);
		const got = deliveries(m.log.emits.slice(before));
		eq(`§6 ${label}: 200`, r.status, 200);
		eq(`§6 ${label}: reaches exactly`, receivers(got), want);
		ok(`§6 ${label}: each socket once`, Object.values(got).every((n) => n <= 1), got);
	}
	const notes = m.log.notifications.map((n) => n[0]);
	ok("§6 no message to or from an investor makes a notification for the dispatch desk",
		notes.slice(0, 4).every((to) => to !== "dispatch"), notes);
	// A Dispatcher writes to drivers only (2026-10-23): his send into an
	// investor conversation is refused before anything is written or emitted.
	const refused = [
		["a Dispatcher as \"Dispatch\" to the investor", { from: "Dispatch", to: INVESTOR, message: "Hello" }],
		["a Dispatcher under his own name to the investor", { from: U.disp.username, to: ` ${INVESTOR} `, message: "Hello" }],
		["a Dispatcher under his own name to the investor desk", { from: U.disp.username, to: "admin", message: "Hello" }],
	];
	for (const [label, body] of refused) {
		const before = { emits: m.log.emits.length, notes: m.log.notifications.length, rows: db.prepare("SELECT COUNT(*) AS n FROM messages").get().n };
		const r = await m.send(U.disp, body);
		eq(`§6 ${label}: refused`, [r.status, r.body && r.body.code], [403, "MESSAGE_RECIPIENT"]);
		ok(`§6 ${label}: no row, no notification, no live copy`,
			m.log.emits.length === before.emits && m.log.notifications.length === before.notes
			&& db.prepare("SELECT COUNT(*) AS n FROM messages").get().n === before.rows);
	}
}

// ---------------------------------------------------------------------------
// §7 the investor's own thread
// ---------------------------------------------------------------------------
async function section7() {
	console.log("§7 GET /api/investor/messages, as before");
	const db = makeDb();
	const id = seed(db);
	const m = mount(db);
	const r = await m.investorThread(U.inv);
	const ids = ((r.body && r.body.messages) || []).map((x) => x.id);
	ok("§7 the investor reads his whole thread (his messages and every staff reply)",
		r.status === 200 && [id.invToAdmin, id.invToAdminCase, id.deskToInv, id.saToInvCase, id.invVoice, id.invFile, id.dispToInv].every((x) => ids.includes(x)), ids);
	const v = ((r.body && r.body.messages) || []).find((x) => x.id === id.invVoice);
	ok("§7 ...his voice note is playable", !!v && v.voice_duration_ms === 5100, v);
}

// ---------------------------------------------------------------------------
// §8 the rule's desk is the investor portal's desk
// ---------------------------------------------------------------------------
function section8() {
	console.log("§8 the investor desk in INVESTOR_CHAT_SQL");
	let lifted = null;
	try {
		lifted = closure(SRC, { roots: ["INVESTOR_CHAT_SQL", "CHAT_DESK_BY_ROLE", "CHAT_DESK_NAMES"], provided: [] }).text;
	} catch (e) {
		ok(`§8 INVESTOR_CHAT_SQL is declared in server.js (${e.message})`, false);
		return;
	}
	const v = new Function(`"use strict";\n${lifted}\nreturn { INVESTOR_CHAT_SQL, CHAT_DESK_BY_ROLE, CHAT_DESK_NAMES };`)();
	const desk = v.CHAT_DESK_NAMES[v.CHAT_DESK_BY_ROLE.Investor];
	ok(`§8 the rule names the investor portal's desk ("${desk}") on both sides`,
		typeof desk === "string" && v.INVESTOR_CHAT_SQL.split(`= '${desk.toLowerCase()}'`).length === 3);
	const notIn = /NOT IN \(([^)]*)\)/.exec(v.INVESTOR_CHAT_SQL);
	const excluded = notIn ? notIn[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")) : [];
	ok("§8 no desk's name (CHAT_DESK_NAMES), and no blank name, is ever read as an investor's",
		excluded.length === Object.keys(v.CHAT_DESK_NAMES).length + 1 && ["", ...Object.keys(v.CHAT_DESK_NAMES)].every((k) => excluded.includes(k)), excluded);
}

// ---------------------------------------------------------------------------
// §9 a legacy Investor account holding a desk's name
// ---------------------------------------------------------------------------
// Desk names are reserved for new accounts (#589); one left from before must
// not turn every driver's message to "Dispatch" into an investor conversation.
async function section9() {
	console.log("§9 a legacy Investor account named like the dispatch desk");
	const db = makeDb();
	db.prepare("INSERT INTO users (id, username, role) VALUES (60, 'dispatch', 'Investor')").run();
	const drvToDesk = addMessage(db, DRIVER, "Dispatch", "At the shipper", { loadId: "L-200" });
	const m = mount(db);
	eq("§9 Dispatcher: the driver's conversation is still listed and counted", unreadBy(await m.list(U.disp))[`${DRIVER}|L-200`], 1);
	const t = await m.thread(U.disp, DRIVER);
	eq("§9 Dispatcher: the driver's thread is served", [t.status, ((t.body && t.body.messages) || []).map((x) => x.id)], [200, [drvToDesk]]);
	const before = m.log.emits.length;
	await m.send(U.drv, { to: "Dispatch", message: "Loaded" });
	eq("§9 the driver's next message reaches the Dispatcher live", receivers(deliveries(m.log.emits.slice(before))), ["disp", "drv", "sa"]);
}

(async () => {
	try {
		await section1();
		await section2();
		await section3();
		await section4();
		await section5();
		await section6();
		await section7();
		section8();
		await section9();
	} finally {
		fs.rmSync(TMP, { recursive: true, force: true });
	}
	if (failed) {
		console.log(`\n${failed} check(s) FAILED`);
		process.exit(1);
	}
	console.log("\nall checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
