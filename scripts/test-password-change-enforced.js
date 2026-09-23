#!/usr/bin/env node
/**
 * The forced password change is enforced by the SERVER, not only by the client
 * router.
 *
 * WHY IT EXISTS. Accepting a driver application (PUT /api/applications/:id/
 * status) mints an account with an emailed 8-hex-char temporary password and
 * sets users.must_change_password = 1. Until 2026-09-23 nothing server-side read
 * that flag: the Vue router sent the SPA to /account/change-password, and that
 * was the whole control. curl does not run the router, so anyone holding the
 * emailed password could call every API the role allows, indefinitely, without
 * ever rotating it.
 *
 * The properties, each a way this can silently stop working:
 *   §1 the ALLOWLIST passes a flagged session: POST /api/auth/change-password
 *      through either guard (GET /api/auth/session and POST /api/auth/logout
 *      mount no guard, pinned in §5 and exercised in §4)
 *   §2 EVERYTHING ELSE behind a guard is refused: reads and writes, both
 *      guards, the /uploads app.use mount, and the URL shapes a path compare
 *      gets wrong. §2b: a refusal leaves one coalesced log line
 *   §3 the flag is CURRENT: read from the database on every request, so a flag
 *      cleared by the change is honoured on the very next request, and a flag
 *      set under an old session is not waved through by that session's copy
 *   §4 end to end through real Express over a loopback socket, which is what
 *      makes req.route real: allowlist, refusals, public routes, freshness
 *   §4b Socket.IO, on the real io.on("connection") handler: a forced session
 *      joins no room but is NOT disconnected (socket.io-client never retries a
 *      server disconnect), and the register sent after the change joins
 *   §5 the SOURCE: both copies identical, self-contained and in order; the
 *      refresh mounted above every route; the exempted literal equal to the
 *      one registration; the handler and the Socket.IO gate wired
 *   §6 DISCRIMINATION: fail-open and near-miss mutants must each be caught
 *
 * Lifts the guards the way scripts/test-csrf-write-header.js does (a bare
 * `new Function`, nothing injected) and the two freshness helpers with only
 * `db` injected, so it exercises the code that ships rather than a copy.
 *
 * Pure except §4 (needs express) and the real-SQLite half of §3 and §6 (needs
 * better-sqlite3); those are skipped LOUDLY when the module is not resolvable,
 * because "0 failures" and "nothing ran" must never look alike. No app.db, no
 * fixed port, nothing beyond 127.0.0.1.
 *
 * Run: node scripts/test-password-change-enforced.js
 */
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const failures = [];
const skipped = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

// Refusals and read failures log by design (§2b asserts it). Keep those lines
// out of the run's output and replay them only if something fails.
const logs = [];
const realWarn = console.warn;
const realError = console.error;
console.warn = (...a) => logs.push(a.join(" "));
console.error = (...a) => logs.push(a.join(" "));

// ── lift the shipped code ───────────────────────────────────────────────────
function liftFrom(src, head) {
	const a = src.indexOf(head);
	if (a < 0) throw new Error(`could not locate ${head}`);
	let depth = 0;
	for (let j = src.indexOf("{", a); j < src.length; j++) {
		if (src[j] === "{") depth++;
		else if (src[j] === "}" && --depth === 0) return src.slice(a, j + 1);
	}
	throw new Error(`unbalanced braces after ${head}`);
}
const GATE_HEAD = "if (req.session.user.mustChangePassword";
const gateOf = (fnSrc) => (fnSrc.includes(GATE_HEAD) ? liftFrom(fnSrc, GATE_HEAD) : null);

let REQUIRE_AUTH, REQUIRE_ROLE, CURRENT, REFRESH;
try {
	REQUIRE_AUTH = liftFrom(SRC, "function requireAuth(req, res, next) {");
	REQUIRE_ROLE = liftFrom(SRC, "function requireRole(...roles) {");
	CURRENT = liftFrom(SRC, "function currentMustChangePassword(sessionUser) {");
	REFRESH = liftFrom(SRC, "function refreshPasswordChangeFlag(req, res, next) {");
} catch (e) {
	console.error = realError;
	console.error(`FAILED: ${e.message} — a server.js without the forced-password-change gate is the pre-fix source`);
	process.exit(1);
}

// ⚠️ Bare `new Function` with NO injected identifiers for the guards, the same
// hostile environment test-db-export-guard.js uses: if the gate ever reaches
// for a module-scope binding, building or calling these throws.
function buildGuards(authSrc = REQUIRE_AUTH, roleSrc = REQUIRE_ROLE) {
	return {
		requireAuth: new Function(authSrc + "\nreturn requireAuth;")(),
		requireRole: new Function(roleSrc + "\nreturn requireRole;")(),
	};
}
// The freshness helpers get `db` and nothing else. Any other module-scope
// binding they grew would throw here, which is the TDZ-free property their
// comment promises.
function buildFlag(db, currentSrc = CURRENT, refreshSrc = REFRESH) {
	return new Function("db",
		`${currentSrc}\n${refreshSrc}\nreturn { currentMustChangePassword, refreshPasswordChangeFlag };`)(db);
}

// ── users tables: a fake, and real SQLite with the SHIPPED column ────────────
function tryRequire(name) { try { return require(name); } catch { return null; } }
const Database = tryRequire("better-sqlite3");
const express = tryRequire("express");

// The column exactly as server.js migrates it, so the real-SQLite runs execute
// the shipped SELECT against the shipped column rather than a lookalike.
const MIGRATION = (SRC.match(/ALTER TABLE users ADD COLUMN must_change_password [^"]*/) || [])[0];

function fakeUsers() {
	const rows = new Map();
	let broken = false;
	const sql = [];
	return {
		name: "fake db",
		sql,
		db: {
			prepare(q) {
				sql.push(q);
				if (broken) throw new Error("SQLITE_ERROR: no such table: users");
				return { get: (id) => (rows.has(id) ? { must_change_password: rows.get(id) } : undefined) };
			},
		},
		add(id, flag) { rows.set(id, flag); },
		setFlag(id, flag) { rows.set(id, flag); },
		breakReads() { broken = true; },
	};
}
function realUsers() {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL)");
	db.exec(MIGRATION);
	return {
		name: "real SQLite",
		db,
		add(id, flag) {
			db.prepare("INSERT INTO users (id, username, role, must_change_password) VALUES (?, ?, 'Driver', ?)").run(id, `u${id}`, flag);
		},
		setFlag(id, flag) { db.prepare("UPDATE users SET must_change_password = ? WHERE id = ?").run(flag, id); },
		breakReads() { db.exec("DROP TABLE users"); },
	};
}
const BACKENDS = [fakeUsers];
if (Database && MIGRATION) BACKENDS.push(realUsers);
else skipped.push("§3/§6 real-SQLite runs (better-sqlite3 not resolvable, or the users migration was not found)");

// ── request shapes ──────────────────────────────────────────────────────────
const CP = "/api/auth/change-password";
const XRW = { "x-requested-with": "XMLHttpRequest" };
const FLAGGED = () => ({ id: 7, username: "LogisX-2609", role: "Driver", mustChangePassword: true });
const CLEAR = () => ({ id: 8, username: "amir_serrano", role: "Dispatcher", mustChangePassword: false });

// req.route is what Express assigns when it dispatches into a route layer.
// `routePath` omitted models an app.use mount, where Express assigns none.
function run(guard, { method = "GET", url = "/api/loads", routePath, headers = XRW, user } = {}) {
	const out = { status: null, body: null, nexted: false };
	const req = { method, url, originalUrl: url, headers, session: user ? { user } : {} };
	if (routePath !== undefined) req.route = { path: routePath };
	const res = {
		status(c) { out.status = c; return this; },
		json(b) { out.body = b; return this; },
	};
	guard(req, res, () => { out.nexted = true; });
	return out;
}
const refused = (r) => r.status === 403 && !!r.body && r.body.code === "PASSWORD_CHANGE_REQUIRED" && !r.nexted;

// ── the properties §6's mutants target, as named booleans ─────────────────────
function probe(guards, makeFlag, makeBackend) {
	const { requireAuth, requireRole } = guards;
	const p = {};
	p.refusesFlaggedRead = refused(run(requireAuth, { routePath: "/api/loads", user: FLAGGED() }));
	p.refusesFlaggedWrite = refused(run(requireAuth, { method: "POST", url: "/api/expenses", routePath: "/api/expenses", user: FLAGGED() }));
	p.roleRefusesFlagged = refused(run(requireRole("Driver"), { method: "PUT", url: "/api/driver/status", routePath: "/api/driver/status", user: FLAGGED() }));
	p.allowsChangePassword = run(requireAuth, { method: "POST", url: CP, routePath: CP, user: FLAGGED() }).nexted;
	p.allowsRoutedVariant = run(requireAuth, { method: "POST", url: "/API/auth/change-password/", routePath: CP, user: FLAGGED() }).nexted;
	p.refusesMentioningUrl = refused(run(requireAuth, {
		method: "POST", url: "/api/expenses?next=/api/auth/change-password", routePath: "/api/expenses", user: FLAGGED(),
	}));

	// Freshness: refresh, then guard — the order server.js mounts them in.
	const through = (backend, user) => {
		const { refreshPasswordChangeFlag } = makeFlag(backend.db);
		const req = { session: { user } };
		refreshPasswordChangeFlag(req, {}, () => {});
		return run(requireAuth, { routePath: "/api/loads", user: req.session.user });
	};
	{ // an OLD session (copy false) for an account flagged after it was minted
		const b = makeBackend(); b.add(7, 1);
		p.oldSessionRefused = refused(through(b, { ...FLAGGED(), mustChangePassword: false }));
	}
	{ // the flag was cleared in the database; this session's copy is still true
		const b = makeBackend(); b.add(7, 0);
		p.clearedAllowedImmediately = through(b, FLAGGED()).nexted;
	}
	{ // a session minted before the field existed, for a flagged account
		const b = makeBackend(); b.add(7, 1);
		const u = FLAGGED(); delete u.mustChangePassword;
		p.noCopyFlaggedRefused = refused(through(b, u));
	}
	{ // users unreadable: the last-known copy stands, CLOSED for a flagged session
		const b = makeBackend(); b.add(7, 1); b.breakReads();
		p.readErrorStaysClosed = refused(through(b, FLAGGED()));
	}
	{ // row missing (account deleted under a live session): the copy stands
		const b = makeBackend();
		p.missingRowKeepsCopy = refused(through(b, FLAGGED()));
	}
	return p;
}

// ─────────────────────────────── §1 the allowlist passes a flagged session
{
	const { requireAuth, requireRole } = buildGuards();
	ok(run(requireAuth, { method: "POST", url: CP, routePath: CP, user: FLAGGED() }).nexted,
		"§1 requireAuth: a flagged session must reach POST /api/auth/change-password — it is the only way to clear the flag");
	ok(run(requireRole("Driver"), { method: "POST", url: CP, routePath: CP, user: FLAGGED() }).nexted,
		"§1 requireRole: carries the same exemption, so re-mounting the route behind a role gate cannot lock the user out either");
	ok(run(requireAuth, { method: "POST", url: "/API/auth/change-password/", routePath: CP, user: FLAGGED() }).nexted,
		"§1 a case/trailing-slash variant Express routed to change-password must pass — the exemption keys on the matched route, not the URL");
	const noHeader = run(requireAuth, { method: "POST", url: CP, routePath: CP, headers: {}, user: FLAGGED() });
	ok(noHeader.status === 403 && noHeader.body && noHeader.body.code === "CSRF_HEADER_REQUIRED",
		"§1 the exempted route must still demand X-Requested-With — lifting this gate must not lift the CSRF check");
}

// ─────────────────────────────── §2 everything else behind a guard is refused
{
	const { requireAuth, requireRole } = buildGuards();
	for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]) {
		ok(refused(run(requireAuth, { method, routePath: "/api/loads", user: FLAGGED() })),
			`§2 requireAuth: a flagged ${method} must be refused with PASSWORD_CHANGE_REQUIRED`);
		ok(refused(run(requireRole("Super Admin", "Dispatcher", "Driver"), { method, url: "/api/driver/status", routePath: "/api/driver/status", user: FLAGGED() })),
			`§2 requireRole: a flagged ${method} must be refused with PASSWORD_CHANGE_REQUIRED`);
	}
	ok(refused(run(requireAuth, { url: "/uploads/expense-receipts/r.jpg", user: FLAGGED() })),
		"§2 the /uploads app.use mount (no req.route there) must refuse a flagged session");
	ok(refused(run(requireAuth, { method: "GET", url: CP, routePath: CP, user: FLAGGED() })),
		"§2 only POST is exempt on the change-password path");
	ok(refused(run(requireAuth, { method: "POST", url: "/api/expenses?next=/api/auth/change-password", routePath: "/api/expenses", user: FLAGGED() })),
		"§2 a URL that merely MENTIONS change-password must not borrow the exemption");
	ok(refused(run(requireAuth, { method: "POST", url: "/api/auth/change-password-x", routePath: "/api/auth/change-password-x", user: FLAGGED() })),
		"§2 a prefix lookalike path must not borrow the exemption");
	ok(run(requireAuth, { user: null }).status === 401,
		"§2 no session must still be 401 — the flag check must not run ahead of the session check");
	const wrongRole = run(requireRole("Super Admin"), { user: FLAGGED() });
	ok(wrongRole.status === 403 && wrongRole.body && wrongRole.body.error === "Forbidden",
		"§2 a wrong role must still read Forbidden — a role refusal must not be relabelled");
	ok(run(requireAuth, { user: CLEAR() }).nexted && run(requireRole("Dispatcher"), { method: "POST", user: CLEAR() }).nexted,
		"§2 an unflagged session must pass both guards exactly as before");
}

// ─────────────────────────────── §2b a refusal is observable, and coalesced
{
	const { requireAuth } = buildGuards();
	delete globalThis.__pwChangeRefusedLoggedAt;
	globalThis.__pwChangeRefusedCount = 0;
	const before = logs.length;
	run(requireAuth, { url: "/api/loads?token=SECRET-123", routePath: "/api/loads", user: FLAGGED() });
	const lines = logs.slice(before);
	ok(lines.length === 1 && /PASSWORD_CHANGE_REQUIRED/.test(lines[0]),
		"§2b a refusal must leave a server-side trace naming the code — a silent refusal cannot tell one stale tab from every new driver stuck");
	ok(lines.length === 1 && !/SECRET-123/.test(lines[0]), "§2b ...that never carries the query string");
	for (let i = 0; i < 50; i++) run(requireAuth, { routePath: "/api/loads", user: FLAGGED() });
	ok(logs.length - before === 1, `§2b 51 refusals must coalesce to one line, not ${logs.length - before}`);
	ok(globalThis.__pwChangeRefusedCount === 51, "§2b ...while still counting every one of them");
}

// ─────────────────────────────── §3 the flag is current
for (const makeBackend of BACKENDS) {
	const label = makeBackend().name;
	const p = probe(buildGuards(), buildFlag, makeBackend);
	ok(p.oldSessionRefused, `§3 [${label}] an OLD session must not slip through on its stale copy once the account is flagged`);
	ok(p.clearedAllowedImmediately, `§3 [${label}] a flag cleared in the database must be honoured on the very next request, stale copy or not`);
	ok(p.noCopyFlaggedRefused, `§3 [${label}] a session minted before the field existed must pick the flag up from the database`);
	ok(p.readErrorStaysClosed, `§3 [${label}] an unreadable users table must keep the last-known copy — CLOSED for a flagged session`);
	ok(p.missingRowKeepsCopy, `§3 [${label}] a missing row must keep the last-known copy rather than read as cleared`);
}
{
	// An unchanged flag is not written back: with resave:false, express-session
	// re-saves any session whose contents change, so writing on every request
	// would turn every GET into a sessions-table UPDATE.
	const b = fakeUsers(); b.add(8, 0);
	const { refreshPasswordChangeFlag } = buildFlag(b.db);
	let writes = 0, v = false;
	const user = { id: 8, role: "Dispatcher" };
	Object.defineProperty(user, "mustChangePassword", { enumerable: true, get: () => v, set: (x) => { writes++; v = x; } });
	for (let i = 0; i < 5; i++) refreshPasswordChangeFlag({ session: { user } }, {}, () => {});
	ok(writes === 0, "§3 an unchanged flag must not be written back to the session");
	b.setFlag(8, 1);
	refreshPasswordChangeFlag({ session: { user } }, {}, () => {});
	ok(writes === 1 && v === true, "§3 a changed flag must be written exactly once");
	ok(b.sql.every((q) => /^SELECT must_change_password FROM users WHERE id = \?$/.test(q)),
		"§3 the read must be one primary-key SELECT of the one column");
}
{
	let reads = 0, nexted = 0;
	const { refreshPasswordChangeFlag } = buildFlag({ prepare() { reads++; return { get: () => undefined }; } });
	refreshPasswordChangeFlag({ session: {} }, {}, () => nexted++);
	refreshPasswordChangeFlag({}, {}, () => nexted++);
	ok(nexted === 2 && reads === 0,
		"§3 a request with no session user must pass straight through without touching the database (public routes, static assets)");
}

// ─────────────────────────────── §5 the source
{
	const gA = gateOf(REQUIRE_AUTH), gR = gateOf(REQUIRE_ROLE);
	const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
	ok(gA && gR, "§5 both guards must carry the gate");
	ok(gA && gR && norm(gA) === norm(gR),
		"§5 DRIFT: the two copies of the gate are no longer identical (they cannot share a helper; see §5 self-contained)");

	const at = (s, needle) => s.indexOf(needle);
	const SESSION = "if (!req.session.user)", ROLE = "if (!roles.includes(req.session.user.role))", CSRF = 'req.method !== "GET"';
	ok(at(REQUIRE_AUTH, SESSION) >= 0 && at(REQUIRE_AUTH, SESSION) < at(REQUIRE_AUTH, GATE_HEAD) && at(REQUIRE_AUTH, GATE_HEAD) < at(REQUIRE_AUTH, CSRF),
		"§5 requireAuth must run session → gate → CSRF");
	ok(at(REQUIRE_ROLE, SESSION) >= 0 && at(REQUIRE_ROLE, SESSION) < at(REQUIRE_ROLE, ROLE) && at(REQUIRE_ROLE, ROLE) < at(REQUIRE_ROLE, GATE_HEAD) && at(REQUIRE_ROLE, GATE_HEAD) < at(REQUIRE_ROLE, CSRF),
		"§5 requireRole must run session → role → gate → CSRF");

	let threw = null;
	try {
		const g = buildGuards();
		run(g.requireAuth, { user: FLAGGED(), routePath: "/x" });
		run(g.requireRole("Driver"), { user: FLAGGED(), routePath: "/x" });
	} catch (e) { threw = e; }
	ok(!threw, `§5 the gate must run inside a bare new Function — test-db-export-guard.js lifts requireRole that way: ${threw && threw.message}`);
	ok(!/^\s*(const|let|var)\s/m.test((gA || "") + (gR || "")), "§5 the gate must declare nothing");
	ok(/globalThis\.__pwChangeRefused/.test(gA || "") && /globalThis\.__pwChangeRefused/.test(gR || ""),
		"§5 the refusal counter must live on globalThis in both copies, or the lift throws");

	const lines = SRC.split("\n");
	const isCode = (l) => { const t = l.trim(); return t !== "" && !t.startsWith("//") && !t.startsWith("*"); };
	const firstLine = (re) => lines.findIndex((l) => isCode(l) && re.test(l));
	const mounts = lines.filter((l) => isCode(l) && /\bapp\.use\(refreshPasswordChangeFlag\)/.test(l));
	ok(mounts.length === 1, `§5 refreshPasswordChangeFlag must be mounted exactly once (found ${mounts.length})`);
	const sessionAt = firstLine(/^\s*app\.use\(sessionMiddleware\);/);
	const refreshAt = firstLine(/^\s*app\.use\(refreshPasswordChangeFlag\);/);
	const between = lines.slice(sessionAt + 1, Math.max(sessionAt + 1, refreshAt)).filter(isCode);
	ok(sessionAt >= 0 && refreshAt > sessionAt && between.every((l) => /^\s*io\.engine\.use\(sessionMiddleware\);/.test(l)),
		"§5 the refresh must be mounted directly below sessionMiddleware — it reads req.session");
	const firstApi = firstLine(/\bapp\.(get|post|put|patch|delete|all)\(\s*(\[\s*)?["'`]\/api/);
	ok(refreshAt >= 0 && firstApi > refreshAt,
		"§5 the refresh must be mounted above the first /api route — a route registered above it enforces a stale copy");
	ok(firstLine(/\bapp\.use\(\s*["'`]\/uploads/) > refreshAt && firstLine(/express\.static\(/) > refreshAt,
		"§5 ...and above the /uploads guards and the static mounts");

	const regs = lines.filter((l) => isCode(l) && /\bapp\.(get|post|put|patch|delete|all|use)\(\s*["'`]\/api\/auth\/change-password["'`]/.test(l));
	ok(regs.length === 1, `§5 exactly one registration may carry the change-password path (found ${regs.length}) — the exemption is keyed on it`);
	ok(/^\s*app\.post\(\s*"\/api\/auth\/change-password",\s*requireAuth\b/.test(regs[0] || ""),
		"§5 it must stay app.post(\"/api/auth/change-password\", requireAuth, …) — the exemption is POST-only and lives in the guards");
	const lit = ((gA || "").match(/req\.route\.path === "([^"]+)"/) || [])[1];
	ok(lit === CP, "§5 the exempted literal must equal the registered path");
	const unguarded = (verb, p) => new RegExp(`^\\s*app\\.${verb}\\(\\s*"${p.replace(/\//g, "\\/")}",\\s*\\(req, res\\)`, "m").test(SRC);
	ok(unguarded("get", "/api/auth/session"), "§5 GET /api/auth/session must mount no guard — the client router reads the flag there");
	ok(unguarded("post", "/api/auth/logout"), "§5 POST /api/auth/logout must mount no guard — a forced user must always be able to leave");

	const a = SRC.indexOf('app.post("/api/auth/change-password"');
	const body = SRC.slice(a, SRC.indexOf("\n});", a));
	const update = body.indexOf("UPDATE users SET password_hash");
	ok(/UPDATE users SET password_hash = \?, must_change_password = 0 WHERE id = \?/.test(body),
		"§5 the change-password handler must clear users.must_change_password in the same UPDATE as the hash");
	// The rotated session must not carry the flag. It is REBUILT from the account
	// row after the UPDATE (never copied from the session the request arrived
	// with, which a change in the bcrypt window would leave stale), with the flag
	// cleared, and assigned inside the rotation.
	const rebuilt = body.indexOf("mustChangePassword: false,");
	const regenerate = body.indexOf("req.session.regenerate(");
	const assigned = body.indexOf("req.session.user = freshUser;");
	ok(rebuilt > update && rebuilt < regenerate && assigned > regenerate && !/\.\.\.\s*req\.session\b/.test(body),
		"§5 ...and the rotated session carries the cleared flag: rebuilt from the account row after the UPDATE and assigned inside the rotation, never copied from the incoming session");
	const unchanged = body.indexOf("if (newPassword === currentPassword)");
	ok(unchanged > 0 && unchanged < update,
		"§5 re-submitting the current password must be refused before the UPDATE — otherwise it clears the flag without rotating the credential");

	const io = SRC.indexOf('io.on("connection", (socket) => {');
	const regAt = io >= 0 ? SRC.indexOf('socket.on("register", (clientName) => {', io) : -1;
	const beforeRegister = regAt > io ? SRC.slice(io, regAt) : "";
	const registerHead = regAt > 0 ? SRC.slice(regAt, SRC.indexOf("const requested", regAt)) : "";
	ok(regAt > io && !/currentMustChangePassword/.test(beforeRegister),
		"§5 the Socket.IO gate must NOT refuse the connection — a server-initiated disconnect is never retried by the client (see §4b)");
	ok(/\n\s*if \(currentMustChangePassword\(sessionUser\)\) return;\s*$/.test(registerHead),
		"§5 the register handler must refuse the room join before anything else, read from the database");
}

// ─────────────── §4b Socket.IO: a forced session joins no room, and stays up
// Lifts the real io.on("connection") handler and drives it with a fake socket
// and the real flag helper over a fake users table.
const IO_HANDLER = (() => {
	const a = SRC.indexOf('io.on("connection", (socket) => {');
	if (a < 0) return null;
	return liftFrom(SRC.slice(SRC.indexOf("(socket) => {", a)), "(socket) => {");
})();
// Shaped like a socket.io Socket where the handler reads it: `request` is the
// handshake request (express-session sets sessionID on it) and `data` is the
// per-socket object socket.io always provides, where the handler records who
// the socket is.
function fakeSocket(user) {
	const sessionID = user ? `sid-${user.id}` : "sid-anonymous";
	const s = { request: { session: user ? { user } : {}, sessionID }, data: {}, rooms: new Set(), disconnected: false, handlers: {} };
	s.disconnect = () => { s.disconnected = true; };
	s.on = (ev, cb) => { s.handlers[ev] = cb; };
	s.join = (room) => { s.rooms.add(room); };
	s.fromClient = (ev, ...args) => { if (s.handlers[ev]) s.handlers[ev](...args); };
	return s;
}
function socketProbe(handlerSrc) {
	const b = fakeUsers();
	b.add(7, 1); b.add(8, 0); b.add(9, 1);
	const { currentMustChangePassword } = buildFlag(b.db);
	// The handler also asks the session store whether the handshake's session
	// still exists. Every session in this probe does; a session that ended is
	// scripts/test-session-sockets.js's subject, against the real store.
	const liveSessionIds = (sids) => new Set(sids);
	const onConnection = new Function("currentMustChangePassword", "liveSessionIds", `return (${handlerSrc});`)(currentMustChangePassword, liveSessionIds);
	const p = {};
	const forced = fakeSocket({ id: 7, username: "LogisX-2609", role: "Driver", driverName: "Jane Roe", mustChangePassword: true });
	onConnection(forced);
	p.forcedStaysConnected = !forced.disconnected;
	forced.fromClient("register", "Jane Roe");
	p.forcedJoinsNothing = forced.rooms.size === 0;
	b.setFlag(7, 0); // the change, while this socket stays open
	forced.fromClient("register", "Jane Roe");
	p.joinsAfterChange = forced.rooms.has("jane roe");
	const stale = fakeSocket({ id: 9, username: "LogisX-1111", role: "Driver", driverName: "Old Copy", mustChangePassword: false });
	onConnection(stale);
	stale.fromClient("register", "Old Copy");
	p.staleCopyJoinsNothing = stale.rooms.size === 0;
	const disp = fakeSocket({ id: 8, username: "amir_serrano", role: "Dispatcher", mustChangePassword: false });
	onConnection(disp);
	disp.fromClient("register", "dispatch");
	p.unflaggedJoins = disp.rooms.has("dispatch") && disp.rooms.has("amir_serrano") && !disp.disconnected;
	const anon = fakeSocket(null);
	onConnection(anon);
	p.anonDisconnected = anon.disconnected;
	return p;
}
if (!IO_HANDLER) {
	ok(false, "§4b could not locate io.on(\"connection\") in server.js");
} else {
	const p = socketProbe(IO_HANDLER);
	ok(p.forcedStaysConnected,
		"§4b a forced session's socket must NOT be disconnected — the client never retries a server disconnect, so the driver would lose live updates after the change");
	ok(p.forcedJoinsNothing, "§4b ...but it must join no room while forced, so nothing is pushed to it");
	ok(p.joinsAfterChange, "§4b the register sent after the change must join the driver's room on the SAME socket");
	ok(p.staleCopyJoinsNothing, "§4b a session copy that says unflagged must not win over the database");
	ok(p.unflaggedJoins, "§4b an unflagged session must join exactly as before");
	ok(p.anonDisconnected, "§4b a socket with no session must still be disconnected");

	const GATE_LINE = "if (currentMustChangePassword(sessionUser)) return;";
	const SOCKET_MUTANTS = [
		{
			name: "a connection-time disconnect (strands the driver's socket after the change)",
			src: IO_HANDLER.replace("const role = sessionUser.role;",
				"if (currentMustChangePassword(sessionUser)) { socket.disconnect(true); return; }\n\tconst role = sessionUser.role;"),
			caughtBy: ["forcedStaysConnected", "joinsAfterChange"],
		},
		{
			name: "FAIL-OPEN: the register gate removed",
			src: IO_HANDLER.replace(GATE_LINE, ""),
			caughtBy: ["forcedJoinsNothing", "staleCopyJoinsNothing"],
		},
		{
			name: "the register gate reading the session copy",
			src: IO_HANDLER.replace(GATE_LINE, "if (sessionUser.mustChangePassword) return;"),
			caughtBy: ["joinsAfterChange", "staleCopyJoinsNothing"],
		},
	];
	for (const m of SOCKET_MUTANTS) {
		ok(m.src !== IO_HANDLER, `§6 socket mutant "${m.name}" did not change the source — its marker text moved`);
		const got = socketProbe(m.src);
		for (const prop of m.caughtBy) {
			ok(p[prop] === true && got[prop] === false, `§6 MUTANT NOT CAUGHT — socket: "${m.name}" must flip ${prop}`);
		}
	}
}

// ─────────────────────────────── §6 discrimination: each mutant must be caught
{
	const EXEMPT = 'req.route && req.route.path === "/api/auth/change-password"';
	const cutGate = (s) => s.replace(gateOf(s), "");
	const both = (f) => buildGuards(f(REQUIRE_AUTH), f(REQUIRE_ROLE));
	const flagFrom = (currentSrc) => (db) => buildFlag(db, currentSrc);
	const shippedGuards = buildGuards();
	const MUTANTS = [
		{
			name: "FAIL-OPEN: the gate removed from both guards (the pre-fix code)",
			src: cutGate(REQUIRE_AUTH) + cutGate(REQUIRE_ROLE),
			guards: both(cutGate), makeFlag: buildFlag,
			caughtBy: ["refusesFlaggedRead", "refusesFlaggedWrite", "roleRefusesFlagged", "oldSessionRefused", "noCopyFlaggedRefused"],
		},
		{
			name: "the gate dropped from requireRole only (the copies drift)",
			src: cutGate(REQUIRE_ROLE),
			guards: buildGuards(REQUIRE_AUTH, cutGate(REQUIRE_ROLE)), makeFlag: buildFlag,
			caughtBy: ["roleRefusesFlagged"],
		},
		{
			name: "the exemption keyed on a URL substring",
			src: REQUIRE_AUTH.split(EXEMPT).join('String(req.originalUrl || "").includes("/api/auth/change-password")'),
			guards: both((s) => s.split(EXEMPT).join('String(req.originalUrl || "").includes("/api/auth/change-password")')), makeFlag: buildFlag,
			caughtBy: ["refusesMentioningUrl"],
		},
		{
			name: "the exemption keyed on the exact URL",
			src: REQUIRE_AUTH.split(EXEMPT).join('(req.originalUrl || req.url) === "/api/auth/change-password"'),
			guards: both((s) => s.split(EXEMPT).join('(req.originalUrl || req.url) === "/api/auth/change-password"')), makeFlag: buildFlag,
			caughtBy: ["allowsRoutedVariant"],
		},
		{
			name: "the flag read from the session copy only",
			src: "function currentMustChangePassword(sessionUser) { return !!(sessionUser && sessionUser.mustChangePassword); }",
			guards: shippedGuards,
			makeFlag: flagFrom("function currentMustChangePassword(sessionUser) { return !!(sessionUser && sessionUser.mustChangePassword); }"),
			caughtBy: ["oldSessionRefused", "clearedAllowedImmediately", "noCopyFlaggedRefused"],
		},
		{
			name: "FAIL-OPEN: a read error answered as not-flagged",
			src: CURRENT.replace("} catch (err) {", "} catch (err) { return false;"),
			guards: shippedGuards, makeFlag: flagFrom(CURRENT.replace("} catch (err) {", "} catch (err) { return false;")),
			caughtBy: ["readErrorStaysClosed"],
		},
		{
			name: "a missing row answered as not-flagged",
			src: CURRENT.replace("if (row) return !!row.must_change_password;", "return !!(row && row.must_change_password);"),
			guards: shippedGuards,
			makeFlag: flagFrom(CURRENT.replace("if (row) return !!row.must_change_password;", "return !!(row && row.must_change_password);")),
			caughtBy: ["missingRowKeepsCopy"],
		},
	];
	for (const makeBackend of BACKENDS) {
		const label = makeBackend().name;
		const shipped = probe(shippedGuards, buildFlag, makeBackend);
		ok(Object.values(shipped).every(Boolean),
			`§6 [${label}] the shipped code must hold every probed property: ${JSON.stringify(shipped)}`);
		for (const m of MUTANTS) {
			ok(m.src !== REQUIRE_AUTH + REQUIRE_ROLE && m.src !== REQUIRE_AUTH && m.src !== CURRENT,
				`§6 mutant "${m.name}" did not change the source — its marker text moved`);
			const got = probe(m.guards, m.makeFlag, makeBackend);
			for (const prop of m.caughtBy) {
				ok(shipped[prop] === true && got[prop] === false,
					`§6 [${label}] MUTANT NOT CAUGHT — "${m.name}" must flip ${prop}`);
			}
		}
	}
}

// ─────────────────────────────── §4 end to end, through real Express
function request(port, method, urlPath, headers) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: headers || {} }, (res) => {
			let body = "";
			res.on("data", (c) => { body += c; });
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(body); } catch { /* html */ }
				resolve({ status: res.statusCode, json, body });
			});
		});
		req.on("error", reject);
		req.end();
	});
}

async function httpSection() {
	const backendFactory = BACKENDS[BACKENDS.length - 1];
	function makeApp({ backend, refreshBelowRoutes = false }) {
		const guards = buildGuards();
		const { refreshPasswordChangeFlag } = buildFlag(backend.db);
		const app = express();
		const sessions = new Map();
		const runs = {};
		const hit = (name) => (req, res) => { runs[name] = (runs[name] || 0) + 1; res.json({ ok: name }); };
		// Stands in for express-session only: each session object lives in a Map
		// across requests, so a refreshed copy is what the next request sees, as
		// with a saved session. Every decision after this line is shipped code.
		app.use((req, res, next) => { req.session = sessions.get(req.headers["x-test-sid"]) || {}; next(); });
		if (!refreshBelowRoutes) app.use(refreshPasswordChangeFlag);
		// The allowlist, registered the way server.js registers it.
		app.get("/api/auth/session", (req, res) =>
			res.json(req.session.user ? { authenticated: true, user: req.session.user } : { authenticated: false }));
		app.post("/api/auth/logout", hit("logout"));
		app.post("/api/auth/change-password", guards.requireAuth, (req, res) => {
			runs.changePassword = (runs.changePassword || 0) + 1;
			// The DATABASE write only. The shipped handler also clears the session
			// copy (§5 pins that); leaving the copy stale here is the stricter
			// test, because the next request must be allowed on the refresh alone.
			backend.setFlag(req.session.user.id, 0);
			res.json({ success: true });
		});
		// The authenticated surface: both guards, reads and writes, an app.use mount.
		app.get("/api/loads", guards.requireAuth, hit("loads"));
		app.post("/api/expenses", guards.requireAuth, hit("expenses"));
		app.put("/api/driver/status", guards.requireRole("Super Admin", "Dispatcher", "Driver"), hit("status"));
		app.get("/api/users", guards.requireRole("Super Admin"), hit("users"));
		app.use("/uploads", guards.requireAuth, hit("uploads"));
		// The public surface: no guard.
		app.get("/api/config/maintenance", hit("maintenance"));
		app.post("/api/public/apply", hit("apply"));
		if (refreshBelowRoutes) app.use(refreshPasswordChangeFlag);
		app.get("*", (req, res) => res.type("html").send("<!doctype html><title>SPA</title>"));
		const server = app.listen(0, "127.0.0.1");
		return new Promise((resolve) => server.on("listening", () => resolve({
			port: server.address().port, sessions, runs,
			close: () => new Promise((r) => server.close(r)),
		})));
	}
	const as = (sid, extra) => ({ ...XRW, ...(sid ? { "x-test-sid": sid } : {}), ...(extra || {}) });

	// ---- a forced user: refused everywhere guarded, allowed on the allowlist ---
	{
		const backend = backendFactory();
		backend.add(7, 1);
		backend.add(8, 0);
		const app = await makeApp({ backend });
		app.sessions.set("forced", { user: FLAGGED() });
		app.sessions.set("clear", { user: CLEAR() });
		const R = (m, u, sid, extra) => request(app.port, m, u, as(sid, extra));
		const pw = (r) => r.status === 403 && r.json && r.json.code === "PASSWORD_CHANGE_REQUIRED";

		const s = await R("GET", "/api/auth/session", "forced");
		ok(s.status === 200 && s.json.user && s.json.user.mustChangePassword === true,
			"§4 GET /api/auth/session must answer a forced session, flag included — the client router reads it there");
		ok(pw(await R("GET", "/api/loads", "forced")), "§4 a forced GET /api/loads must be refused");
		ok(pw(await R("POST", "/api/expenses", "forced")), "§4 a forced POST /api/expenses must be refused");
		ok(pw(await R("PUT", "/api/driver/status", "forced")), "§4 a forced PUT through requireRole must be refused");
		ok(pw(await R("GET", "/uploads/expense-receipts/r.jpg", "forced")), "§4 a forced read of the /uploads mount must be refused");
		ok(pw(await R("POST", "/api/expenses?next=/api/auth/change-password", "forced")),
			"§4 a URL that mentions change-password must not borrow the exemption");
		const role = await R("GET", "/api/users", "forced");
		ok(role.status === 403 && role.json && role.json.error === "Forbidden", "§4 a wrong role must still read Forbidden");
		ok(!app.runs.loads && !app.runs.expenses && !app.runs.status && !app.runs.uploads && !app.runs.users,
			"§4 no refused request may reach its handler");

		ok((await R("GET", "/api/config/maintenance", "forced")).status === 200, "§4 a public GET must answer a forced session");
		ok((await R("POST", "/api/public/apply", "forced")).status === 200, "§4 a public POST must answer a forced session");
		const spa = await R("GET", "/account/change-password", "forced");
		ok(spa.status === 200 && /SPA/.test(spa.body), "§4 the SPA itself must still load for a forced session");

		const csrf = await request(app.port, "POST", CP, { "x-test-sid": "forced" });
		ok(csrf.status === 403 && csrf.json && csrf.json.code === "CSRF_HEADER_REQUIRED" && !app.runs.changePassword,
			"§4 the change itself must still demand X-Requested-With");
		// Express routes case-insensitively and without strict slashes, and
		// req.route.path is the registered literal — so this reaches the handler.
		const change = await R("POST", "/API/auth/change-password/", "forced");
		ok(change.status === 200 && app.runs.changePassword === 1,
			"§4 POST /API/auth/change-password/ must reach the change handler — the exemption follows Express's own routing");

		// The stored session copy still says true (the stand-in handler left it).
		const after = await R("GET", "/api/loads", "forced");
		ok(after.status === 200 && app.runs.loads === 1,
			"§4 the request right after the change must be allowed — the refresh reads the cleared flag, not the stale copy");
		const s2 = await R("GET", "/api/auth/session", "forced");
		ok(s2.json && s2.json.user && s2.json.user.mustChangePassword === false,
			"§4 ...and GET /api/auth/session must report the flag cleared, so the router lets the user in");
		ok((await R("POST", "/api/auth/logout", "forced")).status === 200, "§4 POST /api/auth/logout must answer");

		// An unflagged session is untouched; then the flag is set UNDER it.
		ok((await R("GET", "/api/loads", "clear")).status === 200 && (await R("PUT", "/api/driver/status", "clear")).status === 200,
			"§4 an unflagged session must pass as before");
		backend.setFlag(8, 1);
		ok(pw(await R("GET", "/api/loads", "clear")),
			"§4 a session minted BEFORE its account was flagged must be refused on the next request");
		const s3 = await R("GET", "/api/auth/session", "clear");
		ok(s3.json && s3.json.user && s3.json.user.mustChangePassword === true,
			"§4 ...and GET /api/auth/session must report it, so the router can send the user to the change screen");

		// No session at all: public answers, guarded is 401 as before.
		ok((await R("GET", "/api/loads", null)).status === 401, "§4 no session must still be 401 on a guarded route");
		ok((await R("GET", "/api/config/maintenance", null)).status === 200, "§4 no session must still reach a public route");
		const anon = await R("GET", "/api/auth/session", null);
		ok(anon.status === 200 && anon.json && anon.json.authenticated === false, "§4 no session must read authenticated:false");
		await app.close();
	}

	// ---- the mount position is load-bearing: below the routes, it is stale ----
	{
		const backend = backendFactory();
		backend.add(8, 1);
		const app = await makeApp({ backend, refreshBelowRoutes: true });
		app.sessions.set("clear", { user: CLEAR() });
		const r = await request(app.port, "GET", "/api/loads", as("clear"));
		ok(r.status === 200,
			"§4 CONTROL: with the refresh mounted BELOW the routes, a session flagged after login slips through — which is why §5 pins the mount above them");
		await app.close();
	}
}

function finish() {
	console.warn = realWarn;
	console.error = realError;
	console.log(`\n${"=".repeat(64)}`);
	for (const s of skipped) console.log(`SKIPPED: ${s}`);
	if (failures.length) {
		console.log(`FAILURES (${failures.length}):`);
		failures.forEach((f) => console.log(`  ✗ ${f}`));
		if (logs.length) console.log(`\nlogged during the run (last 5):\n  ${logs.slice(-5).join("\n  ")}`);
		console.log(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`✓ ${pass} assertions passed${skipped.length ? ` (${skipped.length} section(s) skipped, listed above)` : ""}`);
}

(async () => {
	if (!express) skipped.push("§4 end-to-end HTTP section (express not resolvable)");
	else await httpSection();
	finish();
})().catch((e) => {
	console.warn = realWarn;
	console.error = realError;
	console.error(e);
	process.exit(1);
});
