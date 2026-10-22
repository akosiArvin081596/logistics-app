#!/usr/bin/env node
/**
 * scripts/test-protected-accounts.js — accounts on RATECON_PDF_VIEWER_IDS are
 * protected on PUT /api/users/:id and DELETE /api/users/:id.
 *
 * The rule (server.js guard (a0) on PUT, (a2) on DELETE; the decision is
 * lib/listed-accounts.js protectedChangeRefusal()):
 *   - a listed account's password, role or email changes, and it is removed,
 *     only when the acting account is that account or another listed one;
 *     anyone else gets 403 PROTECTED_ACCOUNT, nothing is written and the
 *     attempt is audited (update_user_blocked / delete_user_blocked);
 *   - other edits (the full name), and the Users page's unchanged role and
 *     email, go through as before;
 *   - a set but invalid list refuses those changes to every Super Admin, from
 *     everyone; an unset list protects nobody (the behaviour before the list).
 *
 * §1 PUT, list "1,7"   §2 DELETE, list "1,7"   §3 a set but invalid list
 * §4 unset             §5 placement in server.js (after PUT's last await, no
 *                      await before the write; before DELETE's lock guard)
 *
 * WHAT IS REAL. Both routes are lifted from server.js whole and run as shipped,
 * with the shipped audit helpers (logAudit, logAuditRefusal,
 * recordPeriodRefusal) writing a real audit_trail, the shipped password rules,
 * and the shipped lib/listed-accounts.js. The month-end lock, the sheet, the
 * cascade and the notices are stubs: no case here renames a driver. DELETE's
 * lock guard is stubbed "unreadable" so a request it reaches answers 409
 * PERIOD_LOCK_UNREADABLE and writes nothing: reaching it is what shows the
 * protected-account check let the request through.
 *
 * Made-up accounts: 1 and 7 listed Super Admins, 5 and 6 unlisted Super Admins,
 * 9 a Dispatcher. Made-up passwords and addresses.
 * Pure: no server, no port, no app.db, no network.
 * Run: node scripts/test-protected-accounts.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let passed = 0;
let failed = 0;
function ok(name, cond) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}`); }
}
function die(msg) { console.error(`FAIL  ${msg}`); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`a server dependency did not load (${e.message}); run it under the .nvmrc Node`); }
let listedAccounts = null;
try { listedAccounts = require(path.join(ROOT, "lib", "listed-accounts.js")); } catch (e) { ok(`lib/listed-accounts.js loads (${e.code || e.message})`, false); }
const passwordRules = require(path.join(ROOT, "lib", "password-rules.js"));

function findOnce(needle, what) {
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 ${what}, found ${hits}`);
	return SRC.indexOf(needle) + 1;
}
function liftFunction(name) {
	const a = findOnce(`\nfunction ${name}(`, `definition of ${name}()`);
	return SRC.slice(a, SRC.indexOf("\n}\n", a) + 2);
}
function liftConst(head, close = null) {
	const a = findOnce(`\n${head}`, `statement starting ${JSON.stringify(head)}`);
	const end = close ? SRC.indexOf(close, a) : SRC.indexOf(";\n", a);
	return SRC.slice(a, end + (close ? close.length : 1));
}
function liftRoute(head) {
	const a = findOnce(`\n${head}`, `registration ${head}`);
	return SRC.slice(a, SRC.indexOf("\n});", a) + "\n});".length);
}
const PUT_HEAD = 'app.put("/api/users/:id", requireRole("Super Admin"), userPasswordResetLimiter, async (req, res) => {';
const DELETE_HEAD = 'app.delete("/api/users/:id", requireRole("Super Admin"), (req, res) => {';
const PUT_ROUTE = liftRoute(PUT_HEAD);
const DELETE_ROUTE = liftRoute(DELETE_HEAD);

const AUDIT_SRC = [
	liftFunction("logAudit"),
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftFunction("logAuditRefusal"),
	liftFunction("scrubPurgeMarker"),
	liftConst("const AUDITED_UPSTREAM = "),
	liftFunction("auditText"),
	liftFunction("periodRefusalDetail"),
	liftFunction("recordPeriodRefusal"),
	liftFunction("normalizeDriverName"),
].join("\n");

function usersDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE users");
	const alters = ["full_name", "company_name", "must_change_password", "last_login_at"].map((col) => {
		const a = SRC.match(new RegExp(`ALTER TABLE users ADD COLUMN ${col} [^"]*`));
		if (!a) die(`could not locate the users.${col} migration`);
		return a[0];
	});
	return [`CREATE TABLE users (${m[1]}\n)`, ...alters];
}
function auditDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
}

const OWNER = { id: 1, username: "owner_admin", role: "Super Admin" };
const SECOND = { id: 7, username: "second_admin", role: "Super Admin" };
const STAFF = { id: 5, username: "staff_admin", role: "Super Admin" };
const OTHER = { id: 6, username: "other_admin", role: "Super Admin" };
const STAFF_AS_OWNER_NAME = { id: 5, username: "owner_admin", role: "Super Admin" };
const NO_ID = { username: "staff_admin", role: "Super Admin" };
const NEW_PASSWORD = "Made-Up-Pass-77!";

// One world per case: a fresh database and a fresh refusal-coalescing window, so
// every refusal is written in full.
function world(viewers) {
	const db = new Database(":memory:");
	for (const sql of usersDdl()) db.exec(sql);
	db.exec(auditDdl());
	const add = db.prepare("INSERT INTO users (id, username, password_hash, role, email, full_name, driver_name) VALUES (?, ?, 'old-hash', ?, ?, ?, '')");
	add.run(1, "owner_admin", "Super Admin", "owner@example.test", "Owner Admin");
	add.run(7, "second_admin", "Super Admin", "second@example.test", "Second Admin");
	add.run(5, "staff_admin", "Super Admin", "staff@example.test", "Staff Admin");
	add.run(6, "other_admin", "Super Admin", "other@example.test", "Other Admin");
	add.run(9, "desk", "Dispatcher", "desk@example.test", "Desk Person");
	const quiet = { log() {}, warn() {}, error() {} };
	const audit = new Function("db", "console", `"use strict";\n${AUDIT_SRC}\nreturn { logAudit, auditText, recordPeriodRefusal, normalizeDriverName };`)(db, quiet);
	const seen = { notices: [], purges: [], lockCalls: 0 };
	const list = listedAccounts ? listedAccounts.parseListedAccountIds(viewers) : undefined;
	let putHandler = null;
	let deleteHandler = null;
	const env = {
		app: {
			put: (p, ...h) => { putHandler = h[h.length - 1]; },
			delete: (p, ...h) => { deleteHandler = h[h.length - 1]; },
		},
		requireRole: () => (req, res, next) => next(),
		userPasswordResetLimiter: (req, res, next) => next(),
		db,
		console: quiet,
		RATECON_PDF_VIEWERS: list,
		...audit,
		passwordRules,
		// PUT: the month-end lock, the sheet, the cascade and the notices (no case renames a driver).
		getSheets: async () => ({ spreadsheets: { values: { get: async () => ({ data: { values: [["Load ID", "Driver"]] } }) } } }),
		SPREADSHEET_ID: "not-a-sheet",
		userUpdateLockBlockers: () => ({ unreadable: false, blockers: [] }),
		periodLabel: (p) => p,
		driverRenameMergeScan: () => ({ mergeTargets: {}, mergeRows: 0 }),
		applyDriverRenameSqlite: () => ({ counts: {} }),
		syncDriverToCarrierSheet: () => {},
		purgeUserSessions: (id) => { seen.purges.push(id); return 0; },
		notifyChange: () => {},
		refreshOwnSession: () => true,
		findDriverNameClash: () => null,
		findDriverNameClashes: () => [],
		accountDirectorySync: () => null,
		accountDirectorySyncLock: () => null,
		getJobTrackingCached: async () => ({ headers: [], data: [] }),
		periodBlockedResponse: () => {},
		periodLockUnreadableResponse: () => {},
		accountCompanyChange: () => null,
		findDirectoryRowForDriver: () => null,
		investorCompanyMoves: () => [],
		investorCompanyLockBlockers: () => null,
		notifyPasswordChanged: (id) => { seen.notices.push(id); },
		// DELETE: its month-end lock, unreadable, so a request that reaches it stops there.
		userDeleteLockBlockers: () => { seen.lockCalls++; return { unreadable: true, blockers: [] }; },
	};
	const names = Object.keys(env);
	new Function(...names, PUT_ROUTE)(...names.map((k) => env[k]));
	new Function(...names, DELETE_ROUTE)(...names.map((k) => env[k]));
	if (typeof putHandler !== "function" || typeof deleteHandler !== "function") die("a lifted route did not register a handler");
	const call = async (handler, actor, id, body) => {
		const out = { status: 200, body: null };
		const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; }, end() { return this; } };
		await handler({ session: { user: actor }, sessionID: "sid-test", params: { id: String(id) }, query: {}, body: body || {}, ip: "127.0.0.1" }, res);
		return out;
	};
	return {
		db, seen,
		put: (actor, id, body) => call(putHandler, actor, id, body),
		del: (actor, id) => call(deleteHandler, actor, id),
		row: (id) => db.prepare("SELECT id, username, role, email, full_name, password_hash FROM users WHERE id = ?").get(id),
		audits: (action) => db.prepare("SELECT user_id, username, action, entity, entity_id, details FROM audit_trail WHERE action = ? ORDER BY id").all(action),
	};
}
const code = (r) => r && r.body && r.body.code;

async function main() {
	// ── §1 PUT, list "1,7" ────────────────────────────────────────────────────
	console.log("\n§1 PUT /api/users/:id, RATECON_PDF_VIEWER_IDS=1,7");
	for (const [what, body, col, before] of [
		["password", { password: NEW_PASSWORD }, "password_hash", "old-hash"],
		["role", { role: "Dispatcher" }, "role", "Super Admin"],
		["email", { email: "taken-over@example.test" }, "email", "owner@example.test"],
	]) {
		for (const [who, actor] of [["unlisted Super Admin 5", STAFF], ["Super Admin 5 under account 1's username", STAFF_AS_OWNER_NAME], ["a session without an id", NO_ID]]) {
			const w = world("1,7");
			const r = await w.put(actor, 1, body);
			ok(`${who} changing account 1's ${what}: 403 PROTECTED_ACCOUNT (${r.status} ${code(r)})`, r.status === 403 && code(r) === "PROTECTED_ACCOUNT");
			ok(`...nothing written (${col} still ${JSON.stringify(w.row(1)[col])}), no notice, no session purge`, w.row(1)[col] === before && w.seen.notices.length === 0 && w.seen.purges.length === 0);
			const a = w.audits("update_user_blocked");
			ok(`...one update_user_blocked row with [PROTECTED_ACCOUNT] on user 1 (${a.length})`, a.length === 1 && a[0].entity === "user" && a[0].entity_id === "1" && a[0].details.includes("[PROTECTED_ACCOUNT]"));
		}
	}
	{
		const w = world("1,7");
		const r = await w.put(STAFF, 1, { role: "Dispatcher", password: NEW_PASSWORD, email: "x@example.test", fullName: "Renamed" });
		ok(`all three at once with a full name: refused whole, the full name not written either (${r.status})`, r.status === 403 && w.row(1).full_name === "Owner Admin" && w.row(1).password_hash === "old-hash");
		const a = w.audits("update_user_blocked");
		ok("...and the audit row names what was attempted, never the password", a.length === 1 && /password, role, email/.test(a[0].details) && !a[0].details.includes(NEW_PASSWORD));
	}
	{
		// What the Users page sends on a full-name edit: role and email unchanged.
		const w = world("1,7");
		const r = await w.put(STAFF, 1, { role: "Super Admin", driverName: "", email: "owner@example.test", fullName: "Owner A. Admin" });
		ok(`unlisted Super Admin 5 editing only account 1's full name (the Users page's shape): 200 (${r.status} ${code(r)})`, r.status === 200 && w.row(1).full_name === "Owner A. Admin");
		ok("...role, email and password untouched, and no refusal audited", w.row(1).role === "Super Admin" && w.row(1).email === "owner@example.test" && w.row(1).password_hash === "old-hash" && w.audits("update_user_blocked").length === 0);
	}
	{
		const w = world("1,7");
		const r = await w.put(SECOND, 1, { password: NEW_PASSWORD });
		ok(`listed account 7 resetting account 1's password: 200 (${r.status} ${code(r)})`, r.status === 200 && w.row(1).password_hash !== "old-hash");
		ok("...with the usual notice", w.seen.notices.length === 1 && w.seen.notices[0] === 1);
		const e = await world("1,7").put({ ...SECOND, id: "7" }, 1, { email: "new-owner@example.test" });
		ok(`listed account 7 (id as plain digits) changing account 1's email: 200 (${e.status})`, e.status === 200);
	}
	{
		const w = world("1,7");
		const r = await w.put(OWNER, 1, { email: "owner2@example.test" });
		ok(`account 1 changing its own email: 200 (${r.status} ${code(r)})`, r.status === 200 && w.row(1).email === "owner2@example.test");
	}
	{
		const w = world("1,7");
		const r = await w.put(STAFF, 6, { password: NEW_PASSWORD });
		ok(`unlisted Super Admin 5 resetting unlisted account 6's password: 200, as before (${r.status} ${code(r)})`, r.status === 200 && w.row(6).password_hash !== "old-hash");
		const d = await world("1,7").put(STAFF, 9, { role: "Driver" });
		ok(`...and changing Dispatcher 9's role: not refused as protected (${d.status} ${code(d)})`, code(d) !== "PROTECTED_ACCOUNT");
	}

	// ── §2 DELETE, list "1,7" ─────────────────────────────────────────────────
	console.log("\n§2 DELETE /api/users/:id, RATECON_PDF_VIEWER_IDS=1,7");
	// (A session under account 1's username is refused earlier, as CANNOT_DELETE_SELF.)
	for (const [who, actor] of [["unlisted Super Admin 5", STAFF], ["a session without an id", NO_ID]]) {
		const w = world("1,7");
		const r = await w.del(actor, 1);
		ok(`${who} removing account 1: 403 PROTECTED_ACCOUNT (${r.status} ${code(r)})`, r.status === 403 && code(r) === "PROTECTED_ACCOUNT");
		ok("...the account is still there, and the month-end lock was never asked", !!w.row(1) && w.seen.lockCalls === 0);
		const a = w.audits("delete_user_blocked");
		ok(`...one delete_user_blocked row with [PROTECTED_ACCOUNT] on user 1 (${a.length})`, a.length === 1 && a[0].entity_id === "1" && a[0].details.includes("[PROTECTED_ACCOUNT]"));
	}
	{
		const w = world("1,7");
		const r = await w.del(SECOND, 1);
		ok(`listed account 7 removing account 1: past the protected check, to the next guard (${r.status} ${code(r)})`, code(r) === "PERIOD_LOCK_UNREADABLE" && w.seen.lockCalls === 1 && !!w.row(1));
		const s = await world("1,7").del(OWNER, 1);
		ok(`account 1 removing itself: CANNOT_DELETE_SELF, as before (${s.status} ${code(s)})`, s.status === 409 && code(s) === "CANNOT_DELETE_SELF");
		const u = world("1,7");
		const o = await u.del(STAFF, 6);
		ok(`unlisted Super Admin 5 removing unlisted account 6: not protected (${o.status} ${code(o)})`, code(o) === "PERIOD_LOCK_UNREADABLE" && u.seen.lockCalls === 1);
	}

	// ── §3 a set but invalid list ────────────────────────────────────────────
	console.log("\n§3 RATECON_PDF_VIEWER_IDS set but invalid");
	for (const raw of ["owner_admin", "", "1,,7"]) {
		const w = world(raw);
		const own = await w.put(OWNER, 1, { email: "owner2@example.test" });
		ok(`${JSON.stringify(raw)}: account 1 changing its own email through this route is refused (${own.status} ${code(own)})`, own.status === 403 && code(own) === "PROTECTED_ACCOUNT" && w.row(1).email === "owner@example.test");
		const pw = await world(raw).put(STAFF, 6, { password: NEW_PASSWORD });
		ok(`${JSON.stringify(raw)}: any Super Admin's password reset is refused (${pw.status} ${code(pw)})`, pw.status === 403 && code(pw) === "PROTECTED_ACCOUNT");
		const role = await world(raw).put(SECOND, 6, { role: "Dispatcher" });
		ok(`${JSON.stringify(raw)}: any Super Admin's role change is refused (${role.status} ${code(role)})`, role.status === 403 && code(role) === "PROTECTED_ACCOUNT");
		const name = await world(raw).put(STAFF, 1, { fullName: "Owner A. Admin" });
		ok(`${JSON.stringify(raw)}: a full-name edit still goes through (${name.status})`, name.status === 200);
		const disp = await world(raw).put(STAFF, 9, { password: NEW_PASSWORD });
		ok(`${JSON.stringify(raw)}: a Dispatcher's password reset is not refused as protected (${disp.status} ${code(disp)})`, disp.status === 200);
		const d = world(raw);
		const del = await d.del(SECOND, 6);
		ok(`${JSON.stringify(raw)}: removing any Super Admin is refused (${del.status} ${code(del)})`, del.status === 403 && code(del) === "PROTECTED_ACCOUNT" && d.seen.lockCalls === 0);
		const dd = world(raw);
		const deld = await dd.del(STAFF, 9);
		ok(`${JSON.stringify(raw)}: removing a Dispatcher is not refused as protected (${code(deld)})`, code(deld) === "PERIOD_LOCK_UNREADABLE");
	}

	// ── §4 unset ─────────────────────────────────────────────────────────────
	console.log("\n§4 RATECON_PDF_VIEWER_IDS unset: nobody is protected");
	{
		const w = world(undefined);
		const r = await w.put(STAFF, 1, { password: NEW_PASSWORD });
		ok(`Super Admin 5 resetting account 1's password: 200, as before the list existed (${r.status} ${code(r)})`, r.status === 200 && w.row(1).password_hash !== "old-hash");
		const e = await world(undefined).put(NO_ID, 1, { role: "Dispatcher" });
		ok(`a session without an id changing account 1's role: not refused as protected (${e.status} ${code(e)})`, code(e) !== "PROTECTED_ACCOUNT");
		const d = world(undefined);
		const del = await d.del(STAFF, 1);
		ok(`Super Admin 5 removing account 1: past the protected check (${code(del)})`, code(del) === "PERIOD_LOCK_UNREADABLE");
	}

	// ── §5 placement ─────────────────────────────────────────────────────────
	console.log("\n§5 where the checks sit");
	{
		const reRead = PUT_ROUTE.indexOf("\t\tuser = db.prepare(\"SELECT * FROM users WHERE id = ?\").get(id);");
		const a0 = PUT_ROUTE.indexOf("RATECON_PDF_VIEWERS.protectedChangeRefusal(");
		const guardA = PUT_ROUTE.indexOf("// (a) Demoting the last Super Admin");
		const write = PUT_ROUTE.indexOf("db.prepare(`UPDATE users SET ${updates.join(\", \")} WHERE id = ?`)");
		ok("PUT: the protected check runs on the account as re-read after the last await", reRead > 0 && a0 > reRead);
		ok("PUT: ...before the last-Super-Admin guard and the write", a0 > 0 && guardA > a0 && write > a0);
		ok("PUT: ...with no await between it and the write", !/\bawait\b/.test(PUT_ROUTE.slice(a0, write)));
		const self = DELETE_ROUTE.indexOf("\"CANNOT_DELETE_SELF\", []);");
		const a2 = DELETE_ROUTE.indexOf("RATECON_PDF_VIEWERS.protectedChangeRefusal(");
		const last = DELETE_ROUTE.indexOf("\"LAST_SUPER_ADMIN\", []);");
		const lock = DELETE_ROUTE.indexOf("userDeleteLockBlockers(user, name)");
		ok("DELETE: the protected check runs after the self check, before the last-Super-Admin and month-end guards", self > 0 && a2 > self && last > a2 && lock > a2);
		ok("DELETE: no await between the protected check and the cascade (the route stays synchronous)", !/\bawait\b/.test(DELETE_ROUTE.slice(a2)));
	}

	console.log(`\nprotected-accounts: ${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log(`FAIL  runner threw: ${e && e.stack || e}`); process.exit(1); });
