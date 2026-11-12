#!/usr/bin/env node
/**
 * New-feature notices for drivers, the server's side: lib/driver-releases.js (the list and its
 * rules), lib/driver-release-routes.js (the routes and the table) and how server.js wires them in.
 *
 * WHAT IS ASSERTED, each a way this can silently stop being true:
 *   §1  THE LIST: ids unique, in order and well shaped; plain words with no figure, name or real
 *       data; every tour step and part of the app known to the client; the first entry covers
 *       what has shipped
 *   §2  THE RULES: unseen notes newest first; which ids a driver may mark, and confirm
 *   §3  A SIGN-IN: nothing goes in the session, for any role; GET /api/auth/session doesn't change; a
 *       hook that throws costs no sign-in
 *   §4  A READ, over a real session store: what's unanswered, every time, newest first; reading marks
 *       nothing, writes nothing to the session and sends no cookie; what's answered doesn't come back;
 *       a new entry or a rollback changes the list and nothing else; nothing says a sign-in is due
 *   §5  CHANGE-PASSWORD isn't touched: a forced change comes first, and the offer is still there after
 *   §6  THE KILL SWITCH: off, every route answers 404 FEATURE_OFF before any role check, nothing
 *       is written and a sign-in still works; the flag reads on unless false/0/no/off
 *   §7  WHO: only a Driver reaches the driver routes and only a Super Admin the record; every other
 *       role 403, nobody 401, a forced password change 403; a write without the header 403; a
 *       percentage driver reads like any other
 *   §8  THE CONFIRMATION: only "I acknowledge" answers a note; it writes acknowledged_at and seen_at
 *       once, at the server's time, and a repeat keeps the first; unknown ids and the tour's row
 *       refused and never stored; another driver's rows neither read nor written, whatever the body
 *       says; /seen takes the tour offer's row alone; the budget is per account; the answer is never
 *       kept by a cache and holds no name
 *   §9  A FIRST-TIME DRIVER: no history, one tour offer that waits until answered and never comes
 *       back, and nothing confirmed for them; an existing driver gets the notes and no offer
 *   §10 THE TOUR writes only its own tour_done_at, and only theirs: a release's tour answers no
 *       note, the whole app tour answers the offer; a repeat keeps the first time; the columns, and
 *       a table made before the confirmation gets its column
 *   §11 A FAILED READ OR WRITE: no table still answers and locks nobody out; a sign-in works; a
 *       confirmation or a record that can't be read or written says so with its own code
 *   §12 THE WIRING: server.js as shipped, the routes in the snapshot, the flag in the replica rules
 *       and the settings template, parameterized SQL, and nothing in pay, invoices or brokers
 *       reading the table
 *   §13 THE RECORD, for a Super Admin: newest notice first; every active Driver account, and an
 *       inactive one only if they confirmed; "acknowledged" with its time, "not yet", or "started
 *       after" for a driver whose rows came from their first sign-in or who hasn't signed in; the
 *       count leaves out those never asked; names, states and times only, never kept by a cache
 *
 * Runs the SHIPPED code: the session config, login, logout, session and change-password routes,
 * the guards and the purge are lifted out of server.js and wired to the real express-session and
 * better-sqlite3-session-store over a temporary SQLite. Real Express on 127.0.0.1:0, no network
 * beyond loopback, made-up accounts.
 *
 *   node scripts/test-driver-release-notices.js                  # exits 1 on failure
 *   SERVER_JS=/tmp/base.js node scripts/test-driver-release-notices.js   # a base commit: fails
 */
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { once } = require("events");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();

let pass = 0;
const failures = [];
const ok = (label, cond, detail) => {
	if (cond) { pass++; return; }
	failures.push(label);
	console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const section = (title) => console.log(`§ ${title}`);

// The shipped handlers log on their failure paths, and §11 provokes those on purpose.
const logs = [];
const quiet = { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) };
const realError = console.error;
const realWarn = console.warn;
console.error = quiet.error;
console.warn = quiet.warn;

function die(msg) {
	console.error = realError;
	console.warn = realWarn;
	console.error(`FAILED: ${msg}`);
	process.exit(1);
}

let express, session, Database, bcrypt, SqliteStoreFactory, releases, routes, signInLib;
try {
	express = require("express");
	session = require("express-session");
	Database = require("better-sqlite3");
	bcrypt = require("bcryptjs");
	SqliteStoreFactory = require("better-sqlite3-session-store");
	signInLib = require("../lib/sign-in.js");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
try {
	releases = require("../lib/driver-releases.js");
	routes = require("../lib/driver-release-routes.js");
} catch (e) {
	die(`lib/driver-releases.js and lib/driver-release-routes.js must exist (${e.message})`);
}
const SqliteStoreBase = SqliteStoreFactory(session);

// ── lift the shipped code ───────────────────────────────────────────────────
function liftRoute(head) {
	const hits = SRC.split(head).length - 1;
	if (hits !== 1) die(`expected exactly 1 registration starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(head);
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
}
function liftFunction(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
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

const LOGIN_SRC = liftRoute('app.post("/api/auth/login", loginLimiter, async (req, res) => {');
const LOGOUT_SRC = liftRoute('app.post("/api/auth/logout", (req, res) => {');
const SESSION_ROUTE_SRC = liftRoute('app.get("/api/auth/session", (req, res) => {');
const CHANGE_SRC = liftRoute('app.post("/api/auth/change-password", requireAuth, changePasswordLimiter, async (req, res) => {');
const STAMP_SRC = liftFunction("function stampLastLogin(userId) {");
const PURGE_SRC = liftFunction("function purgeUserSessions(userId, exceptSid) {");
const REQUIRE_AUTH_SRC = liftFunction("function requireAuth(req, res, next) {");
const REQUIRE_ROLE_SRC = liftFunction("function requireRole(...roles) {");
const CURRENT_FLAG_SRC = liftFunction("function currentMustChangePassword(sessionUser) {");
const REFRESH_FLAG_SRC = liftFunction("function refreshPasswordChangeFlag(req, res, next) {");
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
const USERS_ALTERS = ["full_name", "company_name", "must_change_password", "last_login_at", "disabled_at"].flatMap((col) => {
	const m = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
	return m ? [m[0]] : [];
});

// ── the world ───────────────────────────────────────────────────────────────
const SECRET = "release-notices-test-secret-not-a-real-one";
const PW = "Made-Up-Pass-1!";
const NEW_PW = "Made-Up-Pass-2!";
const HASH = bcrypt.hashSync(PW, 4);
const fastBcrypt = { compare: (a, b) => bcrypt.compare(a, b), hash: (a) => bcrypt.hash(a, 4) };
const STAMPED = "2026-10-01T12:00:00.000Z";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-release-notices-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
let dbCount = 0;

// A file, as in production, so a second world after a "deploy" reads the same sessions.
function makeDb() {
	const db = new Database(path.join(tmp, `world-${++dbCount}.db`));
	db.exec(USERS_CREATE);
	for (const alter of USERS_ALTERS) db.exec(alter);
	db.exec("CREATE TABLE audit_trail (id INTEGER PRIMARY KEY AUTOINCREMENT, details TEXT)");
	const add = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, email, full_name, company_name, must_change_password, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)");
	add.run(1, "desk-a", HASH, "Dispatcher", "", "desk@example.test", "Desk Example", 0, STAMPED);
	add.run(2, "driver-a", HASH, "Driver", "Casey Example", "casey@example.test", "Casey Example", 0, STAMPED);
	add.run(3, "driver-b", HASH, "Driver", "Riley Sample", "riley@example.test", "Riley Sample", 0, STAMPED);
	add.run(4, "root-a", HASH, "Super Admin", "", "root@example.test", "Root Example", 0, STAMPED);
	add.run(5, "backer-a", HASH, "Investor", "", "backer@example.test", "Backer Example", 0, STAMPED);
	add.run(6, "driver-new", HASH, "Driver", "Jordan Newhire", "jordan@example.test", "Jordan Newhire", 0, null);
	add.run(7, "driver-temp", HASH, "Driver", "Taylor Temp", "taylor@example.test", "Taylor Temp", 1, null);
	add.run(8, "driver-pct", HASH, "Driver", "Morgan Percent", "morgan@example.test", "Morgan Percent", 0, STAMPED);
	add.run(9, "desk-new", HASH, "Dispatcher", "", "desknew@example.test", "Avery Newdesk", 0, null);
	return db;
}

function makeStoreClass() {
	return class TestStore extends SqliteStoreBase {};
}

function buildSessionMiddleware(db) {
	const realSetInterval = global.setInterval;
	global.setInterval = (...args) => {
		const t = realSetInterval(...args);
		if (t && typeof t.unref === "function") t.unref();
		return t;
	};
	try {
		return new Function("session", "SqliteStore", "db", "SESSION_SECRET", "SESSION_COOKIE_SECURE", "SESSION_COOKIE_SAMESITE", "REPLICA",
			`${SESSION_CONFIG_SRC}\nreturn sessionMiddleware;`)(session, makeStoreClass(), db, SECRET, false, "lax", null);
	} finally {
		global.setInterval = realSetInterval;
	}
}

const worlds = [];
async function startWorld({ db = makeDb(), enabled = true, list = releases.RELEASES, hook, now } = {}) {
	const app = express();
	app.set("trust proxy", 1);
	app.use(express.json());
	app.use(buildSessionMiddleware(db));
	app.use(new Function("db", `${CURRENT_FLAG_SRC}\n${REFRESH_FLAG_SRC}\nreturn refreshPasswordChangeFlag;`)(db));
	const requireRole = new Function(`${REQUIRE_ROLE_SRC}\nreturn requireRole;`)();
	const requireAuth = new Function(`${REQUIRE_AUTH_SRC}\nreturn requireAuth;`)();
	const notices = routes.mount(app, { enabled, requireRole, db, releases: list, logger: quiet, now });
	const signIn = signInLib.createSignIn({
		db, logAudit: () => {}, logAuditRefusal: () => {}, networkEvidence: () => ({}), auditEnabled: false, uniqueEmail: false, logger: quiet,
		onSessionStart: hook || notices.startSession,
	});
	const stampLastLogin = new Function("db", `${STAMP_SRC}\nreturn stampLastLogin;`)(db);
	const noSockets = () => 0;
	const passThrough = (req, res, next) => next();
	const liveSessionIds = (sids) => new Set(sids.filter((sid) => db.prepare("SELECT 1 FROM sessions WHERE sid = ?").get(sid)));
	const purgeUserSessions = new Function("db", "disconnectUserSockets", `${PURGE_SRC}\nreturn purgeUserSessions;`)(db, noSockets);
	new Function("app", "loginLimiter", "db", "bcrypt", "stampLastLogin", "disconnectSessionSockets", "APP_TIMEZONE", "signIn", LOGIN_SRC)(
		app, passThrough, db, fastBcrypt, stampLastLogin, noSockets, "America/New_York", signIn);
	new Function("app", "disconnectSessionSockets", "signIn", LOGOUT_SRC)(app, noSockets, signIn);
	new Function("app", "APP_TIMEZONE", "MESSAGE_VOICE_NOTES_ENABLED", SESSION_ROUTE_SRC)(app, "America/New_York", false);
	new Function("app", "requireAuth", "changePasswordLimiter", "db", "bcrypt", "purgeUserSessions", "logAudit", "liveSessionIds", "disconnectSessionSockets",
		"notifyPasswordChanged", "passwordRules", CHANGE_SRC)(
		app, requireAuth, passThrough, db, fastBcrypt, purgeUserSessions, () => {}, liveSessionIds, noSockets,
		() => Promise.resolve({ recipients: 0, sent: 0 }), require("../lib/password-rules"));
	const server = http.createServer(app);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const world = { db, server, port: server.address().port };
	worlds.push(world);
	return world;
}
const stopWorld = (world) => new Promise((resolve) => world.server.close(resolve));

function call(world, method, url, { cookie, body, xrw = true } = {}) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? null : JSON.stringify(body);
		const req = http.request({
			host: "127.0.0.1", port: world.port, method, path: url,
			headers: {
				...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
				...(cookie ? { cookie } : {}),
				...(xrw ? { "x-requested-with": "XMLHttpRequest" } : {}),
			},
		}, (res) => {
			let text = "";
			res.on("data", (c) => { text += c; });
			res.on("end", () => {
				let parsed = null;
				try { parsed = JSON.parse(text); } catch { parsed = null; }
				const set = (res.headers["set-cookie"] || []).find((c) => c.startsWith("connect.sid="));
				resolve({ status: res.statusCode, body: parsed, text, headers: res.headers, cookie: set ? set.split(";")[0] : null });
			});
		});
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}
const STATE = "/api/driver/me/release";
const ACK = "/api/driver/me/release/acknowledge";
const SEEN = "/api/driver/me/release/seen";
const TOUR_DONE = "/api/driver/me/release/tour-done";
const RECORD = "/api/admin/driver-release/acknowledgements";

async function signIn(world, username, password = PW) {
	const r = await call(world, "POST", "/api/auth/login", { body: { username, password } });
	if (r.status !== 200 || !r.cookie) throw new Error(`sign-in as ${username} answered ${r.status}`);
	return r.cookie;
}
const sidOf = (cookie) => decodeURIComponent(cookie.split("=")[1]).replace(/^s:/, "").split(".")[0];
const storedSession = (db, cookie) => {
	const row = db.prepare("SELECT sess FROM sessions WHERE sid = ?").get(sidOf(cookie));
	return row ? JSON.parse(row.sess) : null;
};
// Every column but the ids: a table without the confirmation's column reads it as missing, not as a crash.
const seenRows = (db, userId) => db.prepare("SELECT * FROM driver_release_seen WHERE user_id = ? ORDER BY release_id").all(userId)
	.map((r) => ({ release_id: r.release_id, seen_at: r.seen_at, tour_done_at: r.tour_done_at, acknowledged_at: r.acknowledged_at }));

const R1 = Object.freeze({ id: "2026-01-01-first", title: "First", notes: ["The first made-up note."], tour: ["loads"] });
const R2 = Object.freeze({ id: "2026-02-01-second", title: "Second", notes: ["The second made-up note.", { text: "A made-up line for a tab.", needs: "performance" }], tour: ["performance"] });
const NOTHING = Object.freeze({ notes: [], tourOffered: false });

async function main() {
	const clientLib = await import(pathToFileURL(path.join(ROOT, "client", "src", "lib", "driverReleaseNotices.js")).href).catch((e) => die(`client lib must exist: ${e.message}`));

	// ── §1 ──────────────────────────────────────────────────────────────────
	section("1 the list");
	const LIST = releases.RELEASES;
	ok("the list holds at least one release", Array.isArray(LIST) && LIST.length > 0);
	ok("the list can't change at run time", Object.isFrozen(LIST) && LIST.every((r) => Object.isFrozen(r) && Object.isFrozen(r.notes)));
	const ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
	const ids = LIST.map((r) => r.id);
	ok("every id is YYYY-MM-DD-words", ids.every((id) => ID_RE.test(id)), ids);
	eq("ids are unique", new Set(ids).size, ids.length);
	eq("ids are in date order", [...ids].map((id) => id.slice(0, 10)), [...ids].map((id) => id.slice(0, 10)).sort());
	ok("no id can be taken for the tour's row", !ids.includes(releases.APP_TOUR_ROW) && !ID_RE.test(releases.APP_TOUR_ROW));
	eq("the tour's row has one name on both sides", clientLib.APP_TOUR_ROW, releases.APP_TOUR_ROW);

	// Words a driver reads. No figure in any form: a number in a note can't follow a week with time off.
	const SPELLED = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|half|dollars?|cents?|percent)\b/i;
	const JARGON = /\b(session|deploy|deployed|release|server|api|bug|flag|sheet|database|endpoint|cache|token|login)\b/i;
	const APP_WORDS = new Set(["Loads", "Performance", "Alerts", "Kit", "Messages", "Invoices", "Active", "Pending", "Historical", "POD", "LogisX"]);
	function wordProblems(text) {
		const out = [];
		if (typeof text !== "string" || text.trim() === "") return ["empty"];
		if (/\d/.test(text)) out.push("a digit");
		if (/[$#%@]/.test(text)) out.push("a figure or address sign");
		if (SPELLED.test(text)) out.push("a spelled-out figure");
		if (JARGON.test(text)) out.push("a word a driver wouldn't use");
		for (const sentence of text.split(/(?<=[.!?:])\s+/)) {
			for (const word of sentence.split(/\s+/).slice(1)) {
				const bare = word.replace(/[^A-Za-z]/g, "");
				if (/^[A-Z]/.test(bare) && !APP_WORDS.has(bare)) out.push(`a capitalized word that could be a name: ${bare}`);
			}
		}
		return out;
	}
	const lineText = (n) => (typeof n === "string" ? n : n && n.text);
	for (const r of LIST) {
		eq(`${r.id}: its title is plain`, wordProblems(r.title), []);
		ok(`${r.id}: its title is short`, r.title.length <= 60);
		ok(`${r.id}: one to six notes`, Array.isArray(r.notes) && r.notes.length >= 1 && r.notes.length <= 6);
		for (const n of r.notes) {
			eq(`${r.id}: "${lineText(n)}" is plain`, wordProblems(lineText(n)), []);
			ok(`${r.id}: "${lineText(n)}" fits a phone`, lineText(n).length <= 140);
			ok(`${r.id}: "${lineText(n)}" needs a known part of the app`, typeof n === "string" || releases.NEEDS.includes(n.needs));
		}
		ok(`${r.id}: its tour is known steps only`, Array.isArray(r.tour) && r.tour.length > 0 && r.tour.every((s) => clientLib.APP_TOUR_STEP_IDS.includes(s)), r.tour);
	}
	ok("the plain-words check catches a dollar figure", wordProblems("You earned $250 this week.").length > 0);
	ok("the plain-words check catches a load count", wordProblems("7.5 is the target.").length > 0);
	ok("the plain-words check catches a person's name", wordProblems("Ask Jordan about this.").length > 0);
	ok("the plain-words check catches a spelled figure", wordProblems("Each pickup counts half a load.").length > 0);
	eq("a note's needs are parts of the app the client knows", releases.NEEDS.every((need) => clientLib.TOUR_STEPS.some((s) => s.needs === need)), true);

	const first = LIST[0];
	const firstText = first.notes.map(lineText).join(" ");
	ok("the first entry covers the Performance tab", /Performance tab/.test(firstText));
	ok("the first entry covers the bar and what it opens", /\bbar\b/.test(firstText) && /Loads page/.test(firstText));
	ok("the first entry covers the count", /pickup/.test(firstText) && /delivery/.test(firstText));
	ok("the first entry covers the target and, most weeks, what's required: a week of time off can have no such figure", /your target and, most weeks, what's required/.test(firstText));
	ok("the first entry covers the fuel range label, when it's known: with no reading or no tank size on file the top of the app says not available", first.notes.includes("The top of the app now shows your fuel range when it's known: how many miles you have left until empty."));
	ok("what's about the Performance tab goes only to a driver who has it", first.notes.filter((n) => /Performance|bar|pickup/.test(lineText(n))).every((n) => n.needs === "performance"));
	ok("the fuel line goes to every driver", first.notes.some((n) => typeof n === "string" && /fuel range/.test(n)));

	// ── §2 ──────────────────────────────────────────────────────────────────
	section("2 the rules");
	const TWO = [R1, R2];
	eq("the latest id is the last entry's", releases.latestReleaseId(TWO), R2.id);
	eq("an empty list has no latest id", releases.latestReleaseId([]), null);
	eq("unseen notes come newest first", releases.unseenReleases([], TWO).map((r) => r.id), [R2.id, R1.id]);
	eq("a seen id drops out", releases.unseenReleases(new Set([R2.id]), TWO).map((r) => r.id), [R1.id]);
	eq("each line reads as { text, needs? }", releases.unseenReleases([R1.id], TWO)[0].notes, [{ text: "The second made-up note." }, { text: "A made-up line for a tab.", needs: "performance" }]);
	eq("a driver may mark a listed id", releases.isMarkableId(R1.id, TWO), true);
	eq("...and the tour's row", releases.isMarkableId(releases.APP_TOUR_ROW, TWO), true);
	eq("...and nothing they made up", releases.isMarkableId("anything-else", TWO), false);
	eq("...not even a built-in property's name", releases.isMarkableId("__proto__", TWO), false);
	const listed = (id, list) => (typeof releases.isListedRelease === "function" ? releases.isListedRelease(id, list) : "no rule");
	eq("a driver confirms a listed notice", listed(R1.id, TWO), true);
	eq("...and not the tour's row, which is no notice", listed(releases.APP_TOUR_ROW, TWO), false);
	eq("...nor anything made up", [listed("anything-else", TWO), listed("__proto__", TWO)], [false, false]);

	// ── §3 ──────────────────────────────────────────────────────────────────
	section("3 a sign-in");
	{
		const w = await startWorld({ list: TWO });
		const driver = await signIn(w, "driver-a");
		eq("a sign-in puts nothing of this in a Driver's session", Object.keys(storedSession(w.db, driver)).sort(), ["cookie", "user"]);
		const sess = await call(w, "GET", "/api/auth/session", { cookie: driver });
		ok("the session answer doesn't carry it", !JSON.stringify(sess.body).includes("driverRelease"), sess.body);
		eq("the session answer's user is what it was", Object.keys(sess.body.user).sort(), ["companyName", "driverName", "email", "fullName", "id", "mustChangePassword", "role", "username"]);
		for (const [name, role] of [["desk-a", "Dispatcher"], ["root-a", "Super Admin"], ["backer-a", "Investor"]]) {
			const c = await signIn(w, name);
			eq(`...nor in a ${role}'s`, Object.keys(storedSession(w.db, c)).sort(), ["cookie", "user"]);
		}
		await signIn(w, "desk-new");
		eq("no other role's sign-in wrote a row, a first-time one's included", w.db.prepare("SELECT COUNT(*) AS n FROM driver_release_seen WHERE user_id IN (1, 4, 5, 9)").get().n, 0);
		await stopWorld(w);
	}
	{
		const w = await startWorld({ list: TWO, hook: () => { throw new Error("made-up failure"); } });
		const r = await call(w, "POST", "/api/auth/login", { body: { username: "driver-a", password: PW } });
		eq("a hook that throws costs no sign-in", [r.status, r.body && r.body.success], [200, true]);
		eq("...and the session has its user", storedSession(w.db, r.cookie).user.username, "driver-a");
		await stopWorld(w);
	}

	// ── §4 ──────────────────────────────────────────────────────────────────
	section("4 a read");
	{
		const db = makeDb();
		let w = await startWorld({ db, list: [R1] });
		const driver = await signIn(w, "driver-a");
		const other = await signIn(w, "driver-b");
		const notesOf = async (cookie) => (await call(w, "GET", STATE, { cookie })).body.notes.map((n) => n.id);
		const sessionBefore = storedSession(db, driver);
		const firstRead = await call(w, "GET", STATE, { cookie: driver });
		eq("a read holds what they haven't answered", firstRead.body.notes.map((n) => n.id), [R1.id]);
		eq("...writes nothing to their session", storedSession(db, driver), sessionBefore);
		eq("...sends no new cookie, so the session ends when it would have", firstRead.cookie, null);
		eq("...and marks nothing seen by being read", seenRows(db, 2), []);
		eq("the server says the same however often it's asked: the app decides when to show it", await notesOf(driver), [R1.id]);
		eq("another driver's read is their own", await notesOf(other), [R1.id]);
		await stopWorld(w);

		w = await startWorld({ db, list: TWO });
		eq("a new entry changes what's unanswered and nothing else", await notesOf(driver), [R2.id, R1.id]);
		await call(w, "POST", ACK, { cookie: driver, body: { ids: [R2.id, R1.id] } });
		eq("confirmed, it doesn't come back", (await call(w, "GET", STATE, { cookie: driver })).body, NOTHING);
		eq("...at the next sign-in either", (await call(w, "GET", STATE, { cookie: await signIn(w, "driver-a") })).body, NOTHING);
		eq("another driver's sign-in changes nobody else's answer", await notesOf(other), [R2.id, R1.id]);
		await stopWorld(w);

		w = await startWorld({ db, list: [R1] });
		eq("a rollback: only what the list holds", await notesOf(other), [R1.id]);
		await stopWorld(w);

		w = await startWorld({ db, list: [] });
		eq("an empty list leaves nothing to read", (await call(w, "GET", STATE, { cookie: other })).body, NOTHING);
		await stopWorld(w);
	}

	// ── §5 ──────────────────────────────────────────────────────────────────
	section("5 change-password");
	{
		const db = makeDb();
		const w = await startWorld({ db, list: TWO });
		const c = await signIn(w, "driver-a");
		const r = await call(w, "POST", "/api/auth/change-password", { cookie: c, body: { currentPassword: PW, newPassword: NEW_PW } });
		eq("the change works and rotates the session", [r.status, !!r.cookie && r.cookie !== c], [200, true]);
		eq("the rotated session is what it was", Object.keys(storedSession(db, r.cookie)).sort(), ["cookie", "user"]);
		eq("reads answer as before", (await call(w, "GET", STATE, { cookie: r.cookie })).body.notes.map((n) => n.id), [R2.id, R1.id]);
		await stopWorld(w);
	}
	{
		// A temporary password: the first sign-in, the forced change, then the app.
		const w = await startWorld({ list: TWO });
		const c = await signIn(w, "driver-temp");
		const held = await call(w, "GET", STATE, { cookie: c });
		eq("a forced password change comes first", [held.status, held.body.code], [403, "PASSWORD_CHANGE_REQUIRED"]);
		const r = await call(w, "POST", "/api/auth/change-password", { cookie: c, body: { currentPassword: PW, newPassword: NEW_PW } });
		const after = await call(w, "GET", STATE, { cookie: r.cookie });
		eq("after it their tour offer is waiting: the change doesn't put it off", after.body.tourOffered, true);
		await stopWorld(w);
	}

	// ── §6 ──────────────────────────────────────────────────────────────────
	section("6 the kill switch");
	{
		const w = await startWorld({ enabled: false, list: TWO });
		const off = { status: 404, code: "FEATURE_OFF" };
		const seenOff = (r) => ({ status: r.status, code: r.body && r.body.code });
		eq("off, nobody reads it: no session at all", seenOff(await call(w, "GET", STATE)), off);
		const driver = await signIn(w, "driver-new");
		eq("off, a sign-in works", storedSession(w.db, driver).user.username, "driver-new");
		eq("off, a Driver reads 404", seenOff(await call(w, "GET", STATE, { cookie: driver })), off);
		const root = await signIn(w, "root-a");
		eq("off, a Super Admin reads 404, before the role check", seenOff(await call(w, "GET", STATE, { cookie: root })), off);
		eq("off, a confirmation answers 404", seenOff(await call(w, "POST", ACK, { cookie: driver, body: { ids: [R1.id] } })), off);
		eq("off, a mark answers 404", seenOff(await call(w, "POST", SEEN, { cookie: driver, body: { ids: [releases.APP_TOUR_ROW] } })), off);
		eq("off, a tour mark answers 404", seenOff(await call(w, "POST", TOUR_DONE, { cookie: driver, body: { ids: [R1.id] } })), off);
		eq("off, the record answers 404 to a Super Admin", seenOff(await call(w, "GET", RECORD, { cookie: root })), off);
		eq("...and to anyone else, before the role check", [seenOff(await call(w, "GET", RECORD, { cookie: driver })), seenOff(await call(w, "GET", RECORD))], [off, off]);
		eq("off, nothing was written", w.db.prepare("SELECT COUNT(*) AS n FROM driver_release_seen").get().n, 0);
		await stopWorld(w);
	}
	{
		const m = SRC.match(/enabled: (!\/\^\(false\|0\|no\|off\)\$\/i\.test\(String\(process\.env\.DRIVER_RELEASE_NOTICES_ENABLED \?\? ""\)\.trim\(\)\))/);
		ok("server.js reads the flag in the kill-switch shape", !!m);
		if (m) {
			const read = (value) => new Function("process", `return ${m[1]};`)({ env: value === undefined ? {} : { DRIVER_RELEASE_NOTICES_ENABLED: value } });
			eq("unset is on", read(undefined), true);
			eq('"true" is on', read("true"), true);
			eq("a typo stays on", read("flase"), true);
			for (const value of ["false", "0", "no", "off", " FALSE ", "Off"]) eq(`"${value}" is off`, read(value), false);
		}
	}

	// ── §7 ──────────────────────────────────────────────────────────────────
	section("7 who");
	{
		const w = await startWorld({ list: [R1] });
		eq("no session: 401", (await call(w, "GET", STATE)).status, 401);
		eq("no session, a confirmation: 401", (await call(w, "POST", ACK, { body: { ids: [R1.id] } })).status, 401);
		eq("no session, a mark: 401", (await call(w, "POST", SEEN, { body: { ids: [releases.APP_TOUR_ROW] } })).status, 401);
		eq("no session, the record: 401", (await call(w, "GET", RECORD)).status, 401);
		for (const name of ["desk-a", "root-a", "backer-a"]) {
			const c = await signIn(w, name);
			eq(`${name} can't read it`, (await call(w, "GET", STATE, { cookie: c })).status, 403);
			eq(`${name} can't confirm`, (await call(w, "POST", ACK, { cookie: c, body: { ids: [R1.id] } })).status, 403);
			eq(`${name} can't mark`, (await call(w, "POST", SEEN, { cookie: c, body: { ids: [releases.APP_TOUR_ROW] } })).status, 403);
			eq(`${name} can't mark a tour`, (await call(w, "POST", TOUR_DONE, { cookie: c, body: { ids: [R1.id] } })).status, 403);
		}
		for (const name of ["desk-a", "backer-a", "driver-a", "driver-pct"]) {
			const c = await signIn(w, name);
			eq(`${name} can't read the record: Super Admin only`, (await call(w, "GET", RECORD, { cookie: c })).status, 403);
		}
		eq("a Super Admin reads the record", (await call(w, "GET", RECORD, { cookie: await signIn(w, "root-a") })).status, 200);
		const driver = await signIn(w, "driver-a");
		const noHeader = await call(w, "POST", ACK, { cookie: driver, xrw: false, body: { ids: [R1.id] } });
		eq("a confirmation without the header is refused", [noHeader.status, noHeader.body && noHeader.body.code], [403, "CSRF_HEADER_REQUIRED"]);
		eq("...and writes nothing", seenRows(w.db, 2), []);
		const pct = await signIn(w, "driver-pct");
		const a = (await call(w, "GET", STATE, { cookie: driver })).body;
		const b = (await call(w, "GET", STATE, { cookie: pct })).body;
		eq("a percentage driver reads what any driver reads: pay doesn't come into it", b, a);
		await stopWorld(w);
	}
	{
		const lib = fs.readFileSync(path.join(ROOT, "lib", "driver-release-routes.js"), "utf8");
		ok("the routes read nothing about pay, trucks or loads", !/pay_type|directoryPay|drivers_directory|getJobTracking|FROM trucks|FROM invoices/.test(stripComments(lib)));
		ok("every driver route goes switch, then Driver only, then the budget", [...stripComments(lib).matchAll(/app\.(?:get|post)\(PATHS\.\w+, (\w+), d\.requireRole\("Driver"\), (\w+),/g)].length === 4
			&& [...stripComments(lib).matchAll(/app\.(?:get|post)\(PATHS\.\w+, flagGate, d\.requireRole\("Driver"\), limiter,/g)].length === 4);
		eq("the record goes switch, then Super Admin only, then the budget, and it's the one route naming another role",
			[...stripComments(lib).matchAll(/requireRole\(([^)]*)\)/g)].map((m) => m[1]).filter((r) => r !== '"Driver"'), ['"Super Admin"']);
		ok("...in that order", /app\.get\(PATHS\.record, flagGate, d\.requireRole\("Super Admin"\), limiter,/.test(stripComments(lib)));
	}

	// ── §8 ──────────────────────────────────────────────────────────────────
	section("8 the confirmation");
	{
		let clock = Date.parse("2026-11-12T20:04:00.000Z");
		const w = await startWorld({ list: TWO, now: () => clock });
		const a = await signIn(w, "driver-a");
		const b = await signIn(w, "driver-b");
		const first8 = await call(w, "GET", STATE, { cookie: a });
		eq("an existing driver reads every release they haven't confirmed, newest first", first8.body.notes.map((n) => n.id), [R2.id, R1.id]);
		eq("no name of theirs in the answer", /Casey|driver-a|casey@/.test(first8.text), false);
		eq("the answer is never kept", first8.headers["cache-control"], "private, no-store");
		eq("the fields are these and no others: nothing says a sign-in is due", Object.keys(first8.body).sort(), ["notes", "tourOffered"]);
		eq("a note's fields are these and no others", Object.keys(first8.body.notes[0]).sort(), ["id", "notes", "title", "tour"]);

		const ack = await call(w, "POST", ACK, { cookie: a, body: { ids: [R2.id] } });
		eq("I acknowledge works", [ack.status, ack.body], [200, { success: true }]);
		eq("it writes the server's time of the tap, as acknowledged_at and seen_at", seenRows(w.db, 2), [{ release_id: R2.id, seen_at: "2026-11-12T20:04:00.000Z", tour_done_at: null, acknowledged_at: "2026-11-12T20:04:00.000Z" }]);
		eq("that release doesn't come back", (await call(w, "GET", STATE, { cookie: a })).body.notes.map((n) => n.id), [R1.id]);
		eq("another driver still reads it", (await call(w, "GET", STATE, { cookie: b })).body.notes.map((n) => n.id), [R2.id, R1.id]);
		clock += 60 * 60 * 1000;
		await call(w, "POST", ACK, { cookie: a, body: { ids: [R2.id] } });
		eq("a repeat changes nothing: the first confirmation stands", (seenRows(w.db, 2)[0] || {}).acknowledged_at, "2026-11-12T20:04:00.000Z");

		await call(w, "POST", ACK, { cookie: a, body: { ids: [R1.id], userId: 3, user_id: 3, driverName: "Riley Sample" } });
		eq("a body naming another driver writes only their own", [seenRows(w.db, 3).length, seenRows(w.db, 2).length], [0, 2]);
		eq("...and the other driver's notes stand", (await call(w, "GET", STATE, { cookie: b })).body.notes.length, 2);
		eq("their own rows answer their own question only", (await call(w, "GET", `${STATE}?userId=2`, { cookie: b })).body.notes.length, 2);

		for (const [label, body] of [
			["no ids", {}],
			["an empty list", { ids: [] }],
			["not a list", { ids: R1.id }],
			["an id nobody listed", { ids: ["2099-01-01-made-up"] }],
			["the tour's row, which is no notice", { ids: [releases.APP_TOUR_ROW] }],
			["a good id beside a bad one", { ids: [R1.id, "made-up"] }],
			["something that isn't text", { ids: [{ id: R1.id }] }],
			["too many", { ids: [R1.id, R2.id, R1.id] }],
		]) {
			const r = await call(w, "POST", ACK, { cookie: b, body });
			eq(`a confirmation refused: ${label}`, [r.status, r.body && r.body.code], [400, "INVALID_RELEASE"]);
		}
		eq("nothing refused was stored", seenRows(w.db, 3), []);

		// Only the confirmation answers a note: an older page's "Got it" can't.
		for (const [label, body] of [["a release id", { ids: [R1.id] }], ["a release id beside the tour's row", { ids: [releases.APP_TOUR_ROW, R1.id] }], ["the tour's row twice", { ids: [releases.APP_TOUR_ROW, releases.APP_TOUR_ROW] }]]) {
			const r = await call(w, "POST", SEEN, { cookie: b, body });
			eq(`/seen refuses ${label}`, [r.status, r.body && r.body.code], [400, "INVALID_RELEASE"]);
		}
		eq("...and stores none of it", seenRows(w.db, 3), []);
		eq("...so the note still waits for its answer", (await call(w, "GET", STATE, { cookie: b })).body.notes.map((n) => n.id), [R2.id, R1.id]);
		await stopWorld(w);
	}
	{
		const w = await startWorld({ list: [R1] });
		const a = await signIn(w, "driver-a");
		const b = await signIn(w, "driver-b");
		let last = null;
		for (let i = 0; i <= routes.RATE_LIMIT; i++) last = await call(w, "GET", STATE, { cookie: a });
		eq("past the budget: 429, its own code", [last.status, last.body.code], [429, "RELEASE_RATE_LIMITED"]);
		eq("the budget is theirs alone", (await call(w, "GET", STATE, { cookie: b })).status, 200);
		await stopWorld(w);
	}

	// ── §9 ──────────────────────────────────────────────────────────────────
	section("9 a first-time driver");
	{
		const w = await startWorld({ list: TWO });
		const c = await signIn(w, "driver-new");
		const first9 = await call(w, "GET", STATE, { cookie: c });
		eq("no history, and the tour offered", [first9.body.notes, first9.body.tourOffered], [[], true]);
		eq("older releases are marked seen, the offer waits", seenRows(w.db, 6).map((r) => [r.release_id, r.seen_at !== null]), [
			[R1.id, true], [R2.id, true], [releases.APP_TOUR_ROW, false],
		]);
		eq("...and nothing is confirmed for them: they started after those notices and aren't asked", seenRows(w.db, 6).map((r) => r.acknowledged_at), [null, null, null]);
		eq("the sign-in stamped them as usual", typeof w.db.prepare("SELECT last_login_at FROM users WHERE id = 6").get().last_login_at, "string");
		await call(w, "POST", "/api/auth/logout", { cookie: c });
		const again = await signIn(w, "driver-new");
		eq("an unanswered offer waits for the next sign-in", (await call(w, "GET", STATE, { cookie: again })).body.tourOffered, true);
		const skipped = await call(w, "POST", SEEN, { cookie: again, body: { ids: [releases.APP_TOUR_ROW] } });
		eq("/seen takes the tour offer's own row", [skipped.status, skipped.body], [200, { success: true }]);
		eq("answered, it's gone", (await call(w, "GET", STATE, { cookie: again })).body.tourOffered, false);
		const answeredAt = seenRows(w.db, 6).find((r) => r.release_id === releases.APP_TOUR_ROW).seen_at;
		await new Promise((r) => setTimeout(r, 5));
		await call(w, "POST", SEEN, { cookie: again, body: { ids: [releases.APP_TOUR_ROW] } });
		eq("a repeat keeps the first answer's time", seenRows(w.db, 6).find((r) => r.release_id === releases.APP_TOUR_ROW).seen_at, answeredAt);
		await call(w, "POST", "/api/auth/logout", { cookie: again });
		const third = await signIn(w, "driver-new");
		eq("...and never comes back", (await call(w, "GET", STATE, { cookie: third })).body.tourOffered, false);
		eq("...and its seen time stands", seenRows(w.db, 6).find((r) => r.release_id === releases.APP_TOUR_ROW).seen_at !== null, true);

		const existing = await signIn(w, "driver-b");
		const answer = await call(w, "GET", STATE, { cookie: existing });
		eq("an existing driver gets the notes and no offer", [answer.body.notes.length, answer.body.tourOffered], [2, false]);
		eq("...and no rows until they answer", seenRows(w.db, 3), []);
		await stopWorld(w);
	}
	{
		const w = await startWorld({ enabled: false, list: TWO });
		await signIn(w, "driver-new");
		eq("with the switch off, a first sign-in writes nothing", seenRows(w.db, 6), []);
		await stopWorld(w);
	}

	// ── §10 ─────────────────────────────────────────────────────────────────
	section("10 the tour");
	{
		const w = await startWorld({ list: TWO });
		const a = await signIn(w, "driver-a");
		const done = await call(w, "POST", TOUR_DONE, { cookie: a, body: { ids: [R2.id], userId: 3 } });
		eq("finishing a release's tour works", [done.status, done.body], [200, { success: true }]);
		const row = seenRows(w.db, 2)[0];
		ok("it writes tour_done_at", typeof row.tour_done_at === "string" && !Number.isNaN(Date.parse(row.tour_done_at)));
		eq("...and answers no note: seen_at and acknowledged_at stay empty", [row.seen_at, row.acknowledged_at], [null, null]);
		eq("...so the note still waits for I acknowledge", (await call(w, "GET", STATE, { cookie: a })).body.notes.map((n) => n.id), [R2.id, R1.id]);
		eq("...and only theirs", seenRows(w.db, 3), []);
		await new Promise((r) => setTimeout(r, 5));
		await call(w, "POST", TOUR_DONE, { cookie: a, body: { ids: [R2.id] } });
		eq("a repeat keeps the first time", seenRows(w.db, 2)[0].tour_done_at, row.tour_done_at);
		await call(w, "POST", ACK, { cookie: a, body: { ids: [R2.id] } });
		eq("I acknowledge after the tour keeps the tour's time and answers the note", [seenRows(w.db, 2)[0].tour_done_at, seenRows(w.db, 2)[0].acknowledged_at !== null, (await call(w, "GET", STATE, { cookie: a })).body.notes.map((n) => n.id)], [row.tour_done_at, true, [R1.id]]);
		const whole = await call(w, "POST", TOUR_DONE, { cookie: a, body: { ids: [releases.APP_TOUR_ROW] } });
		eq("the whole tour from the Kit works for an existing driver", whole.status, 200);
		eq("...and offers them nothing afterwards", (await call(w, "GET", STATE, { cookie: a })).body.tourOffered, false);
		eq("a made-up id is refused", (await call(w, "POST", TOUR_DONE, { cookie: a, body: { ids: ["made-up"] } })).status, 400);
		eq("the table holds these columns and no others", w.db.prepare("PRAGMA table_info(driver_release_seen)").all().map((c) => c.name), ["user_id", "release_id", "seen_at", "tour_done_at", "acknowledged_at"]);
		const newcomer = await signIn(w, "driver-new");
		eq("(the scene) a first-time driver's offer is waiting", (await call(w, "GET", STATE, { cookie: newcomer })).body.tourOffered, true);
		await call(w, "POST", TOUR_DONE, { cookie: newcomer, body: { ids: [releases.APP_TOUR_ROW] } });
		eq("finishing the whole tour from the Kit answers it", (await call(w, "GET", STATE, { cookie: newcomer })).body.tourOffered, false);
		await stopWorld(w);
	}
	{
		// A table made before the confirmation: the app adds the column at start, and keeps every row.
		const db = makeDb();
		db.exec("CREATE TABLE driver_release_seen (user_id INTEGER NOT NULL, release_id TEXT NOT NULL, seen_at TEXT, tour_done_at TEXT, PRIMARY KEY (user_id, release_id))");
		db.prepare("INSERT INTO driver_release_seen (user_id, release_id, seen_at) VALUES (?, ?, ?)").run(6, releases.APP_TOUR_ROW, "2026-11-01T12:00:00.000Z");
		const w = await startWorld({ db, list: TWO });
		eq("an older table gets the column", db.prepare("PRAGMA table_info(driver_release_seen)").all().map((c) => c.name), ["user_id", "release_id", "seen_at", "tour_done_at", "acknowledged_at"]);
		eq("...and keeps its rows", seenRows(db, 6), [{ release_id: releases.APP_TOUR_ROW, seen_at: "2026-11-01T12:00:00.000Z", tour_done_at: null, acknowledged_at: null }]);
		const a = await signIn(w, "driver-a");
		eq("...and a confirmation works on it", (await call(w, "POST", ACK, { cookie: a, body: { ids: [R1.id] } })).status, 200);
		await stopWorld(w);
		const again = await startWorld({ db, list: TWO });
		eq("a second start changes nothing", db.prepare("PRAGMA table_info(driver_release_seen)").all().length, 5);
		await stopWorld(again);
	}

	// ── §11 ─────────────────────────────────────────────────────────────────
	section("11 a failed read or write");
	{
		const db = makeDb();
		const w = await startWorld({ db, list: TWO });
		const signedIn = await signIn(w, "driver-a");
		const current = await signIn(w, "driver-b");
		db.exec("DROP TABLE driver_release_seen");

		const read = await call(w, "GET", STATE, { cookie: current });
		eq("no table: the answer is still 200, with nothing to show", [read.status, read.body], [200, NOTHING]);
		const write = await call(w, "POST", ACK, { cookie: current, body: { ids: [R1.id] } });
		eq("a confirmation that can't be saved says so, with its own code, so the app can say it wasn't", [write.status, write.body && write.body.code, write.body && write.body.success], [503, "RELEASE_UNAVAILABLE", undefined]);
		eq("...and no database text reaches them", /sqlite|no such table/i.test(write.text), false);
		const skip = await call(w, "POST", SEEN, { cookie: current, body: { ids: [releases.APP_TOUR_ROW] } });
		eq("a mark that can't be saved says so too", [skip.status, skip.body && skip.body.code], [503, "RELEASE_UNAVAILABLE"]);
		const record = await call(w, "GET", RECORD, { cookie: await signIn(w, "root-a") });
		eq("the record that can't be read says so, with its own code", [record.status, record.body && record.body.code], [503, "RELEASE_UNAVAILABLE"]);
		eq("...and no database text reaches the Super Admin", /sqlite|no such table/i.test(record.text), false);

		const newcomer = await call(w, "POST", "/api/auth/login", { body: { username: "driver-new", password: PW } });
		eq("a first sign-in works with no table", [newcomer.status, newcomer.body.success], [200, true]);
		const newRead = await call(w, "GET", STATE, { cookie: newcomer.cookie });
		eq("...and they read an empty answer", [newRead.status, newRead.body], [200, NOTHING]);
		await call(w, "POST", "/api/auth/logout", { cookie: signedIn });
		const back = await signIn(w, "driver-a");
		eq("a driver signing back in with no table reads an empty answer", (await call(w, "GET", STATE, { cookie: back })).body, NOTHING);
		await stopWorld(w);
	}
	{
		// A database that refuses the CREATE at boot: the app starts and every answer still comes.
		const refusing = makeDb();
		const realExec = refusing.exec.bind(refusing);
		refusing.exec = (sql) => {
			if (/driver_release_seen/.test(sql)) throw new Error("made-up failure");
			return realExec(sql);
		};
		let w = null;
		try { w = await startWorld({ db: refusing, list: [R1] }); } catch (e) { ok("the app starts without the table", false, e.message); }
		if (w) {
			refusing.exec = realExec;
			const c = await signIn(w, "driver-a");
			eq("the app starts without the table, and a driver reads an empty answer", (await call(w, "GET", STATE, { cookie: c })).body, NOTHING);
			await stopWorld(w);
		}
	}

	// ── §12 ─────────────────────────────────────────────────────────────────
	section("12 the wiring");
	const CODE = stripComments(SRC);
	ok("server.js mounts the routes", /const driverReleaseNotices = require\("\.\/lib\/driver-release-routes"\)\.mount\(app, \{/.test(CODE));
	ok("the sign-in hook goes to startSession", /onSessionStart: driverReleaseNotices\.startSession/.test(CODE));
	const login = stripComments(LOGIN_SRC);
	const at = (text, needle) => text.indexOf(needle);
	ok("login tells the hook after the password check, with the account as it stood before the stamp",
		at(login, "bcrypt.compare(") >= 0 && at(login, "bcrypt.compare(") < at(login, "signIn.sessionStarted(current)")
		&& at(login, "signIn.sessionStarted(current)") < at(login, "stampLastLogin(current.id)"));
	ok("change-password knows nothing of this", !/driverRelease/i.test(CHANGE_SRC));
	const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js")).map((f) => [`lib/${f}`, fs.readFileSync(path.join(ROOT, "lib", f), "utf8")]);
	const naming = (re) => [...(re.test(CODE) ? ["the main file"] : []), ...libFiles.filter(([, text]) => re.test(stripComments(text))).map(([name]) => name)];
	eq("only the routes file reads or writes the table: no pay, invoice or broker code does", naming(/driver_release_seen/), ["lib/driver-release-routes.js"]);
	eq("nothing goes in the session: no code names a release on it", naming(/session\.driverRelease/), []);
	const routesLib = stripComments(fs.readFileSync(path.join(ROOT, "lib", "driver-release-routes.js"), "utf8"));
	ok("the routes have nothing to say about a sign-in being due, or a session to end", !/signInDue|releaseId\b|session\.destroy|session\.regenerate|\.logout\b/.test(routesLib));
	ok("the list and its rules have nothing to say about it either", !/signInDue|sessionIsBehind|sign-out|signOut/.test(stripComments(fs.readFileSync(path.join(ROOT, "lib", "driver-releases.js"), "utf8"))));
	const sqlCalls = [...routesLib.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)].map((m) => m[2]);
	ok("the SQL is there to check", sqlCalls.length >= 4, sqlCalls.length);
	ok("every statement is parameterized: nothing is built into its text", sqlCalls.every((sql) => !sql.includes("${")));
	const snapshot = fs.readFileSync(path.join(ROOT, "scripts", "fixtures", "route-snapshot.txt"), "utf8");
	for (const line of ["GET /api/driver/me/release ·", "POST /api/driver/me/release/acknowledge ·", "POST /api/driver/me/release/seen ·", "POST /api/driver/me/release/tour-done ·", "GET /api/admin/driver-release/acknowledgements ·"]) ok(`the route snapshot lists ${line.split(" ·")[0]}`, snapshot.includes(line));
	const rules = require("../lib/replica-rules.js");
	eq("a replica's --enable refuses the switch as a kill switch", rules.enableRefusal("DRIVER_RELEASE_NOTICES_ENABLED"), rules.ENABLE_REFUSED.DRIVER_RELEASE_NOTICES_ENABLED);
	ok("...with that reason", /kill switch/.test(String(rules.ENABLE_REFUSED.DRIVER_RELEASE_NOTICES_ENABLED)));
	const template = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
	ok("the settings template documents the switch, commented, as a kill switch", /^# DRIVER_RELEASE_NOTICES_ENABLED=false$/m.test(template) && /KILL SWITCH/.test(template.slice(template.indexOf("New-feature notices for drivers"), template.indexOf("# DRIVER_RELEASE_NOTICES_ENABLED=false"))));
	ok("...and says it signs nobody out", /signs nobody out/.test(template.slice(template.indexOf("New-feature notices for drivers"), template.indexOf("# DRIVER_RELEASE_NOTICES_ENABLED=false"))));
	const prTemplate = fs.readFileSync(path.join(ROOT, ".github", "pull_request_template.md"), "utf8");
	ok("the PR template asks for an entry", prTemplate.includes("Driver-facing? Add a `lib/driver-releases.js` entry, or say why not."));

	// ── §13 ─────────────────────────────────────────────────────────────────
	section("13 the record");
	{
		const clock = Date.parse("2026-11-12T20:04:00.000Z");
		const AT = "2026-11-12T20:04:00.000Z";
		const db = makeDb();
		const add = db.prepare("INSERT INTO users (id, username, password_hash, role, driver_name, email, full_name, company_name, must_change_password, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?)");
		add.run(10, "driver-unnamed", HASH, "Driver", "", "unnamed@example.test", "", STAMPED);
		add.run(11, "driver-later", HASH, "Driver", "Sam Later", "sam@example.test", "Sam Later", null);
		const w = await startWorld({ db, list: TWO, now: () => clock });
		await call(w, "POST", ACK, { cookie: await signIn(w, "driver-a"), body: { ids: [R2.id] } });
		await call(w, "POST", ACK, { cookie: await signIn(w, "driver-pct"), body: { ids: [R2.id, R1.id] } });
		await signIn(w, "driver-new");
		await call(w, "POST", TOUR_DONE, { cookie: await signIn(w, "driver-b"), body: { ids: [R2.id] } });
		// Morgan confirmed and then left; Taylor left without confirming anything.
		db.prepare("UPDATE users SET disabled_at = ? WHERE id IN (7, 8)").run("2026-11-12T21:00:00.000Z");
		const r = await call(w, "GET", RECORD, { cookie: await signIn(w, "root-a") });
		eq("a Super Admin reads it", r.status, 200);
		eq("it's never kept by a cache", r.headers["cache-control"], "private, no-store");
		const notices = (r.body && Array.isArray(r.body.notices) && r.body.notices.length === 2) ? r.body.notices : [{ drivers: [] }, { drivers: [] }];
		eq("one block per notice, newest first, each with its title and date", notices.map((n) => [n.id, n.title, n.date]), [[R2.id, "Second", "2026-02-01"], [R1.id, "First", "2026-01-01"]]);
		const rowsOf = (n) => n.drivers.map((x) => [x.name, x.state, x.at]);
		eq("the newest notice: every active driver and Morgan, who confirmed before leaving; not Taylor", rowsOf(notices[0]), [
			["", "not-yet", null],
			["Casey Example", "acknowledged", AT],
			["Jordan Newhire", "started-after", null],
			["Morgan Percent", "acknowledged", AT],
			["Riley Sample", "not-yet", null],
			["Sam Later", "started-after", null],
		]);
		eq("...the older one, from the same rows", rowsOf(notices[1]), [
			["", "not-yet", null],
			["Casey Example", "not-yet", null],
			["Jordan Newhire", "started-after", null],
			["Morgan Percent", "acknowledged", AT],
			["Riley Sample", "not-yet", null],
			["Sam Later", "started-after", null],
		]);
		eq("a finished tour is no confirmation: Riley is not yet", (notices[0].drivers.find((x) => x.name === "Riley Sample") || {}).state, "not-yet");
		eq("the count leaves out those never asked", notices.map((n) => [n.acknowledged, n.asked]), [[2, 4], [1, 4]]);
		eq("a notice holds these fields and no others", Object.keys(notices[0]).sort(), ["acknowledged", "asked", "date", "drivers", "id", "title"]);
		eq("a driver's row holds a name, a state and a time, and nothing else", [...new Set(notices.flatMap((n) => n.drivers.map((x) => Object.keys(x).sort().join(","))))], ["at,name,state"]);
		eq("no login, email, account id or other role in it", /@example\.test|driver-|"username"|"user_id"|"email"|Desk Example|Root Example|Backer Example|password/.test(r.text), false);
		eq("the answer is the notices and nothing else", Object.keys(r.body || {}), ["notices"]);
		await stopWorld(w);
	}
	if (typeof releases.acknowledgementRecord === "function") {
		const people = [
			{ id: 1, driver_name: "Avery Sample", full_name: "", disabled_at: null, last_login_at: STAMPED },
			{ id: 2, driver_name: "", full_name: "Blake Example", disabled_at: "", last_login_at: STAMPED },
		];
		eq("an empty list makes an empty record", releases.acknowledgementRecord([], people, []), []);
		eq("a name comes from the driver name, else the full name", releases.acknowledgementRecord([R1], people, [])[0].drivers.map((x) => x.name), ["Avery Sample", "Blake Example"]);
		eq("a row with only a tour mark is no confirmation", releases.acknowledgementRecord([R1], people, [{ user_id: 1, release_id: R1.id, seen_at: null, acknowledged_at: null }])[0].drivers[0].state, "not-yet");
		eq("a row with seen_at alone came from a first sign-in", releases.acknowledgementRecord([R1], people, [{ user_id: 1, release_id: R1.id, seen_at: STAMPED, acknowledged_at: null }])[0].drivers[0].state, "started-after");
		eq("another notice's row doesn't count", releases.acknowledgementRecord([R1], people, [{ user_id: 1, release_id: R2.id, seen_at: STAMPED, acknowledged_at: STAMPED }])[0].drivers[0].state, "not-yet");
	} else {
		ok("the record's rule is there to test", false);
	}

	for (const w of worlds) if (w.db.open) w.db.close();
	console.error = realError;
	console.warn = realWarn;
	if (failures.length) {
		console.log(`\nFAILED: ${failures.length} of ${pass + failures.length}`);
		process.exit(1);
	}
	console.log(`\nok: ${pass} checks`);
	process.exit(0);
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
