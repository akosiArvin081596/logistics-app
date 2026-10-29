#!/usr/bin/env node
/**
 * scripts/test-db-download-listed-only.js — the database admin routes
 * (POST /api/db/download, GET /api/db/tables, GET /api/db/query/:table) are
 * limited to the accounts listed in RATECON_PDF_VIEWER_IDS.
 *
 * The rule (Arvin, 2026-10-22, decisions D1-D11; plan in the replica reports
 * folder, 2026-10-22-db-download-listed-only-plan.md, Revision 2):
 *   - a listed account that is still a Super Admin in the users table uses the
 *     routes as today; a download is audited (db_download, as today);
 *   - every other Super Admin gets 403 DB_DOWNLOAD_RESTRICTED (body: code and
 *     error only; Cache-Control: no-store), after the role check (and, on the
 *     POST, the cross-site guard) and before the limiter: nothing is read or
 *     copied, the limiter is not spent, and the attempt is audited as
 *     db_download_blocked / db_tables_blocked / db_query_blocked with its
 *     reason and IP (never file contents or the setting's text), coalesced to
 *     one row a minute per account like every other refusal; the GET rows also
 *     record Sec-Fetch-Site;
 *   - a session without a usable account id, or whose account is no longer a
 *     Super Admin (or no longer exists), is told to sign in again (same code);
 *     a username never counts;
 *   - Dispatcher, Driver, Investor and signed-out callers are refused exactly as
 *     today (requireRole's 403 "Forbidden" / 401), with no audit row, even
 *     when a Dispatcher's id is on the list;
 *   - the list set but invalid, or unset (D3 = B): every Super Admin refused;
 *   - a refused POST raises one Super Admin-only dispatch notice per account per
 *     day (never "Account #0"; the 403 goes out even if the notice fails); a
 *     refused GET raises none.
 *
 * §1 POST, list "1,7"   §2 other roles   §3 unset   §4 invalid   §5 GET is 405
 * §6 start-up messages   §7 the GET routes (D8)   §8 the refusal notice (D6)
 * §9 a listed account whose role changed (L8)   §10 who sees the notice (L5)
 *
 * WHAT IS REAL. Everything from just after the boot-time orphan sweep's call
 * (`purgeOrphanedDbExports();`) to the end of the GET /api/db/query/:table
 * handler is lifted from server.js whole and run as shipped: the method guard,
 * the gate, the three routes, the real db.backup() and 0600 temp file, the
 * real PII masking. requireRole, auditHeaderValue, logAudit and
 * logAuditRefusal are lifted from server.js and write a real audit_trail; the
 * list is the shipped lib/listed-accounts.js; noticeTypeScope() is lifted for
 * §10. Stubs: the cross-site guard (a pass-through counter;
 * scripts/test-db-export-guard.js covers it), the limiter (a counter),
 * os.tmpdir() (a fresh folder per case), res.download (reads the copy, then runs
 * the route's callback), the notice store and the socket room (recorders).
 *
 * Made-up data only: accounts 1 and 7 listed Super Admins, 5 and 6 unlisted
 * Super Admins, 9 a Dispatcher, 11 a Driver, 12 an Investor; three made-up
 * rows; a documentation-range IP. No server, no port, no app.db, no network.
 *
 * Run: node scripts/test-db-download-listed-only.js
 * From a git worktree (no node_modules): NODE_PATH=<repo>/node_modules node ...
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Decision D3: what an UNSET RATECON_PDF_VIEWER_IDS means for the database
// routes. true = nobody uses them in the app (Arvin's choice, 2026-10-22).
const UNSET_REFUSES_EVERYONE = true;

const RESTRICTED_MESSAGE = "Downloading the database is limited to the owner.";
const SIGN_IN_AGAIN_MESSAGE = "Your session is out of date. Sign in again to download the database.";
const NOTICE_TYPE = "db-download-refused";
const TEST_IP = "203.0.113.9";

const ROOT = path.join(__dirname, "..");
const SRC = require("./lib/server-source").serverSource();

let passed = 0;
let failed = 0;
// The made-up databases and export copies live here; every exit removes it.
let TMP_ROOT = null;
function cleanUp() {
	if (TMP_ROOT) { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ } }
}
function ok(name, cond) {
	if (cond) { passed++; console.log(`ok    ${name}`); }
	else { failed++; console.log(`FAIL  ${name}`); }
}
function die(msg) { console.error(`FAIL  ${msg}`); cleanUp(); process.exit(1); }

let Database;
try { Database = require("better-sqlite3"); } catch (e) { die(`a server dependency did not load (${e.message}); run it under the .nvmrc Node`); }
let listedAccounts = null;
try { listedAccounts = require(path.join(ROOT, "lib", "listed-accounts.js")); } catch (e) { die(`lib/listed-accounts.js did not load (${e.code || e.message})`); }
const piiMask = require(path.join(ROOT, "lib", "pii-mask"));
const lift = require(path.join(ROOT, "scripts", "lib", "server-lift.js"));

// ── lift the shipped code ───────────────────────────────────────────────────
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

const AUDIT_SRC = [
	liftFunction("logAudit"),
	liftConst("const REFUSAL_AUDIT_WINDOW_MS = "),
	liftConst("const refusalAuditWindows = "),
	liftConst("const UNCOALESCED_REFUSAL_CODES = new Set([", "\n]);"),
	liftFunction("logAuditRefusal"),
].join("\n");
const REQUIRE_ROLE = liftFunction("requireRole");
const AUDIT_HEADER_VALUE = liftFunction("auditHeaderValue");

// The route region: from just after the orphan sweep's boot call to the end of
// the GET /api/db/query/:table handler. The gate the fix defines in it is
// lifted with the routes.
const SWEEP_CALL = "purgeOrphanedDbExports();\n";
const REGION_START = findOnce(`\n${SWEEP_CALL}`, "boot call purgeOrphanedDbExports();") + SWEEP_CALL.length;
const QUERY_HEAD = '\napp.get("/api/db/query/:table", ';
const queryAt = findOnce(QUERY_HEAD, "registration of GET /api/db/query/:table");
findOnce('\napp.post("/api/db/download", ', "registration of POST /api/db/download");
findOnce('\napp.get("/api/db/tables", ', "registration of GET /api/db/tables");
const REGION = SRC.slice(REGION_START, SRC.indexOf("\n});", queryAt) + "\n});".length);
ok("lifted the method guard and the three /api/db routes from server.js",
	REGION.includes('app.all("/api/db/download"') && REGION.includes("db.backup(") && REGION.includes("res.download(")
	&& REGION.includes('app.get("/api/db/tables"') && REGION.includes('app.get("/api/db/query/:table"'));

function ddl(table) {
	const m = SRC.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\t\\)`));
	if (!m) die(`could not locate CREATE TABLE ${table}`);
	return `CREATE TABLE ${table} (${m[1]}\n)`;
}

// ── made-up accounts ────────────────────────────────────────────────────────
const OWNER = { id: 1, username: "owner_admin", role: "Super Admin" };
const SECOND = { id: 7, username: "second_admin", role: "Super Admin" };
const SECOND_AS_TEXT = { id: "7", username: "second_admin", role: "Super Admin" };
const STAFF = { id: 5, username: "staff_admin", role: "Super Admin" };
const OTHER = { id: 6, username: "other_admin", role: "Super Admin" };
const STAFF_AS_OWNER_NAME = { id: 5, username: "owner_admin", role: "Super Admin" };
const NO_ID = { username: "staff_admin", role: "Super Admin" };
const DISPATCHER = { id: 9, username: "desk", role: "Dispatcher" };
const DRIVER = { id: 11, username: "made_up_driver", role: "Driver", driverName: "Made Up Driver" };
const INVESTOR = { id: 12, username: "made_up_investor", role: "Investor" };
const USERS = [
	[1, "owner_admin", "Super Admin"], [7, "second_admin", "Super Admin"],
	[5, "staff_admin", "Super Admin"], [6, "other_admin", "Super Admin"],
	[9, "desk", "Dispatcher"], [11, "made_up_driver", "Driver"], [12, "made_up_investor", "Investor"],
];

const quiet = { log() {}, warn() {}, error() {}, info() {} };
TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dbdl-test-"));
let worldCount = 0;

const ROUTE_PATHS = { download: "/api/db/download", tables: "/api/db/tables", query: "/api/db/query/:table" };
const BLOCKED_ACTION = { download: "db_download_blocked", tables: "db_tables_blocked", query: "db_query_blocked" };

// One world per case: a fresh database file, a fresh temp folder for the
// export copy, fresh refusal and notice windows, fresh counters.
// opts.users: the users rows ([id, username, role]); opts.noticeThrows.
function world(viewers, opts = {}) {
	const dir = path.join(TMP_ROOT, `w${++worldCount}`);
	const exportDir = path.join(dir, "export-tmp");
	fs.mkdirSync(exportDir, { recursive: true });
	const db = new Database(path.join(dir, "made-up.db"));
	db.exec(ddl("audit_trail"));
	if (!opts.noUsersTable) {
		db.exec(ddl("users"));
		const addUser = db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'made-up-hash', ?)");
		for (const u of opts.users || USERS) addUser.run(...u);
	}
	db.exec("CREATE TABLE made_up_rows (id INTEGER PRIMARY KEY, note TEXT)");
	const add = db.prepare("INSERT INTO made_up_rows (note) VALUES (?)");
	for (const n of ["alpha", "bravo", "charlie"]) add.run(`made-up ${n}`);

	const audit = new Function("db", "console", `"use strict";\n${AUDIT_SRC}\nreturn { logAudit, logAuditRefusal };`)(db, quiet);
	const requireRole = new Function("console", `"use strict";\n${REQUIRE_ROLE}\nreturn requireRole;`)(quiet);
	const auditHeaderValue = new Function(`"use strict";\n${AUDIT_HEADER_VALUE}\nreturn auditHeaderValue;`)();
	const seen = { limiter: 0, crossSite: 0, notices: [], live: [] };
	const routes = { all: [], post: [], get: {} };
	const env = {
		app: {
			all: (p, ...h) => { if (p === ROUTE_PATHS.download) routes.all.push(...h); },
			post: (p, ...h) => { if (p === ROUTE_PATHS.download) routes.post.push(...h); },
			get: (p, ...h) => { routes.get[p] = h; },
			use: () => {},
		},
		requireRole,
		refuseCrossOriginStrict: (req, res, next) => { seen.crossSite++; next(); },
		dbAdminLimiter: (req, res, next) => { seen.limiter++; next(); },
		db,
		logAudit: audit.logAudit,
		logAuditRefusal: audit.logAuditRefusal,
		auditHeaderValue,
		RATECON_PDF_VIEWERS: listedAccounts.parseListedAccountIds(viewers),
		maskingEnabled: () => true,
		piiMask,
		insertDispatchNotification: {
			run: (...a) => {
				if (opts.noticeThrows) throw new Error("made-up notice store failure");
				seen.notices.push({ type: a[0], title: a[1], body: a[2], metadata: a[3] });
			},
		},
		io: { to: (room) => ({ emit: (event, payload) => { seen.live.push({ room, event, type: payload && payload.type }); } }) },
		APP_TIMEZONE: "America/New_York",
		fs,
		path,
		crypto,
		os: { tmpdir: () => exportDir },
		console: quiet,
		require: (p) => require(p.startsWith(".") ? path.join(ROOT, p) : p),
	};
	const names = Object.keys(env);
	try {
		new Function(...names, REGION)(...names.map((k) => env[k]));
	} catch (e) {
		die(`the lifted route region did not load (${e.message}); a name it uses may need adding to this runner's env`);
	}
	if (!routes.all.length || !routes.post.length || !routes.get[ROUTE_PATHS.tables] || !routes.get[ROUTE_PATHS.query]) {
		die("the lifted region did not register the method guard and the three routes");
	}

	function run(kind, method, user, extra = {}) {
		let chain;
		if (kind === "download") chain = method === "POST" ? [...routes.all, ...routes.post] : [...routes.all];
		else chain = [...routes.get[ROUTE_PATHS[kind]]];
		const headers = { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "same-origin" };
		const url = kind === "query" ? `/api/db/query/${extra.table || "made_up_rows"}` : ROUTE_PATHS[kind];
		const req = {
			method, url, originalUrl: url, path: url,
			route: { path: ROUTE_PATHS[kind] }, headers, ip: TEST_IP, sessionID: "sid-made-up",
			params: kind === "query" ? { table: extra.table || "made_up_rows" } : {},
			query: {},
			session: user === null ? {} : { user: { ...user } },
			get(h) { return headers[String(h).toLowerCase()]; },
		};
		return new Promise((resolve) => {
			const out = { status: 200, body: null, headers: {}, bytes: null, downloadName: null };
			let done = false;
			const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(out); } };
			const timer = setTimeout(() => { out.timedOut = true; finish(); }, 15000);
			const res = {
				statusCode: 200,
				status(c) { out.status = c; this.statusCode = c; return this; },
				set(k, v) { if (k && typeof k === "object") { for (const [a, b] of Object.entries(k)) out.headers[a.toLowerCase()] = b; } else out.headers[String(k).toLowerCase()] = v; return this; },
				setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
				json(b) { out.body = b; finish(); return this; },
				send(b) { out.body = b; finish(); return this; },
				end() { finish(); return this; },
				download(p, name, cb) {
					try { out.bytes = fs.readFileSync(p); } catch { out.bytes = null; }
					out.downloadName = name;
					if (typeof cb === "function") cb();
					finish();
				},
			};
			let i = 0;
			const next = (err) => {
				if (err) { out.status = 500; out.body = { error: String(err && err.message || err) }; return finish(); }
				const h = chain[i++];
				if (!h) { out.status = 404; return finish(); }
				try {
					const r = h(req, res, next);
					if (r && typeof r.catch === "function") r.catch((e) => { out.status = 500; out.body = { error: e.message }; finish(); });
				} catch (e) { out.status = 500; out.body = { error: e.message, threw: true }; finish(); }
			};
			next();
		});
	}
	return {
		seen,
		post: (user) => run("download", "POST", user),
		get: (user) => run("download", "GET", user),
		call: (kind, user, extra) => run(kind, kind === "download" ? "POST" : "GET", user, extra),
		audits: (action) => db.prepare("SELECT user_id, username, role, action, entity, entity_id, details FROM audit_trail WHERE action = ? ORDER BY id").all(action),
		allAudits: () => db.prepare("SELECT action FROM audit_trail").all(),
		leftovers: () => fs.readdirSync(exportDir),
		close: () => db.close(),
	};
}

const code = (r) => r && r.body && r.body.code;
const SQLITE_MAGIC = "SQLite format 3\u0000";
function copyRowCount(bytes) {
	const p = path.join(TMP_ROOT, `copy-${crypto.randomBytes(4).toString("hex")}.db`);
	fs.writeFileSync(p, bytes);
	const c = new Database(p, { readonly: true });
	try { return c.prepare("SELECT COUNT(*) AS n FROM made_up_rows").get().n; } finally { c.close(); }
}

async function expectAllowed(label, viewers, user, kind = "download") {
	const w = world(viewers);
	const r = await w.call(kind, user);
	if (kind === "download") {
		ok(`${label}: 200 with the database file (${r.status} ${code(r) || ""})`, r.status === 200 && r.downloadName === "app.db" && !!r.bytes && r.bytes.subarray(0, 16).toString("latin1") === SQLITE_MAGIC);
		ok("...the copy holds the made-up rows", !!r.bytes && copyRowCount(r.bytes) === 3);
		const a = w.audits("db_download");
		ok(`...one db_download audit row naming account ${user.id} (${a.length})`, a.length === 1 && String(a[0].user_id) === String(user.id) && a[0].entity === "database" && a[0].entity_id === "app.db");
		ok("...the audit row holds no file contents", a.length === 1 && a[0].details.length < 500 && !a[0].details.includes("SQLite format"));
		ok("...the temp copy is gone", w.leftovers().length === 0);
	} else if (kind === "tables") {
		ok(`${label}: 200 with every table's row count (${r.status} ${code(r) || ""})`, r.status === 200 && !!r.body && !!r.body.tables && r.body.tables.made_up_rows === 3);
	} else {
		ok(`${label}: 200 with the table's rows (${r.status} ${code(r) || ""})`, r.status === 200 && !!r.body && r.body.total === 3 && Array.isArray(r.body.rows) && r.body.rows.length === 3);
	}
	ok(`...no refusal row`, w.audits(BLOCKED_ACTION[kind]).length === 0);
	ok(`...no refusal notice`, w.seen.notices.length === 0 && w.seen.live.length === 0);
	ok(`...the limiter was spent once (${w.seen.limiter})`, w.seen.limiter === 1);
	w.close();
}

// `reason` is the D5 wording the refusal row carries: "unlisted",
// "no account id", "list unset", "list invalid", "role changed" or
// "account not found". `secretish` is raw setting text that must never be
// echoed back or written to the audit log.
async function expectRestricted(label, viewers, user, message, reason, secretish = [], kind = "download", wOpts = {}) {
	const w = world(viewers, wOpts);
	const r = await w.call(kind, user);
	const action = BLOCKED_ACTION[kind];
	ok(`${label}: 403 DB_DOWNLOAD_RESTRICTED (${r.status} ${code(r) || JSON.stringify(r.body && r.body.error)})`, r.status === 403 && code(r) === "DB_DOWNLOAD_RESTRICTED");
	ok(`...says ${JSON.stringify(message)}`, !!r.body && r.body.error === message);
	ok(`...the body holds exactly code and error (${r.body ? Object.keys(r.body).sort().join(",") : "none"})`, !!r.body && Object.keys(r.body).sort().join(",") === "code,error");
	ok(`...Cache-Control: no-store (${r.headers["cache-control"]})`, r.headers["cache-control"] === "no-store");
	if (kind === "download") {
		ok("...no database copy sent and none made", r.bytes === null && r.downloadName === null && w.leftovers().length === 0);
		ok(`...the cross-site guard ran first (${w.seen.crossSite})`, w.seen.crossSite === 1);
	} else {
		ok("...nothing read from the database", !(r.body && (r.body.tables || r.body.rows)));
	}
	ok(`...the limiter is not spent (${w.seen.limiter})`, w.seen.limiter === 0);
	const blocked = w.audits(action);
	const uid = user.id === undefined ? 0 : Number(user.id);
	const wantEntityId = kind === "query" ? "made_up_rows" : "app.db";
	ok(`...one ${action} row for account ${uid} with the code and the IP (${blocked.length})`,
		blocked.length === 1 && Number(blocked[0].user_id) === uid && blocked[0].username === user.username && blocked[0].role === "Super Admin"
		&& blocked[0].entity === "database" && blocked[0].entity_id === wantEntityId
		&& blocked[0].details.includes("[DB_DOWNLOAD_RESTRICTED]") && blocked[0].details.includes(TEST_IP));
	ok(`...the row gives the reason ${JSON.stringify(reason)}`, blocked.length === 1 && blocked[0].details.includes(reason));
	if (kind !== "download") {
		ok("...and records Sec-Fetch-Site (the GETs have no cross-site guard)", blocked.length === 1 && blocked[0].details.includes("Sec-Fetch-Site=same-origin"));
		ok(`...and raises no notice (${w.seen.notices.length})`, w.seen.notices.length === 0 && w.seen.live.length === 0);
	}
	for (const s of secretish) {
		ok(`...the setting's text ${JSON.stringify(s)} is in neither the answer nor the row`,
			!JSON.stringify(r.body || {}).includes(s) && blocked.every((b) => !b.details.includes(s)));
	}
	ok("...and no db_download row", w.audits("db_download").length === 0);
	w.close();
	return r;
}

async function expectRoleRefusal(label, viewers, user, wantStatus, wantError, kind = "download") {
	const w = world(viewers);
	const r = await w.call(kind, user);
	ok(`${label}: ${wantStatus} ${JSON.stringify(wantError)}, as today (${r.status} ${JSON.stringify(r.body && r.body.error)})`, r.status === wantStatus && !!r.body && r.body.error === wantError && !code(r));
	ok("...nothing read or copied, no limiter, no audit row, no notice",
		r.bytes === null && !(r.body && (r.body.tables || r.body.rows)) && w.leftovers().length === 0 && w.seen.limiter === 0 && w.allAudits().length === 0 && w.seen.notices.length === 0);
	w.close();
}

async function main() {
	// ── §1 POST, list "1,7" ───────────────────────────────────────────────────
	console.log("\n§1 POST /api/db/download, RATECON_PDF_VIEWER_IDS=1,7");
	await expectAllowed("listed account 1 (Super Admin)", "1,7", OWNER);
	await expectAllowed("listed account 7 (id held as plain-digit text)", "1,7", SECOND_AS_TEXT);
	await expectRestricted("unlisted Super Admin 5", "1,7", STAFF, RESTRICTED_MESSAGE, "unlisted");
	await expectRestricted("Super Admin 5 under account 1's username", "1,7", STAFF_AS_OWNER_NAME, RESTRICTED_MESSAGE, "unlisted");
	await expectRestricted("a Super Admin session without an account id", "1,7", NO_ID, SIGN_IN_AGAIN_MESSAGE, "no account id");
	{
		// Refusals coalesce like every other refusal: one row a minute per account.
		const w = world("1,7");
		const first = await w.post(STAFF);
		const second = await w.post(STAFF);
		ok(`unlisted Super Admin 5 twice in a minute: both refused (${first.status}, ${second.status})`, first.status === 403 && second.status === 403 && code(second) === "DB_DOWNLOAD_RESTRICTED");
		ok(`...one db_download_blocked row, coalesced (${w.audits("db_download_blocked").length})`, w.audits("db_download_blocked").length === 1);
		const other = await w.post(OTHER);
		ok(`...a second unlisted account gets its own row (${w.audits("db_download_blocked").length})`, other.status === 403 && w.audits("db_download_blocked").length === 2);
		const owner = await w.post(OWNER);
		ok(`...and listed account 1 still downloads after them (${owner.status})`, owner.status === 200 && !!owner.bytes);
		w.close();
	}

	// ── §2 other roles and signed out, list set and unset ─────────────────────
	for (const [setting, viewers] of [["1,7", "1,7"], ["unset", undefined]]) {
		console.log(`\n§2 other roles, RATECON_PDF_VIEWER_IDS ${setting === "unset" ? "unset" : "=" + setting}`);
		await expectRoleRefusal("Dispatcher", viewers, DISPATCHER, 403, "Forbidden");
		await expectRoleRefusal("Driver", viewers, DRIVER, 403, "Forbidden");
		await expectRoleRefusal("Investor", viewers, INVESTOR, 403, "Forbidden");
		await expectRoleRefusal("signed out", viewers, null, 401, "Not authenticated");
	}
	// The role check comes first: listing a Dispatcher's id never opens the route to it.
	console.log("\n§2 RATECON_PDF_VIEWER_IDS=1,9 (a Dispatcher's id on the list)");
	await expectRoleRefusal("listed Dispatcher 9", "1,9", DISPATCHER, 403, "Forbidden");

	// ── §3 unset ──────────────────────────────────────────────────────────────
	console.log(`\n§3 RATECON_PDF_VIEWER_IDS unset (D3: ${UNSET_REFUSES_EVERYONE ? "nobody downloads in the app" : "every Super Admin, as before"})`);
	if (UNSET_REFUSES_EVERYONE) {
		await expectRestricted("Super Admin 1, list unset", undefined, OWNER, RESTRICTED_MESSAGE, "list unset");
		await expectRestricted("Super Admin 5, list unset", undefined, STAFF, RESTRICTED_MESSAGE, "list unset");
	} else {
		await expectAllowed("Super Admin 1, list unset", undefined, OWNER);
		await expectAllowed("Super Admin 5, list unset", undefined, STAFF);
	}

	// ── §4 set but invalid: fail closed ───────────────────────────────────────
	console.log("\n§4 RATECON_PDF_VIEWER_IDS set but invalid");
	for (const [raw, secretish] of [["", []], ["   ", []], ["1,abc", ["abc"]], ["01", []], ["1,,7", []], ["owner_admin", ["owner_admin"]]]) {
		await expectRestricted(`Super Admin 1, list ${JSON.stringify(raw)}`, raw, OWNER, RESTRICTED_MESSAGE, "list invalid", secretish);
	}

	// ── §5 GET stays 405 ──────────────────────────────────────────────────────
	console.log("\n§5 GET /api/db/download");
	{
		const w = world("1,7");
		const r = await w.get(OWNER);
		ok(`GET from listed account 1: 405 DB_EXPORT_METHOD, Allow: POST (${r.status} ${code(r)})`, r.status === 405 && code(r) === "DB_EXPORT_METHOD" && r.headers.allow === "POST");
		ok("...no copy and no audit row", r.bytes === null && w.allAudits().length === 0);
		w.close();
	}

	// ── §6 the start-up messages name the database download ───────────────────
	console.log("\n§6 start-up messages");
	{
		const a = SRC.indexOf('fromSetting(\n\t"RATECON_PDF_VIEWER_IDS"');
		const call = a < 0 ? "" : SRC.slice(a, SRC.indexOf("\n);", a));
		const unsetMeans = (call.match(/unsetMeans:\s*"([^"]*)"/) || [])[1] || "";
		const invalidMeans = (call.match(/invalidMeans:\s*"([^"]*)"/) || [])[1] || "";
		ok("found the RATECON_PDF_VIEWER_IDS start-up messages", !!unsetMeans && !!invalidMeans);
		ok("the unset warning says what it means for the database download", /database/i.test(unsetMeans));
		if (UNSET_REFUSES_EVERYONE) {
			ok("...and says nobody downloads it (D3 = B)", /(nobody|no one)[^.;]*database/i.test(unsetMeans));
		}
		ok("the invalid error says what it means for the database download", /database/i.test(invalidMeans));
		const ex = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
		const block = ex.slice(ex.indexOf("# --- Rate-con viewers and protected accounts"), ex.indexOf("# RATECON_PDF_VIEWER_IDS="));
		ok(".env.example says the list also limits the database download", /database/i.test(block));
		ok("...and that unset means nobody downloads the database in the app (D10)", /(nobody|no one)[^.]*database/i.test(block));
	}

	// ── §7 the GET routes (D8) ────────────────────────────────────────────────
	for (const kind of ["tables", "query"]) {
		console.log(`\n§7 GET ${ROUTE_PATHS[kind]} (D8)`);
		await expectAllowed(`listed account 1, ${kind}`, "1,7", OWNER, kind);
		await expectRestricted(`unlisted Super Admin 5, ${kind}`, "1,7", STAFF, RESTRICTED_MESSAGE, "unlisted", [], kind);
		await expectRestricted(`a session without an account id, ${kind}`, "1,7", NO_ID, SIGN_IN_AGAIN_MESSAGE, "no account id", [], kind);
		if (UNSET_REFUSES_EVERYONE) await expectRestricted(`Super Admin 1, list unset, ${kind}`, undefined, OWNER, RESTRICTED_MESSAGE, "list unset", [], kind);
		await expectRestricted(`Super Admin 1, list "1,abc", ${kind}`, "1,abc", OWNER, RESTRICTED_MESSAGE, "list invalid", ["abc"], kind);
		await expectRoleRefusal(`Dispatcher, ${kind}`, "1,7", DISPATCHER, 403, "Forbidden", kind);
		await expectRoleRefusal(`signed out, ${kind}`, "1,7", null, 401, "Not authenticated", kind);
	}
	{
		const w = world("1,7");
		const longName = "x".repeat(500);
		const r = await w.call("query", STAFF, { table: longName });
		const rows = w.audits("db_query_blocked");
		ok(`a refused query naming a 500-character table: 403 (${r.status}), its row's entity_id capped at 64 (${rows[0] && rows[0].entity_id.length})`,
			r.status === 403 && rows.length === 1 && rows[0].entity_id.length <= 64);
		w.close();
	}

	// ── §8 the refusal notice on the POST (D6) ────────────────────────────────
	console.log("\n§8 the refusal notice (POST only)");
	{
		const w = world("1,7");
		await w.post(STAFF);
		const n = w.seen.notices;
		ok(`unlisted Super Admin 5: one stored notice of type ${NOTICE_TYPE} (${n.length})`, n.length === 1 && n[0].type === NOTICE_TYPE);
		ok(`...naming the account and the IP (${n[0] && JSON.stringify(n[0].body)})`, n.length === 1 && n[0].body.includes("Account #5 (staff_admin)") && n[0].body.includes(TEST_IP) && /tried to download the database/i.test(n[0].body));
		ok(`...sent live to the super-admin room only (${JSON.stringify(w.seen.live)})`, w.seen.live.length === 1 && w.seen.live[0].room === "super-admin" && w.seen.live[0].event === "dispatch-notification" && w.seen.live[0].type === NOTICE_TYPE);
		await w.post(STAFF);
		ok(`...a second refusal the same day raises no second notice (${w.seen.notices.length})`, w.seen.notices.length === 1 && w.seen.live.length === 1);
		await w.post(OTHER);
		ok(`...another account's first refusal raises its own (${w.seen.notices.length})`, w.seen.notices.length === 2);
		w.close();
	}
	{
		const w = world("1,7");
		await w.post(NO_ID);
		const n = w.seen.notices;
		ok(`a session without an account id: one notice that never says "Account #0" (${n[0] && JSON.stringify(n[0].body)})`,
			n.length === 1 && /session without an account id/i.test(n[0].body) && !n[0].body.includes("#0"));
		w.close();
	}
	{
		const w = world("1,7", { noticeThrows: true });
		const r = await w.post(STAFF);
		ok(`the notice store failing: still 403 DB_DOWNLOAD_RESTRICTED (${r.status} ${code(r)})`, r.status === 403 && code(r) === "DB_DOWNLOAD_RESTRICTED");
		ok("...and still one db_download_blocked row", w.audits("db_download_blocked").length === 1);
		w.close();
	}

	// ── §9 a listed account whose role changed or that was removed (L8) ───────
	console.log("\n§9 the listed account is re-read by id");
	const demoted = USERS.map((u) => (u[0] === 7 ? [7, "second_admin", "Dispatcher"] : u));
	const removed = USERS.filter((u) => u[0] !== 7);
	await expectRestricted("listed 7, session says Super Admin, account now a Dispatcher", "1,7", SECOND, SIGN_IN_AGAIN_MESSAGE, "role changed", [], "download", { users: demoted });
	await expectRestricted("listed 7, session says Super Admin, account removed", "1,7", SECOND, SIGN_IN_AGAIN_MESSAGE, "account not found", [], "download", { users: removed });
	await expectRestricted("listed 7, account now a Dispatcher, tables", "1,7", SECOND, SIGN_IN_AGAIN_MESSAGE, "role changed", [], "tables", { users: demoted });
	await expectRestricted("listed 1, the account can't be re-read: fail closed", "1,7", OWNER, RESTRICTED_MESSAGE, "account unreadable", [], "download", { noUsersTable: true });

	// ── §10 who sees the notice (L5) ──────────────────────────────────────────
	console.log("\n§10 the notice is Super Admin-only");
	{
		let scope = null;
		try {
			const deps = lift.closure(SRC, { roots: ["noticeTypeScope"], provided: [], denied: ["app", "io", "server", "db"] }).text;
			scope = new Function(`"use strict";\n${deps}\nreturn { noticeTypeScope, SUPER_ADMIN_ONLY_NOTICE_TYPES };`)();
		} catch (e) { ok(`lifted noticeTypeScope() (${e.message})`, false); }
		if (scope) {
			ok(`${NOTICE_TYPE} is on SUPER_ADMIN_ONLY_NOTICE_TYPES (${JSON.stringify(scope.SUPER_ADMIN_ONLY_NOTICE_TYPES)})`, scope.SUPER_ADMIN_ONLY_NOTICE_TYPES.includes(NOTICE_TYPE));
			const db = new Database(":memory:");
			db.exec(ddl("dispatch_notifications"));
			const add = db.prepare("INSERT INTO dispatch_notifications (type, title, body, metadata) VALUES (?, ?, 'made-up', '{}')");
			add.run(NOTICE_TYPE, "Database download refused");
			add.run("new-load", "New Load 100000001");
			const visible = (user) => {
				const s = scope.noticeTypeScope(user);
				return db.prepare(`SELECT type FROM dispatch_notifications WHERE ${s.sql} ORDER BY id`).all(...s.params).map((x) => x.type);
			};
			ok(`a Dispatcher never sees it (${JSON.stringify(visible(DISPATCHER))})`, JSON.stringify(visible(DISPATCHER)) === JSON.stringify(["new-load"]));
			ok(`a Super Admin does (${JSON.stringify(visible(OWNER))})`, JSON.stringify(visible(OWNER)) === JSON.stringify([NOTICE_TYPE, "new-load"]));
			db.close();
		}
	}

	cleanUp();
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	cleanUp();
	console.error(`FAIL  ${e && e.stack || e}`);
	process.exit(1);
});
