#!/usr/bin/env node
/**
 * Account disable: the rules in lib/account-disable.js, and the source pins that
 * keep server.js on them.
 *
 * WHAT IS ASSERTED:
 *   §1 one test of "enabled": ENABLED_SQL in SQLite and isDisabledRow() in JS
 *      agree on NULL, '', a blank, a stamp and "0"
 *   §2 the switch is on only when ACCOUNT_DISABLE_ENABLED is exactly "true"
 *   §3 the optional reason: trimmed, control characters dropped, at most 200
 *      characters, text only
 *   §4 disableDecision(): the switch, self (id or username), the role, the
 *      protected list, the last enabled Super Admin, the acting account, then
 *      "unchanged", in that order; a refused actor never learns the state; with
 *      no list read, a Super Admin is refused with a message that says so
 *   §5 enableDecision(): never gated by the switch; the protected list, the
 *      acting account, then "unchanged"
 *   §6 otherEnabledSuperAdmins() counts enabled Super Admins only
 *   §7 sessionEndReason(), and server.js's signOutEndedAccount() agrees with it
 *      case by case, lifted with nothing but `db`; an unreadable users table
 *      keeps the session and logs once
 *   §8 the notices: the reason HTML-escaped, no address in them; at most one
 *      sign-in notice an hour per account
 *   §9 source pins over comment-stripped server.js: the migration, the mounts,
 *      every Super Admin count on enabled accounts, one spelling of the JS test,
 *      the sign-in order, the socket liveness, the guards untouched
 *
 * Pure apart from an in-memory SQLite. No app.db, no network.
 * SERVER_JS=<path> reads another server.js (a base commit fails §7 and §9).
 * Run: node scripts/test-account-disable-rules.js    # exits 1 on failure
 */
"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

function finish() {
	console.log(`\n${pass} passed, ${failures.length} failed`);
	if (failures.length) {
		console.log("\nFailures:");
		for (const f of failures) console.log(`  ✗ ${f}`);
		process.exit(1);
	}
}

let lib = null;
try { lib = require(path.join(ROOT, "lib", "account-disable.js")); } catch (e) { lib = null; }
ok(!!lib, "lib/account-disable.js exists and loads");
let Database = null;
try { Database = require("better-sqlite3"); } catch { Database = null; }
ok(!!Database, "better-sqlite3 loads (run under the .nvmrc Node)");
if (!lib || !Database) finish();

// ── lifting ─────────────────────────────────────────────────────────────────
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
// A top-level function declaration to the `}` that closes it in column 0, or null.
function liftFunction(head) {
	const needle = `\n${head}`;
	if (SRC.split(needle).length - 1 !== 1) return null;
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	return end < 0 ? null : SRC.slice(a, end + 2);
}
// A route registration from its head to the `});` that closes it in column 0, or null.
function liftRoute(head) {
	if (SRC.split(head).length - 1 !== 1) return null;
	const a = SRC.indexOf(head);
	const end = SRC.indexOf("\n});", a);
	return end < 0 ? null : SRC.slice(a, end + "\n});".length);
}

const SA = (id, username, extra = {}) => ({ id, username, role: "Super Admin", disabled_at: null, ...extra });
const list = (state, ids = []) => ({ state, ids, isListedId: (id) => state === "valid" && ids.includes(Number(id)) });
const STAMP = "2026-10-20T14:00:00.000Z";

// ── §1 ───────────────────────────────────────────────────────────────────────
{
	const db = new Database(":memory:");
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, disabled_at TEXT DEFAULT NULL)");
	const values = [null, "", " ", STAMP, "0"];
	values.forEach((v, i) => db.prepare("INSERT INTO t (id, disabled_at) VALUES (?, ?)").run(i + 1, v));
	const sqlEnabled = db.prepare(`SELECT id FROM t WHERE ${lib.ENABLED_SQL} ORDER BY id`).all().map((r) => r.id);
	const jsEnabled = values.map((v, i) => (lib.isDisabledRow({ disabled_at: v }) ? null : i + 1)).filter(Boolean);
	eq(sqlEnabled, [1, 2], "§1 ENABLED_SQL: NULL and '' are enabled, anything else is disabled");
	eq(jsEnabled, sqlEnabled, "§1 isDisabledRow() agrees with ENABLED_SQL value by value");
	eq(lib.ENABLED_SQL, "COALESCE(disabled_at, '') = ''", "§1 the one SQL fragment");
	ok(lib.isDisabledRow(null) === false && lib.isDisabledRow({}) === false, "§1 no row, or a row without the column, is not disabled");
	db.close();
}

// ── §2 ───────────────────────────────────────────────────────────────────────
{
	ok(lib.accountDisableEnabled({ env: { ACCOUNT_DISABLE_ENABLED: "true" } }) === true, "§2 exactly \"true\" turns the switch on");
	for (const v of [undefined, "", "TRUE", "True", "1", "yes", "on", " true", "true ", "false"]) {
		ok(lib.accountDisableEnabled({ env: v === undefined ? {} : { ACCOUNT_DISABLE_ENABLED: v } }) === false,
			`§2 ${JSON.stringify(v)} leaves the switch off`);
	}
}

// ── §3 ───────────────────────────────────────────────────────────────────────
{
	eq(lib.readReason(undefined), { reason: null }, "§3 no reason");
	eq(lib.readReason(null), { reason: null }, "§3 a null reason");
	eq(lib.readReason("   "), { reason: null }, "§3 a blank reason is none");
	eq(lib.readReason("  Left the company  "), { reason: "Left the company" }, "§3 trimmed");
	eq(lib.readReason("Shared\nlogin\tretired"), { reason: "Shared login retired" }, "§3 line breaks and tabs become spaces");
	eq(lib.readReason("x".repeat(200)), { reason: "x".repeat(200) }, "§3 200 characters are kept");
	const long = lib.readReason("x".repeat(201));
	ok(long.refusal && long.refusal.status === 400 && long.refusal.code === "REASON_TOO_LONG", "§3 201 characters: 400 REASON_TOO_LONG");
	for (const bad of [5, {}, ["a"], true]) {
		const r = lib.readReason(bad);
		ok(r.refusal && r.refusal.status === 400 && r.refusal.code === "INVALID_REASON", `§3 ${JSON.stringify(bad)}: 400 INVALID_REASON`);
	}
	eq(lib.REASON_MAX, 200, "§3 the cap");
}

// ── §4 ───────────────────────────────────────────────────────────────────────
{
	const actor = { id: 8, username: "arvin_named", role: "Super Admin" };
	const base = {
		flagOn: true, actor, actorLive: true, actorRow: SA(8, "arvin_named"),
		target: SA(7, "owner_named"), otherEnabled: 1, listed: list("valid", [7, 8]),
	};
	const code = (facts) => {
		const d = lib.disableDecision(facts);
		return d.refusal ? `${d.refusal.status} ${d.refusal.code}` : d.unchanged ? "unchanged" : d.ok ? "ok" : JSON.stringify(d);
	};
	eq(code(base), "ok", "§4 a listed Super Admin disabling another listed one");
	eq(code({ ...base, flagOn: false }), "403 ACCOUNT_DISABLE_OFF", "§4 the switch off");
	eq(code({ ...base, flagOn: false, target: SA(8, "arvin_named") }), "403 ACCOUNT_DISABLE_OFF", "§4 ...is answered before anything else");
	eq(code({ ...base, target: SA(8, "arvin_named") }), "409 CANNOT_DISABLE_SELF", "§4 self, by id");
	eq(code({ ...base, actor: { username: "  Owner_Named ", role: "Super Admin" } }), "409 CANNOT_DISABLE_SELF",
		"§4 self, by username (a session without an id), case and edge spaces aside");
	for (const role of ["Driver", "Investor"]) {
		eq(code({ ...base, target: { id: 30, username: "someone", role, disabled_at: null } }), "409 ROLE_NOT_DISABLEABLE", `§4 a ${role}`);
	}
	eq(code({ ...base, target: { id: 30, username: "dana", role: "Driver", disabled_at: null }, actor: { id: 30, username: "dana", role: "Super Admin" } }),
		"409 CANNOT_DISABLE_SELF", "§4 self comes before the role");
	const dispatcher = { id: 20, username: "desk_one", role: "Dispatcher", disabled_at: null };
	eq(code({ ...base, target: dispatcher, listed: list("unset") }), "ok", "§4 a Dispatcher with the list unset");
	eq(code({ ...base, listed: list("unset") }), "403 PROTECTED_ACCOUNT", "§4 any Super Admin with the list unset");
	const unsetRefusal = lib.disableDecision({ ...base, listed: list("unset") }).refusal;
	ok(!!unsetRefusal && /until the server's protected-account list is set/.test(unsetRefusal.error), "§4 ...saying the list waits to be set");
	const unread = lib.UNREAD_LIST;
	ok(!!unread && Object.isFrozen(unread) && unread.state === "unread" && unread.ids.length === 0 && unread.isListedId(1) === false,
		"§4 UNREAD_LIST: the list a build that reads no protected-account setting hands the routes");
	const notRead = lib.disableDecision({ ...base, listed: unread }).refusal;
	ok(!!notRead && notRead.code === "PROTECTED_ACCOUNT" && /doesn't read/.test(notRead.error) && !/is set/.test(notRead.error),
		`§4 with no list read, a Super Admin disable is refused, saying the server doesn't read the list, never that it isn't set (got ${JSON.stringify(notRead && notRead.error)})`);
	eq(code({ ...base, target: dispatcher, listed: unread }), "ok", "§4 ...and a Dispatcher is disabled");
	eq(code({ ...base, target: SA(1, "root_admin"), actor: { id: 9, username: "desk_sa", role: "Super Admin" }, actorRow: SA(9, "desk_sa"), listed: list("valid", [1, 7]) }),
		"403 PROTECTED_ACCOUNT", "§4 an unlisted Super Admin disabling a listed one");
	eq(code({ ...base, target: SA(1, "root_admin"), actor: { id: 7, username: "owner_named", role: "Super Admin" }, actorRow: SA(7, "owner_named"), listed: list("valid", [1, 7]) }),
		"ok", "§4 a listed Super Admin disabling a listed one");
	eq(code({ ...base, target: SA(9, "desk_sa"), listed: list("valid", [1, 7]) }), "ok", "§4 an unlisted target with a valid list");
	eq(code({ ...base, listed: list("invalid") }), "403 PROTECTED_ACCOUNT", "§4 a list set but invalid: every Super Admin");
	eq(code({ ...base, target: dispatcher, listed: list("invalid") }), "ok", "§4 ...and no Dispatcher");
	eq(code({ ...base, listed: { state: "garbled" } }), "403 PROTECTED_ACCOUNT", "§4 a list in no known state is read as invalid");
	eq(code({ ...base, listed: undefined }), "403 PROTECTED_ACCOUNT", "§4 no list at all is read as unset");
	eq(code({ ...base, otherEnabled: 0 }), "409 LAST_SUPER_ADMIN", "§4 the last enabled Super Admin");
	eq(code({ ...base, otherEnabled: 0, actorRow: SA(8, "arvin_named", { disabled_at: STAMP }) }), "409 LAST_SUPER_ADMIN",
		"§4 ...also when the acting account's own row was disabled meanwhile");
	eq(code({ ...base, otherEnabled: undefined }), "409 LAST_SUPER_ADMIN", "§4 an unknown count refuses");
	eq(code({ ...base, otherEnabled: 0, target: SA(7, "owner_named", { disabled_at: STAMP }) }), "unchanged",
		"§4 an already disabled Super Admin is not the last enabled one");
	eq(code({ ...base, actorLive: false }), "401 SESSION_ENDED", "§4 the acting session no longer in the store");
	eq(code({ ...base, actorRow: null }), "401 SESSION_ENDED", "§4 the acting account removed");
	eq(code({ ...base, actorRow: SA(8, "arvin_named", { disabled_at: STAMP }) }), "401 SESSION_ENDED", "§4 the acting account disabled");
	eq(code({ ...base, actorRow: { ...SA(8, "arvin_named"), role: "Dispatcher" } }), "401 SESSION_ENDED", "§4 the acting account demoted");
	eq(code({ ...base, target: SA(7, "owner_named", { disabled_at: STAMP }) }), "unchanged", "§4 already disabled: unchanged");
	eq(code({ ...base, target: SA(7, "owner_named", { disabled_at: STAMP }), actor: { id: 9, username: "desk_sa", role: "Super Admin" }, actorRow: SA(9, "desk_sa") }),
		"403 PROTECTED_ACCOUNT", "§4 a refused actor gets the refusal, not \"unchanged\"");
	eq(code({ ...base, target: SA(7, "owner_named", { disabled_at: STAMP }), actorLive: false }), "401 SESSION_ENDED",
		"§4 ...and so does an ended session");
	const self = lib.disableDecision({ ...base, target: SA(8, "arvin_named") });
	ok(self.refusal && typeof self.refusal.error === "string" && self.refusal.error.length > 10 && typeof self.refusal.tail === "string",
		"§4 a refusal carries a message and an audit tail");
}

// ── §5 ───────────────────────────────────────────────────────────────────────
{
	const actor = { id: 8, username: "arvin_named", role: "Super Admin" };
	const base = { actor, actorLive: true, actorRow: SA(8, "arvin_named"), target: SA(7, "owner_named", { disabled_at: STAMP }), listed: list("valid", [7, 8]) };
	const code = (facts) => {
		const d = lib.enableDecision(facts);
		return d.refusal ? `${d.refusal.status} ${d.refusal.code}` : d.unchanged ? "unchanged" : d.ok ? "ok" : JSON.stringify(d);
	};
	eq(code(base), "ok", "§5 enabling a disabled account");
	eq(code({ ...base, flagOn: false }), "ok", "§5 the switch is never consulted");
	eq(code({ ...base, listed: list("unset") }), "ok", "§5 the list unset: a Super Admin is enabled");
	eq(code({ ...base, listed: lib.UNREAD_LIST }), "ok", "§5 no list read: a Super Admin is enabled, as with the list unset");
	eq(code({ ...base, target: SA(1, "root_admin", { disabled_at: STAMP }), actor: { id: 9, username: "desk_sa", role: "Super Admin" }, actorRow: SA(9, "desk_sa"), listed: list("valid", [1, 7]) }),
		"403 PROTECTED_ACCOUNT", "§5 an unlisted Super Admin enabling a listed one");
	eq(code({ ...base, target: SA(1, "root_admin", { disabled_at: STAMP }), actor: { id: 7, username: "owner_named", role: "Super Admin" }, actorRow: SA(7, "owner_named"), listed: list("valid", [1, 7]) }),
		"ok", "§5 a listed one enabling a listed one");
	eq(code({ ...base, listed: list("invalid") }), "403 PROTECTED_ACCOUNT", "§5 a list set but invalid: every Super Admin");
	eq(code({ ...base, target: { id: 20, username: "desk_one", role: "Dispatcher", disabled_at: STAMP }, listed: list("invalid") }), "ok", "§5 ...and no Dispatcher");
	eq(code({ ...base, actorLive: false }), "401 SESSION_ENDED", "§5 the acting session ended");
	eq(code({ ...base, actorRow: SA(8, "arvin_named", { disabled_at: STAMP }) }), "401 SESSION_ENDED", "§5 the acting account disabled");
	eq(code({ ...base, target: SA(7, "owner_named") }), "unchanged", "§5 already enabled: unchanged");
	eq(code({ ...base, target: SA(1, "root_admin"), actor: { id: 9, username: "desk_sa", role: "Super Admin" }, actorRow: SA(9, "desk_sa"), listed: list("valid", [1, 7]) }),
		"403 PROTECTED_ACCOUNT", "§5 a refused actor gets the refusal, not \"unchanged\"");
}

// ── §6 ───────────────────────────────────────────────────────────────────────
{
	const db = new Database(":memory:");
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, disabled_at TEXT DEFAULT NULL)");
	db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (1, 'root_admin', 'Super Admin', NULL)").run();
	db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (7, 'owner_named', 'Super Admin', ?)").run(STAMP);
	db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (20, 'desk_one', 'Dispatcher', NULL)").run();
	eq(lib.otherEnabledSuperAdmins(db, 1), 0, "§6 #1 enabled and #7 disabled: no other enabled Super Admin for #1");
	eq(lib.otherEnabledSuperAdmins(db, 7), 1, "§6 ...one for #7");
	db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (8, 'arvin_named', 'Super Admin', '')").run();
	eq(lib.otherEnabledSuperAdmins(db, 1), 1, "§6 a Super Admin whose disabled_at is '' counts as enabled");
	ok(lib.OTHER_ENABLED_SUPER_ADMINS_SQL.includes(lib.ENABLED_SQL), "§6 the count uses the one fragment");
	db.close();
}

// ── §7 ───────────────────────────────────────────────────────────────────────
const SESSION_CASES = [
	["enabled, same role", { id: 7, role: "Dispatcher" }, { role: "Dispatcher", disabled_at: null }, null],
	["disabled", { id: 7, role: "Dispatcher" }, { role: "Dispatcher", disabled_at: STAMP }, "disabled"],
	["disabled and re-roled", { id: 7, role: "Super Admin" }, { role: "Dispatcher", disabled_at: STAMP }, "disabled"],
	["the row is gone", { id: 7, role: "Dispatcher" }, null, "account not found"],
	["the cached role differs", { id: 7, role: "Super Admin" }, { role: "Dispatcher", disabled_at: null }, "role changed"],
	["no id", { role: "Dispatcher" }, { role: "Dispatcher", disabled_at: null }, "no account id"],
	["id 0", { id: 0, role: "Dispatcher" }, { role: "Dispatcher", disabled_at: null }, "no account id"],
	["id \"abc\"", { id: "abc", role: "Dispatcher" }, { role: "Dispatcher", disabled_at: null }, "no account id"],
	["id \"7\" (a string)", { id: "7", role: "Dispatcher" }, { role: "Dispatcher", disabled_at: null }, "no account id"],
	["id -7", { id: -7, role: "Dispatcher" }, { role: "Dispatcher", disabled_at: null }, "no account id"],
	["id 7.5", { id: 7.5, role: "Dispatcher" }, { role: "Dispatcher", disabled_at: null }, "no account id"],
];
{
	for (const [label, user, row, want] of SESSION_CASES) eq(lib.sessionEndReason(user, row), want, `§7 sessionEndReason: ${label}`);
	eq(lib.sessionAccountId({ id: 7 }), 7, "§7 sessionAccountId: a positive whole number");
	eq(lib.sessionAccountId({ id: "7" }), null, "§7 ...stored as one");
	eq(lib.sessionAccountId(null), null, "§7 ...or null");

	const MW = liftFunction("function signOutEndedAccount(req, res, next) {");
	ok(!!MW, "§7 server.js defines signOutEndedAccount(req, res, next)");
	if (MW) {
		const logs = [];
		const realWarn = console.warn;
		const realError = console.error;
		console.warn = (...a) => logs.push(a.join(" "));
		console.error = (...a) => logs.push(a.join(" "));
		try {
			for (const [label, user, row, want] of SESSION_CASES) {
				const db = new Database(":memory:");
				db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, disabled_at TEXT DEFAULT NULL)");
				if (row) db.prepare("INSERT INTO users (id, username, role, disabled_at) VALUES (7, 'u7', ?, ?)").run(row.role, row.disabled_at);
				// Only `db`: any other module-scope name it reached for would throw here.
				const mw = new Function("db", `${MW}\nreturn signOutEndedAccount;`)(db);
				const req = { session: { user: { username: "u7", ...user } } };
				let nexted = 0;
				mw(req, {}, () => nexted++);
				ok(nexted === 1, `§7 the middleware calls next() once (${label})`);
				eq(!req.session.user, want !== null, `§7 the middleware signs the session out exactly when sessionEndReason() says so (${label})`);
				db.close();
			}
			// No session, or a session without a user: nothing read, nothing changed.
			let reads = 0;
			const counting = { prepare() { reads++; return { get: () => undefined }; } };
			const mw = new Function("db", `${MW}\nreturn signOutEndedAccount;`)(counting);
			let nexted = 0;
			mw({ session: {} }, {}, () => nexted++);
			mw({}, {}, () => nexted++);
			ok(nexted === 2 && reads === 0, "§7 a request with no signed-in user reads nothing");
			// An unreadable users table keeps the session, and logs at most once a minute.
			const broken = new Database(":memory:");
			const mw2 = new Function("db", `${MW}\nreturn signOutEndedAccount;`)(broken);
			delete globalThis.__accountCheckErrLoggedAt;
			logs.length = 0;
			const req1 = { session: { user: { id: 7, role: "Dispatcher" } } };
			const req2 = { session: { user: { id: 7, role: "Dispatcher" } } };
			mw2(req1, {}, () => {});
			mw2(req2, {}, () => {});
			ok(!!req1.session.user && !!req2.session.user, "§7 an unreadable users table keeps the session");
			eq(logs.filter((l) => /account check failed/.test(l)).length, 1, "§7 ...and logs once a minute, not per request");
			broken.close();
		} finally {
			console.warn = realWarn;
			console.error = realError;
		}
	}
}

// ── §8 ───────────────────────────────────────────────────────────────────────
{
	const at = new Date("2026-10-28T15:04:00Z");
	const HTML = "<img src=x onerror=alert(1)>";
	const n = lib.switchNotice({
		kind: "disable", at, timeZone: "America/New_York", reason: HTML,
		target: { id: 7, username: "owner_named", role: "Super Admin" }, actor: { id: 8, username: "arvin_named" },
	});
	ok(n && typeof n.subject === "string" && typeof n.heading === "string" && typeof n.bodyHtml === "string", "§8 a disable notice has a subject, a heading and a body");
	ok(!n.bodyHtml.includes("<img") && n.bodyHtml.includes("&lt;img src=x onerror=alert(1)&gt;"), "§8 the reason is HTML-escaped in the body");
	ok(/disabled/i.test(n.subject) && n.bodyHtml.includes("owner_named") && n.bodyHtml.includes("arvin_named") && n.bodyHtml.includes("#7"),
		"§8 it names the account, its id and who switched it");
	ok(/11:04\s?AM/.test(n.bodyHtml) && /EDT/.test(n.bodyHtml), "§8 the time is the business clock's (15:04 UTC is 11:04 AM EDT)");
	ok(!/@/.test(JSON.stringify(n)), "§8 it carries no address: the caller sends it to ADMIN_NOTIFY_EMAIL alone");
	const e = lib.switchNotice({ kind: "enable", at, timeZone: "America/New_York", target: { id: 7, username: "owner_named", role: "Super Admin" }, actor: { id: 8, username: "arvin_named" } });
	ok(/enabled/i.test(e.subject) && !/reason/i.test(e.bodyHtml), "§8 an enable notice, with no reason line when none was given");
	const nameHtml = lib.switchNotice({ kind: "disable", at, timeZone: "America/New_York", target: { id: 7, username: "a<b>", role: "Dispatcher" }, actor: { id: 8, username: "c&d" } });
	ok(nameHtml.bodyHtml.includes("a&lt;b&gt;") && nameHtml.bodyHtml.includes("c&amp;d"), "§8 usernames are escaped too");
	const s = lib.disabledSignInNotice({ account: { id: 7, username: "owner_named", role: "Super Admin" }, at, timeZone: "America/New_York" });
	ok(s && /disabled/i.test(s.subject) && s.bodyHtml.includes("owner_named") && s.bodyHtml.includes("#7") && !/@/.test(JSON.stringify(s)),
		"§8 a refused sign-in notice names the account and carries no address");
	const w = lib.noticeWindow(60 * 60 * 1000);
	const t0 = Date.parse("2026-10-28T15:00:00Z");
	eq([w.allow(7, t0), w.allow(7, t0 + 1000), w.allow(8, t0 + 1000), w.allow(7, t0 + 59 * 60 * 1000), w.allow(7, t0 + 60 * 60 * 1000)],
		[true, false, true, false, true], "§8 one notice an hour per account");
	eq(lib.DISABLED_MESSAGE, "This account is disabled. Contact your administrator.", "§8 the sign-in message");
}

// ── §9 ───────────────────────────────────────────────────────────────────────
{
	const code = stripComments(SRC);
	for (const [col, type] of [["disabled_at", "TEXT"], ["disabled_by", "INTEGER"], ["disabled_reason", "TEXT"]]) {
		ok(code.includes(`try { db.exec("ALTER TABLE users ADD COLUMN ${col} ${type} DEFAULT NULL"); } catch {}`),
			`§9 the migration adds users.${col} ${type} DEFAULT NULL in the house pattern`);
	}
	const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
	const refreshAt = lines.indexOf("app.use(refreshPasswordChangeFlag);");
	eq([lines[refreshAt + 1], lines[refreshAt + 2]], ["app.use(signOutEndedAccount);", "io.engine.use(signOutEndedAccount);"],
		"§9 signOutEndedAccount is mounted directly below the password-change refresh, and on the Socket.IO handshake");
	eq(lines.filter((l) => /\b(app|io\.engine)\.use\(signOutEndedAccount\)/.test(l)).length, 2, "§9 ...exactly twice");

	const counts = code.match(/SELECT COUNT\(\*\)[^"`]*FROM users[^"`]*/g) || [];
	const saCounts = counts.filter((s) => /role = 'Super Admin'/.test(s));
	ok(saCounts.length >= 1 && saCounts.every((s) => s.includes(lib.ENABLED_SQL)),
		`§9 every Super Admin count in server.js counts enabled accounts only (found: ${JSON.stringify(saCounts)})`);
	const put = liftRoute('app.put("/api/users/:id", requireRole("Super Admin"), userPasswordResetLimiter, async (req, res) => {');
	const del = liftRoute('app.delete("/api/users/:id", requireRole("Super Admin"), (req, res) => {');
	const dis = liftRoute('app.post("/api/users/:id/disable", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {');
	const ena = liftRoute('app.post("/api/users/:id/enable", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {');
	ok(!!dis && !!ena, "§9 the disable and enable routes exist, Super Admin only, behind refuseCrossOrigin");
	ok(!!put && stripComments(put).includes(JSON.stringify(lib.OTHER_ENABLED_SUPER_ADMINS_SQL)),
		"§9 PUT /api/users/:id counts the other Super Admins with OTHER_ENABLED_SUPER_ADMINS_SQL, word for word");
	ok(!!del && stripComments(del).includes("accountDisable.otherEnabledSuperAdmins(db, id)"), "§9 DELETE /api/users/:id calls otherEnabledSuperAdmins()");
	ok(!!dis && stripComments(dis).includes("accountDisable.otherEnabledSuperAdmins(db, id)"), "§9 the disable route calls otherEnabledSuperAdmins()");

	const jsTests = code.match(/[\w$.]*\.disabled_at\b[^\n;]{0,12}/g) || [];
	ok(!/!\s*[\w$.]+\.disabled_at\b/.test(code) && !/\.disabled_at\s*(\|\||&&|\?(?!\?))/.test(code),
		`§9 no truthiness test of disabled_at, which would read a blank as enabled (found: ${JSON.stringify(jsTests.slice(0, 8))})`);
	ok((code.match(/String\([\w$.]+\.disabled_at \?\? ""\) [!=]== ""/g) || []).length >= 5,
		"§9 the JS test is spelled String(x.disabled_at ?? \"\") !== \"\" (or === \"\") wherever server.js makes it");

	const login = liftRoute('app.post("/api/auth/login", loginLimiter, async (req, res) => {');
	const L = login ? stripComments(login) : "";
	const at = (needle) => L.indexOf(needle);
	const first = at('if (String(user.disabled_at ?? "") !== "")');
	const second = at('if (String(current.disabled_at ?? "") !== "")');
	ok(first > at("await bcrypt.compare(") && first > at('return res.status(401).json({ error: "Invalid credentials" });') && first < at("rotating = true;"),
		"§9 sign-in refuses a disabled account only after the password check, and before the session rotates");
	ok(second > at('db.prepare("SELECT * FROM users WHERE id = ?").get(user.id)') && second < at("req.session.user = {") && second < at("stampLastLogin(current.id)"),
		"§9 ...and again on the row re-read after the rotation, before the session is built or the sign-in stamped");
	ok((L.match(/disabledSignInRefusal\(/g) || []).length === 2, "§9 ...both through disabledSignInRefusal()");

	const live = liftFunction("function liveSessionIds(sids) {");
	ok(!!live && /COALESCE\(users\.disabled_at, ''\) = ''/.test(live) && /datetime\('now'\) < datetime\(expire\)/.test(live),
		"§9 a socket's session is live only while its account row exists and is enabled (and the store's own expiry test stays)");
	const ioHandler = (() => {
		const a = SRC.indexOf('io.on("connection", (socket) => {');
		return a < 0 ? "" : stripComments(SRC.slice(a, SRC.indexOf("\n});", a)));
	})();
	const reg = ioHandler.indexOf('socket.on("register"');
	ok(reg > 0 && ioHandler.indexOf("liveSessionIds([sid])", reg) > ioHandler.indexOf("currentMustChangePassword(sessionUser)", reg),
		"§9 register joins no room once the account is disabled or gone (liveSessionIds after the password-change check)");

	for (const head of ["function requireAuth(req, res, next) {", "function requireRole(...roles) {"]) {
		const g = liftFunction(head);
		ok(!!g && !/disabled|signOutEndedAccount|accountDisable/.test(g), `§9 ${head.split("(")[0]} is untouched (the pinned guard copies stay as they are)`);
	}
	const reset = liftFunction("function refreshOwnSession(req) {");
	ok(!!reset && /if \(!row \|\| String\(row\.disabled_at \?\? ""\) !== ""\) \{/.test(reset), "§9 refreshOwnSession() ends a disabled account's session instead of rebuilding it");
	ok(/\nconst ACCOUNT_DISABLE_ENABLED = accountDisable\.accountDisableEnabled\(\);\n/.test(SRC), "§9 the switch is read once, through accountDisableEnabled()");
	ok(/\nconst ACCOUNT_DISABLE_LIST = accountDisable\.UNREAD_LIST;\n/.test(SRC),
		"§9 server.js hands the switch routes UNREAD_LIST: it reads no protected-account list, and its refusal says so");
}

finish();
