#!/usr/bin/env node
/**
 * scripts/test-voice-note-routes.js — voice notes in Messages, through the
 * shipped server.js code (lifted with scripts/lib/server-lift.js and run on a
 * real Express app, an in-memory SQLite built from server.js's own DDL, and a
 * temp data folder).
 *
 *   §1  the migration (M1): on a database already holding messages, run twice;
 *       then two text messages are both accepted and one voice note sent twice
 *       with the same key is one row, one file, the first id
 *   §2  the flag: off, POST answers 404 FEATURE_OFF and a note already sent
 *       still plays; GET /api/auth/session says which
 *   §3  who plays a note (M2, by account id): Super Admin, Dispatcher and the
 *       driver 200; another driver, an unrelated investor, a missing id 404;
 *       signed out 401; a renamed driver still plays his; a new account given
 *       his old name gets 404
 *   §4  the response: audio/mp4, nosniff, inline, private cache, same-origin;
 *       Range bytes=0-1 answers 206 with Content-Range
 *   §5  refusals: HTML labelled audio/mp4 415, a declared 5 MB 413 before the
 *       body is read, a streamed body past 4 MB 413, 422 too long or short, no
 *       key 400, unreadable headers 400, a recipient in the query string ignored
 *   §6  recipients: a driver to another driver 403, staff to an unknown name
 *       422, staff as someone else 422, an investor to the desk 200
 *   §7  a driver whose truck is moving gets 409; a stale, future-dated or
 *       stopped fix is accepted
 *   §8  the notification reads "Voice note (0:03)"; the live copy carries the
 *       duration, and a withheld load ID reaches a Dispatcher's socket as
 *       "[contact withheld]", a Super Admin's and the driver's as stored (M5)
 *   §9  storage: storage/voice-notes/vn_<id>_<hex>.m4a, mode 0640, never under
 *       uploads/, no file name in any answer, metadata blanked
 *   §10 threads: staff, investor and driver reads carry the voice fields as the
 *       reader may play them, never voice_file or party_user_id
 *   §11 POST /api/messages refuses the voice type and a voice note's address
 *       (400 ATTACHMENT_TYPE_RESERVED)
 *   §12 the daily byte cap (429) and the free-disk refusal (507, one notice)
 *   §13 the Super Admin delete: a Dispatcher 403 and the file stays; a Super
 *       Admin removes it, the row stays, one audit row
 *   §14 the retention sweep: report only until its date, then removes old notes
 *       and unnamed files older than an hour
 *   §15 GET /api/driver/position's stoppedSinceMs and the moving gate's table
 *   §16 the label: "Voice note (0:42)"
 *
 * Made-up names and audio only. Run: node scripts/test-voice-note-routes.js
 * (an optional first argument names another server.js to lift, to show the
 * runner failing on the code before this change).
 */

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const Database = require("better-sqlite3");
const { closure } = require("./lib/server-lift");
const fx = require("./lib/voice-note-fixtures");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "server.js"), "utf8");
const appRequire = (p) => (/^\.\/lib\//.test(p) ? require(path.join(ROOT, p)) : require(p));

let failed = 0;
const ok = (name, cond, detail) => {
	if (cond) console.log(`ok    ${name}`);
	else { failed++; console.log(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 300)}`}`); }
};
const tryLib = (name) => { try { return require(path.join(ROOT, "lib", name)); } catch (err) { ok(`lib/${name}.js loads (${err.message.split("\n")[0]})`, false); return null; } };
const voiceNotes = tryLib("voice-notes");
const voiceText = tryLib("voice-note-text");
const gate = tryLib("voice-note-gate");

// ---------------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------------
const DRIVER = "Tamsin Vale";
const DRIVER_B = "Orrin Cade";
const WITHHELD_ID = "5550100163";
const CHROME = fx.chromeFixture();
const U = {
	sa: { id: 1, role: "Super Admin", username: "admin_t" },
	disp: { id: 2, role: "Dispatcher", username: "dispatch_t" },
	drv: { id: 10, role: "Driver", username: "drv_a", driverName: DRIVER },
	drvB: { id: 11, role: "Driver", username: "drv_b", driverName: DRIVER_B },
	inv: { id: 50, role: "Investor", username: "inv_t" },
	invOther: { id: 51, role: "Investor", username: "inv_u" },
};
const TRUCK_ID = 7;
const DEVICE = "dev-901";

function ddl(table) {
	const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\)`).exec(SRC);
	if (!m) throw new Error(`${table} CREATE TABLE not found in server.js`);
	return m[0];
}
const VOICE_COLUMNS = ["sender_user_id", "client_key", "party_user_id", "voice_file", "voice_duration_ms", "voice_bytes"];
const MIGRATION_MARK = "// Migration: voice notes";
function voiceMigrationBlock() {
	const at = SRC.indexOf(MIGRATION_MARK);
	if (at < 0) return null;
	const open = SRC.indexOf("\n{\n", at);
	const close = SRC.indexOf("\n}\n", open);
	return open < 0 || close < 0 ? null : SRC.slice(open + 1, close + 2);
}

// A database at today's schema (every server.js table this runner touches, with
// the ALTERs that predate voice notes), holding messages already.
function oldDb() {
	const db = new Database(":memory:");
	const tables = ["messages", "users", "audit_trail", "trucks", "truck_assignments", "routemate_telemetry", "eld_device_assignments"];
	for (const t of tables) db.exec(ddl(t));
	for (const m of SRC.matchAll(new RegExp(`ALTER TABLE (${tables.join("|")}) ADD COLUMN ([^"\`;]+)`, "g"))) {
		if (m[1] === "messages" && VOICE_COLUMNS.includes(m[2].trim().split(/\s+/)[0])) continue;
		try { db.exec(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]}`); } catch { /* already there */ }
	}
	const add = db.prepare(`INSERT INTO messages (timestamp, "from", "to", message) VALUES ('2026-10-01T12:00:00.000Z', ?, ?, ?)`);
	for (let i = 0; i < 3; i++) add.run("Dispatch", DRIVER, `dispatch note ${i}`);
	for (let i = 0; i < 2; i++) add.run(DRIVER, "Dispatch", `driver note ${i}`);
	const user = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (?, ?, 'x', ?, ?)");
	for (const u of Object.values(U)) user.run(u.id, u.username, u.role, u.driverName || null);
	db.prepare("INSERT INTO trucks (id, unit_number, routemate_vehicle_id, assigned_driver) VALUES (?, 'LogisX-#901', ?, ?)").run(TRUCK_ID, DEVICE, DRIVER);
	return db;
}
function migrate(db) {
	const block = voiceMigrationBlock();
	if (!block) throw new Error("the voice-note migration block is not in server.js");
	new Function("db", block)(db);
}

// ---------------------------------------------------------------------------
// The app: the routes as shipped, everything around them stubbed
// ---------------------------------------------------------------------------
const HEADS = {
	voicePost: 'app.post("/api/messages/voice", requireAuth, voiceNoteFeatureGate, voiceNoteUploadLimiter, voiceNoteSendChecks, readVoiceNoteBody, (req, res) => {',
	voiceGet: 'app.get("/api/messages/:id/voice", requireAuth, voiceNotePlaybackLimiter, uploadMissLimiter, (req, res) => {',
	voiceDelete: 'app.delete("/api/messages/:id/voice", requireRole("Super Admin"), voiceNoteUploadLimiter, (req, res) => {',
	textPost: 'app.post("/api/messages", requireAuth, driverWriteLimiter, (req, res) => {',
	staffThread: 'app.get("/api/messages/:driverName", requireRole("Super Admin", "Dispatcher"), (req, res) => {',
	investorThread: 'app.get("/api/investor/messages", requireRole("Super Admin", "Investor"), (req, res) => {',
	session: 'app.get("/api/auth/session", (req, res) => {',
};
const PROVIDED = [
	"app", "express", "db", "fs", "path", "DATA_DIR", "require", "console", "requireAuth", "requireRole", "io",
	"insertNotification", "insertDispatchNotification", "emitDispatchNotice", "shownLoadId", "loadIdWithheldFor",
	"currentShownLoadIdIndex", "resolvePreviewUser", "chatFiles", "driverWriteLimiter", "voiceNoteUploadLimiter",
	"voiceNotePlaybackLimiter", "startsJob", "rateLimit", "ipKeyGenerator",
];
let LIFTED = null;
let liftError = "";
try {
	LIFTED = closure(SRC, { roots: [], routes: Object.values(HEADS), provided: PROVIDED, denied: ["server", "httpServer", "sendEmail", "getSheets"] }).text;
} catch (err) {
	liftError = err.message;
}
ok("the voice-note routes lift from server.js", !!LIFTED, liftError);

const servers = [];
function buildApp({ db, dataDir, env = {} }) {
	const saved = {};
	for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
	const app = express();
	app.use((req, res, next) => {
		const raw = req.headers["x-test-user"];
		req.session = raw ? { user: JSON.parse(raw) } : {};
		next();
	});
	app.use(express.json({ limit: "50mb" }));
	const requireAuth = (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: "Not authenticated" }));
	const requireRole = (...roles) => (req, res, next) => {
		const u = req.session.user;
		if (!u) return res.status(401).json({ error: "Not authenticated" });
		if (!roles.includes(u.role)) return res.status(403).json({ error: "Forbidden" });
		next();
	};
	const pass = (req, res, next) => next();
	const emitted = [];
	const io = {
		to(rooms) {
			const rs = [].concat(rooms);
			return {
				emit: (event, payload) => emitted.push({ rooms: rs, except: [], event, payload }),
				except: (ex) => ({ emit: (event, payload) => emitted.push({ rooms: rs, except: [].concat(ex), event, payload }) }),
			};
		},
	};
	const notifications = [];
	const dispatchNotices = [];
	const logs = [];
	const quiet = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), info() {} };
	const shownLoadId = (who, raw) => {
		const role = typeof who === "string" ? who : who && who.session && who.session.user && who.session.user.role;
		return raw === WITHHELD_ID && role !== "Super Admin" ? "[contact withheld]" : raw;
	};
	const deps = {
		app, express, db, fs, path, DATA_DIR: dataDir, require: appRequire, console: quiet, requireAuth, requireRole, io,
		insertNotification: { run: (...a) => { notifications.push(a); return { lastInsertRowid: notifications.length }; } },
		insertDispatchNotification: { run: (...a) => { dispatchNotices.push(a); return { lastInsertRowid: dispatchNotices.length }; } },
		emitDispatchNotice: () => {},
		shownLoadId,
		loadIdWithheldFor: (req) => req.session.user.role !== "Super Admin",
		currentShownLoadIdIndex: () => null,
		resolvePreviewUser: (req) => ({ targetMissing: false, effectiveUsername: req.session.user.username, isPreview: req.session.user.role === "Super Admin" }),
		chatFiles: { chatAttachmentRefusal: () => "" },
		driverWriteLimiter: pass, voiceNoteUploadLimiter: pass, voiceNotePlaybackLimiter: pass,
		startsJob: () => false,
		rateLimit: () => pass, ipKeyGenerator: (ip) => ip,
	};
	if (LIFTED) {
		new Function(...PROVIDED, `"use strict";\n${LIFTED}`)(...PROVIDED.map((k) => deps[k]));
	}
	for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
	app.use((req, res) => res.status(404).json({ error: "no route" }));
	const server = http.createServer(app);
	servers.push(server);
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
		port: server.address().port, emitted, notifications, dispatchNotices, logs,
	})));
}

// One request. `opts.body` a Buffer or object (JSON); `opts.declare` sends that
// Content-Length with no body and reads the answer without finishing it.
function request(port, method, url, user, opts = {}) {
	return new Promise((resolve) => {
		const headers = { "X-Requested-With": "XMLHttpRequest", ...(opts.headers || {}) };
		if (user) headers["X-Test-User"] = JSON.stringify(user);
		let payload = null;
		if (Buffer.isBuffer(opts.body)) { payload = opts.body; headers["Content-Type"] = headers["Content-Type"] || "audio/mp4"; }
		else if (opts.body !== undefined) { payload = Buffer.from(JSON.stringify(opts.body)); headers["Content-Type"] = "application/json"; }
		if (opts.declare) headers["Content-Length"] = String(opts.declare);
		else if (payload && !opts.chunked) headers["Content-Length"] = String(payload.length);
		const req = http.request({ host: "127.0.0.1", port, method, path: url, headers, agent: false }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const body = Buffer.concat(chunks);
				let json = null;
				try { json = JSON.parse(body.toString("utf8")); } catch { json = null; }
				resolve({ status: res.statusCode, headers: res.headers, body, json });
				req.destroy();
			});
		});
		req.on("error", () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), json: null }));
		if (opts.declare) { req.flushHeaders(); return; }
		if (payload && opts.chunked) {
			for (let i = 0; i < payload.length; i += 256 * 1024) req.write(payload.subarray(i, i + 256 * 1024));
		} else if (payload) req.write(payload);
		req.end();
	});
}
const voiceHeaders = (to, key, extra = {}) => ({ "X-Message-To": encodeURIComponent(to), "Idempotency-Key": key, ...extra });
let keyN = 0;
const newKey = () => `test-key-${String(++keyN).padStart(6, "0")}`;
const files = (dataDir) => { try { return fs.readdirSync(path.join(dataDir, "storage", "voice-notes")); } catch { return []; } };
const rowOf = (db, id) => db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
function telemetry(db, { agoMs, speed }) {
	db.prepare(`INSERT INTO routemate_telemetry (routemate_vehicle_id, latitude, longitude, speed, location_date_ms) VALUES (?, 30.1, -95.2, ?, ?)`).run(DEVICE, speed, Date.now() - agoMs);
}

(async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-note-routes-"));
	const db = oldDb();
	const before = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n;

	// §1 the migration
	let migrated = false;
	try { migrate(db); migrate(db); migrated = true; } catch (err) { ok(`§1 the migration runs (${err.message})`, false); }
	if (migrated) {
		const cols = new Set(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
		ok("§1 run twice on a database holding messages: every voice column is there", VOICE_COLUMNS.every((c) => cols.has(c)));
		ok("§1 ...and every existing message kept, with client_key ''", db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_key = ''").get().n === before);
		const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_messages_client_key'").get();
		ok("§1 the duplicate-send index is unique and partial (client_key <> '')", !!idx && /UNIQUE/i.test(idx.sql) && /WHERE\s+client_key\s*<>\s*''/i.test(idx.sql));
	}
	const on = await buildApp({ db, dataDir, env: { MESSAGE_VOICE_NOTES_ENABLED: "true" } });
	const off = await buildApp({ db, dataDir, env: { MESSAGE_VOICE_NOTES_ENABLED: "" } });
	const P = on.port;

	{
		const t1 = await request(P, "POST", "/api/messages", U.drv, { body: { to: "Dispatch", message: "first text" } });
		const t2 = await request(P, "POST", "/api/messages", U.drv, { body: { to: "Dispatch", message: "second text" } });
		ok("§1 two text messages from one sender: both accepted", t1.status === 200 && t2.status === 200, [t1.status, t2.status, t1.json]);
		const key = newKey();
		const v1 = await request(P, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", key) });
		const v2 = await request(P, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", key) });
		ok("§1 a voice note is accepted", v1.status === 200 && v1.json && v1.json.success === true && v1.json.id > 0, [v1.status, v1.json]);
		ok("§1 ...sent again with the same key: the first id, marked a duplicate", v2.status === 200 && v2.json && v1.json && v2.json.id === v1.json.id && v2.json.duplicate === true, v2.json);
		ok("§1 ...one row and one file", db.prepare("SELECT COUNT(*) AS n FROM messages WHERE client_key = ?").get(key).n === 1 && files(dataDir).length === 1, files(dataDir));
	}

	// The note every later section plays: Dispatch to the driver.
	const sent = await request(P, "POST", "/api/messages/voice", U.disp, { body: CHROME, headers: voiceHeaders(DRIVER, newKey()) });
	const NOTE = sent.json && sent.json.id;
	ok("§3 staff send a voice note to a driver (200)", sent.status === 200 && NOTE > 0, [sent.status, sent.json]);
	ok("§3 ...the note belongs to the driver's account (party_user_id)", NOTE > 0 && rowOf(db, NOTE).party_user_id === U.drv.id && rowOf(db, NOTE).sender_user_id === U.disp.id);
	ok("§3 ...measured 3.16 s", NOTE > 0 && Math.abs(rowOf(db, NOTE).voice_duration_ms - 3160) <= 50, NOTE > 0 && rowOf(db, NOTE).voice_duration_ms);
	const play = (user, id = NOTE, port = P, headers = {}) => request(port, "GET", `/api/messages/${id}/voice`, user, { headers });

	// §2 the flag
	{
		const r = await request(off.port, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", newKey()) });
		ok("§2 flag off: POST answers 404 FEATURE_OFF", r.status === 404 && r.json && r.json.code === "FEATURE_OFF", [r.status, r.json]);
		const g = await play(U.drv, NOTE, off.port);
		ok("§2 flag off: a note already sent still plays", g.status === 200 && g.body.equals(CHROME), g.status);
		const s1 = await request(P, "GET", "/api/auth/session", U.drv);
		const s0 = await request(off.port, "GET", "/api/auth/session", U.drv);
		const anon = await request(P, "GET", "/api/auth/session", null);
		ok("§2 GET /api/auth/session: features.voiceNotes follows the flag", s1.json && s1.json.features && s1.json.features.voiceNotes === true && s0.json && s0.json.features && s0.json.features.voiceNotes === false, [s1.json && s1.json.features, s0.json && s0.json.features]);
		ok("§2 ...and a signed-out answer carries no features", anon.json && anon.json.authenticated === false && !("features" in anon.json));
	}

	// §3 who plays a note
	{
		for (const [who, u] of [["Super Admin", U.sa], ["Dispatcher", U.disp], ["the driver", U.drv]]) {
			const r = await play(u);
			ok(`§3 ${who}: 200`, r.status === 200 && r.body.length > 0, r.status);
		}
		ok("§3 another driver: 404", (await play(U.drvB)).status === 404);
		ok("§3 an unrelated investor: 404", (await play(U.inv)).status === 404);
		ok("§3 a missing id: 404", (await play(U.sa, 999999)).status === 404);
		ok("§3 an id that is not a number: 404", (await play(U.sa, "abc")).status === 404);
		ok("§3 a text message's id: 404", (await play(U.sa, 1)).status === 404);
		ok("§3 signed out: 401", (await play(null)).status === 401);
		db.prepare("UPDATE users SET driver_name = ? WHERE id = ?").run("Tamsin Vale-Okoro", U.drv.id);
		ok("§3 the driver renamed (same account): he still plays his note", (await play({ ...U.drv, driverName: "Tamsin Vale-Okoro" })).status === 200);
		db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name) VALUES (12, 'drv_new', 'x', 'Driver', ?)").run(DRIVER);
		ok("§3 a new Driver account given his old name: 404", (await play({ id: 12, role: "Driver", username: "drv_new", driverName: DRIVER })).status === 404);
		ok("§3 an investor whose username is the driver's old name: 404", (await play({ id: 52, role: "Investor", username: DRIVER })).status === 404);
		db.prepare("DELETE FROM users WHERE id = 12").run();
		db.prepare("UPDATE users SET driver_name = ? WHERE id = ?").run(DRIVER, U.drv.id);
	}

	// §4 the response
	{
		const r = await play(U.drv);
		ok("§4 Content-Type audio/mp4", /^audio\/mp4/.test(String(r.headers["content-type"])), r.headers["content-type"]);
		ok("§4 nosniff", r.headers["x-content-type-options"] === "nosniff");
		ok("§4 inline, named by the message id", r.headers["content-disposition"] === `inline; filename="voice-note-${NOTE}.m4a"`, r.headers["content-disposition"]);
		ok("§4 private cache, revalidated", r.headers["cache-control"] === "private, max-age=0, must-revalidate", r.headers["cache-control"]);
		ok("§4 Cross-Origin-Resource-Policy same-origin", r.headers["cross-origin-resource-policy"] === "same-origin");
		ok("§4 Accept-Ranges bytes", r.headers["accept-ranges"] === "bytes");
		const range = await play(U.drv, NOTE, P, { Range: "bytes=0-1" });
		ok("§4 Range bytes=0-1: 206 with Content-Range and 2 bytes", range.status === 206 && /^bytes 0-1\/\d+$/.test(String(range.headers["content-range"])) && range.body.length === 2, [range.status, range.headers["content-range"]]);
	}

	// §5 refusals
	{
		const send = (body, headers, user = U.drv, extra = {}) => request(P, "POST", "/api/messages/voice", user, { body, headers, ...extra });
		const html = await send(Buffer.from("<!doctype html><script>alert(1)</script>"), voiceHeaders("Dispatch", newKey()));
		ok("§5 HTML bytes labelled audio/mp4: 415 UNSUPPORTED_AUDIO_TYPE", html.status === 415 && html.json && html.json.code === "UNSUPPORTED_AUDIO_TYPE", [html.status, html.json]);
		const declared = await request(P, "POST", "/api/messages/voice", U.drv, { headers: { ...voiceHeaders("Dispatch", newKey()), "Content-Type": "audio/mp4" }, declare: 5 * 1024 * 1024 });
		ok("§5 a declared 5 MB: 413 VOICE_NOTE_TOO_LARGE before the body is read", declared.status === 413 && declared.json && declared.json.code === "VOICE_NOTE_TOO_LARGE", [declared.status, declared.json]);
		const streamed = await send(Buffer.concat([CHROME, Buffer.alloc(4 * 1024 * 1024)]), voiceHeaders("Dispatch", newKey()), U.drv, { chunked: true });
		ok("§5 a streamed body past 4 MB: 413", streamed.status === 413 && streamed.json && streamed.json.code === "VOICE_NOTE_TOO_LARGE", [streamed.status, streamed.json]);
		const long = await send(fx.buildPlain({ entries: [[8484, 1024]] }), voiceHeaders("Dispatch", newKey()));
		ok("§5 181 s: 422 VOICE_NOTE_TOO_LONG", long.status === 422 && long.json && long.json.code === "VOICE_NOTE_TOO_LONG", [long.status, long.json]);
		const short = await send(fx.buildPlain({ entries: [[10, 1024]] }), voiceHeaders("Dispatch", newKey()));
		ok("§5 0.2 s: 422 VOICE_NOTE_TOO_SHORT", short.status === 422 && short.json && short.json.code === "VOICE_NOTE_TOO_SHORT", [short.status, short.json]);
		const nokey = await send(CHROME, { "X-Message-To": "Dispatch" });
		ok("§5 no Idempotency-Key: 400 VOICE_NOTE_KEY_REQUIRED", nokey.status === 400 && nokey.json && nokey.json.code === "VOICE_NOTE_KEY_REQUIRED", [nokey.status, nokey.json]);
		const badHeader = await send(CHROME, { "X-Message-To": "%E0%A4%A", "Idempotency-Key": newKey() });
		ok("§5 a recipient header that is not percent-encoded UTF-8: 400 VOICE_NOTE_HEADERS", badHeader.status === 400 && badHeader.json && badHeader.json.code === "VOICE_NOTE_HEADERS", [badHeader.status, badHeader.json]);
		const query = await request(P, "POST", `/api/messages/voice?to=Dispatch&loadId=${WITHHELD_ID}`, U.drv, { body: CHROME, headers: { "Idempotency-Key": newKey() } });
		ok("§5 the recipient in the query string is ignored (400, nothing stored)", query.status === 400 && query.json && query.json.code === "VOICE_NOTE_HEADERS", [query.status, query.json]);
		const wrongType = await send(CHROME, voiceHeaders("Dispatch", newKey(), { "Content-Type": "application/octet-stream" }));
		ok("§5 the audio sent as another type: 415", wrongType.status === 415, wrongType.status);
	}

	// §6 recipients
	{
		const toB = await request(P, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders(DRIVER_B, newKey()) });
		ok("§6 a driver sending to another driver: 403 VOICE_NOTE_RECIPIENT", toB.status === 403 && toB.json && toB.json.code === "VOICE_NOTE_RECIPIENT", [toB.status, toB.json]);
		const unknown = await request(P, "POST", "/api/messages/voice", U.disp, { body: CHROME, headers: voiceHeaders("Nobody Here", newKey()) });
		ok("§6 staff to a name no account holds: 422 VOICE_NOTE_RECIPIENT", unknown.status === 422 && unknown.json && unknown.json.code === "VOICE_NOTE_RECIPIENT", [unknown.status, unknown.json]);
		const desk = await request(P, "POST", "/api/messages/voice", U.disp, { body: CHROME, headers: voiceHeaders("Dispatch", newKey()) });
		ok("§6 staff to the desk itself: 422", desk.status === 422, desk.status);
		const asOther = await request(P, "POST", "/api/messages/voice", U.disp, { body: CHROME, headers: voiceHeaders(DRIVER, newKey(), { "X-Message-From": "Someone Else" }) });
		ok("§6 staff sending as someone else: 422 VOICE_NOTE_SENDER", asOther.status === 422 && asOther.json && asOther.json.code === "VOICE_NOTE_SENDER", [asOther.status, asOther.json]);
		const inv = await request(P, "POST", "/api/messages/voice", U.inv, { body: CHROME, headers: voiceHeaders("admin", newKey()) });
		ok("§6 an investor to the desk (\"admin\"): 200, the note his", inv.status === 200 && inv.json && rowOf(db, inv.json.id).party_user_id === U.inv.id && rowOf(db, inv.json.id).from === U.inv.username, [inv.status, inv.json]);
		const toInv = await request(P, "POST", "/api/messages/voice", U.sa, { body: CHROME, headers: voiceHeaders("INV_T", newKey()) });
		ok("§6 staff to an investor (username, any case): 200, the note the investor's", toInv.status === 200 && toInv.json && rowOf(db, toInv.json.id).party_user_id === U.inv.id && rowOf(db, toInv.json.id).to === "inv_t", [toInv.status, toInv.json]);
		ok("§6 ...the investor plays it; another investor gets 404", toInv.json && (await play(U.inv, toInv.json.id)).status === 200 && (await play(U.invOther, toInv.json.id)).status === 404);
	}

	// §7 the moving truck
	{
		const send = () => request(P, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", newKey()) });
		telemetry(db, { agoMs: 30 * 1000, speed: 20 });
		const moving = await send();
		ok("§7 a fresh moving fix: 409 VOICE_NOTE_WHILE_MOVING", moving.status === 409 && moving.json && moving.json.code === "VOICE_NOTE_WHILE_MOVING", [moving.status, moving.json]);
		db.prepare("DELETE FROM routemate_telemetry").run();
		telemetry(db, { agoMs: 10 * 60 * 1000, speed: 20 });
		ok("§7 a stale moving fix (10 minutes old): accepted", (await send()).status === 200);
		db.prepare("DELETE FROM routemate_telemetry").run();
		telemetry(db, { agoMs: -5 * 60 * 1000, speed: 20 });
		ok("§7 a moving fix stamped 5 minutes in the future: accepted (unknown)", (await send()).status === 200);
		db.prepare("DELETE FROM routemate_telemetry").run();
		telemetry(db, { agoMs: 30 * 1000, speed: 0 });
		ok("§7 a fresh stopped fix: accepted", (await send()).status === 200);
		db.prepare("DELETE FROM routemate_telemetry").run();
		telemetry(db, { agoMs: 30 * 1000, speed: 20 });
		ok("§7 staff are never held by a truck's movement", (await request(P, "POST", "/api/messages/voice", U.disp, { body: CHROME, headers: voiceHeaders(DRIVER, newKey()) })).status === 200);
		db.prepare("DELETE FROM routemate_telemetry").run();
	}

	// §8 notification and live copy
	{
		on.notifications.length = 0;
		on.emitted.length = 0;
		const r = await request(P, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", newKey(), { "X-Message-Load-Id": WITHHELD_ID }) });
		ok("§8 a driver's voice note on a withheld-ID load: 200", r.status === 200, [r.status, r.json]);
		const n = on.notifications[0] || [];
		ok("§8 the notification: to the desk, \"New voice note from <driver>\", body \"Voice note (0:03)\"", n[0] === "dispatch" && n[2] === `New voice note from ${DRIVER}` && n[3] === "Voice note (0:03)", n);
		const msgs = on.emitted.filter((e) => e.event === "new-message");
		const staff = msgs.filter((e) => e.rooms.includes("dispatch") && e.except.includes("super-admin"));
		const admins = msgs.filter((e) => e.rooms.includes("super-admin"));
		const parties = msgs.filter((e) => e.except.includes("dispatch"));
		ok("§8 the rest of the dispatch room gets the load as \"[contact withheld]\", once", staff.length === 1 && staff[0].payload.loadId === "[contact withheld]", staff.map((e) => e.payload.loadId));
		ok("§8 Super Admins get it as stored, once", admins.length === 1 && admins[0].payload.loadId === WITHHELD_ID);
		ok("§8 the driver's own rooms get it as stored, without the dispatch room", parties.length === 1 && parties[0].payload.loadId === WITHHELD_ID && parties[0].rooms.some((x) => /tamsin vale/i.test(x)), parties.map((e) => e.rooms));
		ok("§8 every copy is typed voice, carries the measured duration and the label, no URL",
			msgs.length === 3 && msgs.every((e) => e.payload.attachment_type === "voice" && e.payload.voice_duration_ms > 3000 && e.payload.message === "Voice note (0:03)" && e.payload.attachment_url === ""),
			msgs.map((e) => e.payload));
		ok("§8 no copy names the stored file", msgs.every((e) => !JSON.stringify(e.payload).includes("vn_")));
	}

	// §9 storage
	{
		const names = files(dataDir);
		const row = NOTE > 0 ? rowOf(db, NOTE) : {};
		ok("§9 the file is storage/voice-notes/vn_<id>_<16 hex>.m4a", typeof row.voice_file === "string" && new RegExp(`^vn_${NOTE}_[0-9a-f]{16}\\.m4a$`).test(row.voice_file) && names.includes(row.voice_file), row.voice_file);
		const st = row.voice_file ? fs.statSync(path.join(dataDir, "storage", "voice-notes", row.voice_file)) : null;
		ok("§9 ...mode 0640", !!st && (st.mode & 0o777) === 0o640, st && (st.mode & 0o777).toString(8));
		ok("§9 nothing was written under uploads/", !fs.existsSync(path.join(dataDir, "uploads")));
		ok("§9 the answer names no file", !JSON.stringify(sent.json || {}).includes("vn_"));
		const located = fx.buildPlain({ moovExtra: [fx.box("udta", fx.box("\xa9xyz", Buffer.from("+40.7128-074.0060/", "latin1")))] });
		const lr = await request(P, "POST", "/api/messages/voice", U.drv, { body: located, headers: voiceHeaders("Dispatch", newKey()) });
		const stored = lr.json && lr.json.id ? fs.readFileSync(path.join(dataDir, "storage", "voice-notes", rowOf(db, lr.json.id).voice_file)) : Buffer.alloc(0);
		ok("§9 a file holding a location box is stored without it", lr.status === 200 && stored.length === located.length && stored.indexOf("+40.7128") < 0 && stored.indexOf("udta") < 0, lr.status);
	}

	// §10 threads
	{
		const staff = await request(P, "GET", `/api/messages/${encodeURIComponent(DRIVER)}`, U.disp);
		const note = staff.json && (staff.json.messages || []).find((m) => m.id === NOTE);
		ok("§10 staff thread: the note typed voice, its duration, no URL", !!note && note.attachment_type === "voice" && note.voice_duration_ms > 3000 && note.attachment_url === "" && note.message === "Voice note (0:03)", note);
		ok("§10 staff thread: no row carries voice_file or party_user_id", staff.json && (staff.json.messages || []).every((m) => !("voice_file" in m) && !("party_user_id" in m)));
		ok("§10 staff thread: a text message has voice_duration_ms 0", staff.json && (staff.json.messages || []).some((m) => m.attachment_type !== "voice" && m.voice_duration_ms === 0));
		const inv = await request(P, "GET", "/api/investor/messages", U.inv);
		const invNotes = inv.json ? (inv.json.messages || []).filter((m) => m.attachment_type === "voice") : [];
		ok("§10 investor thread: his notes with their durations", invNotes.length >= 2 && invNotes.every((m) => m.voice_duration_ms > 0 && !("voice_file" in m)), invNotes);
		// The driver's read (GET /api/driver/:driverName reads the sheet too): its
		// shipped SELECT, run here, through the shaping it ships with.
		const at = SRC.indexOf("// Messages from SQLite (fast indexed query)");
		const seg = at < 0 ? "" : SRC.slice(at, SRC.indexOf(".all(nameLower, nameLower)", at));
		const sql = (/`(SELECT[\s\S]*?)`/.exec(seg) || [])[1] || "";
		ok("§10 driver thread: the shipped SELECT reads the voice columns and goes through voiceThreadRows()", /voice_duration_ms/.test(sql) && /party_user_id/.test(sql) && /voiceNotes\.voiceThreadRows\(req\.session\.user/.test(seg), sql);
		if (sql && voiceNotes) {
			const rows = db.prepare(sql).all(DRIVER.toLowerCase(), DRIVER.toLowerCase());
			const own = voiceNotes.voiceThreadRows(U.drv, rows).find((m) => m.id === NOTE);
			const other = voiceNotes.voiceThreadRows({ id: 12, role: "Driver", driverName: DRIVER }, rows).find((m) => m.id === NOTE);
			ok("§10 driver thread: the driver gets his note's duration", !!own && own.voice_duration_ms > 3000 && !("voice_file" in own));
			ok("§10 driver thread: another account reading by the same name sees \"Voice note (unavailable)\", no duration", !!other && other.voice_duration_ms === 0 && other.message === "Voice note (unavailable)", other);
		}
	}

	// §11 the text route keeps the voice type for the server
	{
		const t = (body) => request(P, "POST", "/api/messages", U.drv, { body: { to: "Dispatch", message: "hello", ...body } });
		for (const [what, body] of [["attachmentType \"voice\"", { attachmentType: "voice" }], ["attachmentType \" Voice \"", { attachmentType: " Voice " }],
			["a voice note's address", { attachmentUrl: `/api/messages/${NOTE}/voice`, attachmentType: "pdf" }], ["...in capitals", { attachmentUrl: `/API/Messages/${NOTE}/voice` }]]) {
			const r = await t(body);
			ok(`§11 POST /api/messages with ${what}: 400 ATTACHMENT_TYPE_RESERVED`, r.status === 400 && r.json && r.json.code === "ATTACHMENT_TYPE_RESERVED", [r.status, r.json]);
		}
		const plain = await t({});
		ok("§11 a plain text message still sends, outside the duplicate-send index", plain.status === 200 && rowOf(db, plain.json.id).client_key === "" && rowOf(db, plain.json.id).attachment_type === "", plain.json);
	}

	// §12 the daily cap and the disk
	{
		const capDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-note-cap-"));
		const capDb = oldDb();
		migrate(capDb);
		const capped = await buildApp({ db: capDb, dataDir: capDir, env: { MESSAGE_VOICE_NOTES_ENABLED: "true", VOICE_NOTE_DAILY_MB: "0.012" } });
		const s = () => request(capped.port, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", newKey()) });
		const first = await s();
		const second = await s();
		ok("§12 under the daily cap: accepted", first.status === 200, first.status);
		ok("§12 the note that would pass it: 429 VOICE_NOTE_DAILY_LIMIT, nothing stored", second.status === 429 && second.json && second.json.code === "VOICE_NOTE_DAILY_LIMIT" && files(capDir).length === 1, [second.status, second.json]);
		const lowDb = oldDb();
		migrate(lowDb);
		const low = await buildApp({ db: lowDb, dataDir: capDir, env: { MESSAGE_VOICE_NOTES_ENABLED: "true", VOICE_NOTE_MIN_FREE_GB: "1000000000" } });
		const l1 = await request(low.port, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", newKey()) });
		const l2 = await request(low.port, "POST", "/api/messages/voice", U.drv, { body: CHROME, headers: voiceHeaders("Dispatch", newKey()) });
		ok("§12 too little free disk: 507 STORAGE_LOW", l1.status === 507 && l1.json && l1.json.code === "STORAGE_LOW" && l2.status === 507, [l1.status, l1.json]);
		ok("§12 ...and staff get one notice a day about it", low.dispatchNotices.length === 1 && low.dispatchNotices[0][0] === "voice-note-storage-low", low.dispatchNotices.length);
		fs.rmSync(capDir, { recursive: true, force: true });
	}

	// §13 the Super Admin delete
	{
		const victim = await request(P, "POST", "/api/messages/voice", U.disp, { body: CHROME, headers: voiceHeaders(DRIVER, newKey()) });
		const id = victim.json && victim.json.id;
		const file = id ? rowOf(db, id).voice_file : "";
		const filePath = path.join(dataDir, "storage", "voice-notes", file || "none");
		const asDisp = await request(P, "DELETE", `/api/messages/${id}/voice`, U.disp);
		ok("§13 a Dispatcher: 403, and the file stays", asDisp.status === 403 && fs.existsSync(filePath), asDisp.status);
		const asSa = await request(P, "DELETE", `/api/messages/${id}/voice`, U.sa);
		const row = id ? rowOf(db, id) : {};
		ok("§13 a Super Admin: 200, the file gone", asSa.status === 200 && !fs.existsSync(filePath), [asSa.status, asSa.json]);
		ok("§13 ...the row stays: no file, no bytes, \"Voice note removed by an administrator\"", row.voice_file === "" && row.voice_bytes === 0 && row.message === "Voice note removed by an administrator", row);
		const audits = db.prepare("SELECT * FROM audit_trail WHERE action = 'voice_note_delete' AND entity_id = ?").all(String(id));
		ok("§13 ...one audit row", audits.length === 1 && audits[0].entity === "message", audits);
		ok("§13 ...and it no longer plays (404)", (await play(U.sa, id)).status === 404);
		const thread = await request(P, "GET", `/api/messages/${encodeURIComponent(DRIVER)}`, U.sa);
		const shown = thread.json && (thread.json.messages || []).find((m) => m.id === id);
		ok("§13 ...its thread row has no duration and says it was removed", !!shown && shown.voice_duration_ms === 0 && shown.message === "Voice note removed by an administrator", shown);
		ok("§13 a text message's id: 404", (await request(P, "DELETE", "/api/messages/1/voice", U.sa)).status === 404);
	}

	// §14 the retention sweep
	if (voiceNotes) {
		const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-note-sweep-"));
		const sdb = oldDb();
		migrate(sdb);
		const vdir = path.join(sweepDir, "storage", "voice-notes");
		fs.mkdirSync(vdir, { recursive: true });
		const now = Date.now();
		const ins = sdb.prepare(`INSERT INTO messages (timestamp, "from", "to", message, attachment_type, voice_file, voice_duration_ms, voice_bytes, client_key, sender_user_id, party_user_id)
			VALUES (?, 'Dispatch', ?, 'Voice note (0:03)', 'voice', ?, 3160, ?, ?, 2, 10)`);
		const oldName = "vn_900_0123456789abcdef.m4a";
		const newName = "vn_901_0123456789abcdef.m4a";
		const orphan = "vn_902_0123456789abcdef.m4a";
		const fresh = "vn_903_0123456789abcdef.m4a";
		ins.run(new Date(now - 200 * 86400000).toISOString(), DRIVER, oldName, CHROME.length, "k-old-000001");
		ins.run(new Date(now - 5 * 86400000).toISOString(), DRIVER, newName, CHROME.length, "k-new-000001");
		for (const n of [oldName, newName, orphan, fresh]) fs.writeFileSync(path.join(vdir, n), CHROME);
		const twoHours = (now - 2 * 3600000) / 1000;
		fs.utimesSync(path.join(vdir, orphan), twoHours, twoHours);
		const quiet = { log() {}, warn() {} };
		const report = voiceNotes.sweepVoiceNotes({ db: sdb, dir: vdir, nowMs: now, retentionDays: 180, applyFrom: "", todayKey: "2026-10-22", log: quiet });
		ok("§14 no date set: it reports one old note and one unnamed file, and removes nothing",
			report.expired === 1 && report.orphans === 1 && report.removed === 0 && fs.readdirSync(vdir).length === 4, report);
		const future = voiceNotes.sweepVoiceNotes({ db: sdb, dir: vdir, nowMs: now, retentionDays: 180, applyFrom: "2027-04-20", todayKey: "2026-10-22", log: quiet });
		ok("§14 a date still ahead: removes nothing", future.removed === 0 && fs.readdirSync(vdir).length === 4, future);
		const applied = voiceNotes.sweepVoiceNotes({ db: sdb, dir: vdir, nowMs: now, retentionDays: 180, applyFrom: "2026-10-22", todayKey: "2026-10-22", log: quiet });
		const left = fs.readdirSync(vdir).sort();
		ok("§14 its date reached: the old note and the unnamed file are removed; the recent note and a file under an hour old stay",
			applied.removed === 2 && left.join(",") === [newName, fresh].sort().join(","), [applied, left]);
		const oldRow = sdb.prepare("SELECT * FROM messages WHERE client_key = 'k-old-000001'").get();
		ok("§14 ...the old note's row stays, reading \"Voice note (0:03), no longer available\"", oldRow.voice_file === "" && oldRow.voice_bytes === 0 && oldRow.message === "Voice note (0:03), no longer available", oldRow);
		ok("§14 server.js runs it daily, report only until VOICE_NOTE_SWEEP_APPLY_FROM",
			/startsJob\("voice note retention sweep"\)/.test(SRC) && /applyFrom: VOICE_NOTE_SWEEP_APPLY_FROM/.test(SRC));
		fs.rmSync(sweepDir, { recursive: true, force: true });
	}

	// §15 GET /api/driver/position's stoppedSinceMs, and the gate's table
	{
		const pos = SRC.slice(SRC.indexOf('app.get(["/api/driver/position"'), SRC.indexOf("\n});\n", SRC.indexOf('app.get(["/api/driver/position"')));
		ok("§15 GET /api/driver/position returns stoppedSinceMs from voiceNoteGate.stoppedSinceMs()", /stoppedSinceMs = voiceNoteGate\.stoppedSinceMs\(/.test(pos) && /\n\t\t\t\tstoppedSinceMs,\n/.test(pos));
		if (gate) {
			const now = 10_000_000;
			const fix = (agoMs, speed) => ({ location_date_ms: now - agoMs, speed });
			ok("§15 stoppedSinceMs: the last moving fix's time", gate.stoppedSinceMs([fix(30e3, 0), fix(90e3, 0), fix(150e3, 9), fix(300e3, 0)]) === now - 150e3);
			ok("§15 ...null while the latest fix is moving", gate.stoppedSinceMs([fix(30e3, 9), fix(90e3, 0)]) === null);
			ok("§15 ...the oldest fix read when none moved", gate.stoppedSinceMs([fix(30e3, 0), fix(600e3, 0)]) === now - 600e3);
			ok("§15 ...null with no fix", gate.stoppedSinceMs([]) === null);
			const g = (f, since) => gate.recordGate({ fix: f, stoppedSince: since, nowMs: now }).state;
			ok("§15 the record gate: fresh and moving = moving (blocked)", g(fix(30e3, 9), null) === "moving" && !gate.recordGate({ fix: fix(30e3, 9), stoppedSince: null, nowMs: now }).allowed);
			ok("§15 ...stopped under 2 minutes = stopping (blocked)", g(fix(30e3, 0), now - 60e3) === "stopping");
			ok("§15 ...stopped 2 minutes or more = parked (allowed)", g(fix(30e3, 0), now - 150e3) === "parked" && gate.recordGate({ fix: fix(30e3, 0), stoppedSince: now - 150e3, nowMs: now }).allowed);
			ok("§15 ...a fix over 3 minutes old = unknown (allowed)", g(fix(200e3, 9), null) === "unknown");
			ok("§15 ...a fix over 2 minutes in the future = unknown, either way", g(fix(-150e3, 9), null) === "unknown" && g(fix(-150e3, 0), now) === "unknown");
			ok("§15 ...no fix = unknown", g(null, null) === "unknown");
			ok("§15 the server refuses only a fresh moving fix", gate.movingRefusal(fix(30e3, 9), now) && !gate.movingRefusal(fix(200e3, 9), now) && !gate.movingRefusal(fix(30e3, 0), now) && !gate.movingRefusal(fix(-150e3, 9), now));
			ok("§15 5 mph is the threshold (2.235 m/s), not counted as moving at it", !gate.movingRefusal(fix(30e3, 2.235), now) && gate.movingRefusal(fix(30e3, 2.24), now));
		}
	}

	// §16 the label
	if (voiceText) {
		ok("§16 \"Voice note (0:42)\"", voiceText.voiceNoteLabel(42000) === "Voice note (0:42)");
		ok("§16 rounded down: 3,160 ms is 0:03, 59,999 ms is 0:59, 180,400 ms is 3:00",
			voiceText.voiceNoteLabel(3160) === "Voice note (0:03)" && voiceText.voiceNoteLabel(59999) === "Voice note (0:59)" && voiceText.voiceNoteLabel(180400) === "Voice note (3:00)");
		ok("§16 no length reads 0:00", voiceText.voiceNoteLabel(NaN) === "Voice note (0:00)" && voiceText.voiceNoteLabel(-5) === "Voice note (0:00)");
	}

	// §17 deleting a user unlinks his voice files
	{
		const head = 'app.delete("/api/users/:id", requireRole("Super Admin"), (req, res) => {';
		const at = SRC.indexOf(head);
		const del = at < 0 ? "" : SRC.slice(at, SRC.indexOf("\n});\n", at));
		const collectAt = del.indexOf("const voiceFiles = userVoiceNoteFiles(id, name);");
		const txAt = del.indexOf("db.transaction(() => {\n\t\t\tif (name) {");
		const removeAt = del.indexOf("removed.voice_note_files = removeUserVoiceNotes(id, voiceFiles);");
		const rolledBackAt = del.indexOf('code: "DELETE_ROLLED_BACK"');
		ok("§17 DELETE /api/users/:id reads the account's voice files beside its delete and unlinks them once it commits",
			collectAt > 0 && txAt > collectAt && rolledBackAt > txAt && removeAt > rolledBackAt, [collectAt, txAt, rolledBackAt, removeAt]);
		const messageDelete = (/removed\.messages = db\.prepare\(`DELETE FROM messages[^\n]+/.exec(del) || [])[0] || "";
		let fns = null;
		const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-note-userdel-"));
		try {
			const lifted = closure(SRC, { roots: ["userVoiceNoteFiles", "removeUserVoiceNotes"], provided: ["db", "console", "require", "DATA_DIR"] }).text;
			const udb = oldDb();
			migrate(udb);
			fns = { db: udb, ...new Function("db", "console", "require", "DATA_DIR", `"use strict";\n${lifted}\nreturn { userVoiceNoteFiles, removeUserVoiceNotes };`)(udb, { error() {}, log() {}, warn() {} }, appRequire, userDir) };
		} catch (err) {
			ok(`§17 the user-delete voice helpers lift from server.js (${err.message})`, false);
		}
		if (fns && messageDelete) {
			const vdir = path.join(userDir, "storage", "voice-notes");
			fs.mkdirSync(vdir, { recursive: true });
			const ins = fns.db.prepare(`INSERT INTO messages (timestamp, "from", "to", message, attachment_type, voice_file, voice_duration_ms, voice_bytes, client_key, sender_user_id, party_user_id)
				VALUES ('2026-10-20T12:00:00.000Z', ?, ?, 'Voice note (0:03)', 'voice', ?, 3160, 100, ?, ?, ?)`);
			const names = ["vn_800_00000000000000a1.m4a", "vn_801_00000000000000b2.m4a", "vn_802_00000000000000c3.m4a", "vn_803_00000000000000d4.m4a"];
			ins.run("Dispatch", DRIVER, names[0], "k-del-0000001", 2, U.drv.id);          // to him, by name
			ins.run(DRIVER, "Dispatch", names[1], "k-del-0000002", U.drv.id, U.drv.id);   // from him, by name
			ins.run("Dispatch", "Tamsin Vale-Old", names[2], "k-del-0000003", 2, U.drv.id); // his, under an old name
			ins.run("Dispatch", DRIVER_B, names[3], "k-del-0000004", 2, U.drvB.id);       // another driver's
			for (const n of names) fs.writeFileSync(path.join(vdir, n), CHROME);
			const files = fns.userVoiceNoteFiles(U.drv.id, DRIVER.toLowerCase());
			ok("§17 the files read: his three notes (by name and by account), not another driver's", files.slice().sort().join(",") === names.slice(0, 3).join(","), files);
			const removed = {};
			new Function("db", "name", "removed", messageDelete)(fns.db, DRIVER.toLowerCase(), removed);
			const gone = fns.removeUserVoiceNotes(U.drv.id, files);
			ok("§17 after the delete commits, his three files are unlinked", gone === 3 && names.slice(0, 3).every((n) => !fs.existsSync(path.join(vdir, n))), gone);
			ok("§17 another driver's note and file stay", fs.existsSync(path.join(vdir, names[3])) && fns.db.prepare("SELECT voice_file FROM messages WHERE client_key = 'k-del-0000004'").get().voice_file === names[3]);
			const kept = fns.db.prepare("SELECT voice_file, voice_bytes FROM messages WHERE client_key = 'k-del-0000003'").get();
			ok("§17 his note under an old name keeps its row, without its audio", !!kept && kept.voice_file === "" && kept.voice_bytes === 0, kept);
		}
		fs.rmSync(userDir, { recursive: true, force: true });
	}

	for (const s of servers) s.close();
	fs.rmSync(dataDir, { recursive: true, force: true });
	console.log(failed ? `\n${failed} failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
