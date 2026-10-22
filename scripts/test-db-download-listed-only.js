#!/usr/bin/env node
/**
 * scripts/test-db-download-listed-only.js — POST /api/db/download is limited to
 * the accounts listed in RATECON_PDF_VIEWER_IDS.
 *
 * The rule (Arvin, 2026-10-22; plan in the replica reports folder,
 * 2026-10-22-db-download-listed-only-plan.md):
 *   - a listed Super Admin downloads the database as today, and the download
 *     is audited (db_download, as today);
 *   - every other Super Admin gets 403 DB_DOWNLOAD_RESTRICTED: no copy is made,
 *     the limiter is not spent, and the attempt is audited as
 *     db_download_blocked (who, when, from where; never file contents),
 *     coalesced to one row a minute per account like every other refusal;
 *   - a session without a usable account id is told to sign in again (same
 *     code), and a username never counts;
 *   - Dispatcher, Driver, Investor and signed-out callers are refused exactly as
 *     today (requireRole's 403 "Forbidden" / 401), with no audit row;
 *   - the list set but invalid: every Super Admin refused (fail closed);
 *   - the list unset: decision D3 (UNSET_REFUSES_EVERYONE below; the plan
 *     recommends refusing everyone).
 *
 * §1 list "1,7"   §2 other roles and signed out   §3 unset   §4 invalid
 * §5 GET stays 405   §6 the start-up messages name the database download
 *
 * WHAT IS REAL. Everything from the boot-time orphan sweep's call
 * (`purgeOrphanedDbExports();`) to the end of the POST /api/db/download
 * handler is lifted from server.js whole and run as shipped: the method guard,
 * whatever gate the fix adds in that region, and the handler with its real
 * db.backup() and 0600 temp file. requireRole, logAudit and logAuditRefusal
 * are lifted from server.js and write a real audit_trail; the list is the
 * shipped lib/listed-accounts.js. Stubs: the cross-site guard (a pass-through;
 * scripts/test-db-export-guard.js covers it), the limiter (a counter, so "a
 * refusal spends none of the budget" is visible), os.tmpdir() (a fresh folder
 * per case) and res.download (reads the copy, then runs the route's callback).
 *
 * Made-up data only: accounts 1 and 7 listed Super Admins, 5 an unlisted Super
 * Admin, 9 a Dispatcher, 11 a Driver, 12 an Investor; three made-up rows; a
 * documentation-range IP. No server, no port, no app.db, no network.
 *
 * Run: node scripts/test-db-download-listed-only.js
 * From a git worktree (no node_modules): NODE_PATH=<repo>/node_modules node ...
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Decision D3 in the plan: what an UNSET RATECON_PDF_VIEWER_IDS means for the
// database download. true = nobody downloads in the app (recommended); false =
// every Super Admin, as before the list existed (#570's D4 for rate cons).
const UNSET_REFUSES_EVERYONE = true;

const RESTRICTED_MESSAGE = "Downloading the database is limited to the owner.";
const SIGN_IN_AGAIN_MESSAGE = "Your session is out of date. Sign in again to download the database.";
const TEST_IP = "203.0.113.9";

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
try { listedAccounts = require(path.join(ROOT, "lib", "listed-accounts.js")); } catch (e) { die(`lib/listed-accounts.js did not load (${e.code || e.message})`); }

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

// The route region: from just after the orphan sweep's boot call to the end of
// the POST handler. A gate the fix defines between those two points is lifted
// with it.
const SWEEP_CALL = "purgeOrphanedDbExports();\n";
const REGION_START = findOnce(`\n${SWEEP_CALL}`, "boot call purgeOrphanedDbExports();") + SWEEP_CALL.length;
const POST_HEAD = '\napp.post("/api/db/download", ';
const postAt = findOnce(POST_HEAD, "registration of POST /api/db/download");
const REGION = SRC.slice(REGION_START, SRC.indexOf("\n});", postAt) + "\n});".length);
ok("lifted the method guard and the POST /api/db/download route from server.js",
	REGION.includes('app.all("/api/db/download"') && REGION.includes("db.backup(") && REGION.includes("res.download("));

function auditDdl() {
	const m = SRC.match(/CREATE TABLE IF NOT EXISTS audit_trail \(([\s\S]*?)\n\t\)/);
	if (!m) die("could not locate CREATE TABLE audit_trail");
	return `CREATE TABLE audit_trail (${m[1]}\n)`;
}

// ── made-up accounts ────────────────────────────────────────────────────────
const OWNER = { id: 1, username: "owner_admin", role: "Super Admin" };
const SECOND_AS_TEXT = { id: "7", username: "second_admin", role: "Super Admin" };
const STAFF = { id: 5, username: "staff_admin", role: "Super Admin" };
const STAFF_AS_OWNER_NAME = { id: 5, username: "owner_admin", role: "Super Admin" };
const NO_ID = { username: "staff_admin", role: "Super Admin" };
const DISPATCHER = { id: 9, username: "desk", role: "Dispatcher" };
const DRIVER = { id: 11, username: "made_up_driver", role: "Driver", driverName: "Made Up Driver" };
const INVESTOR = { id: 12, username: "made_up_investor", role: "Investor" };

const quiet = { log() {}, warn() {}, error() {}, info() {} };
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dbdl-test-"));
let worldCount = 0;

// One world per case: a fresh database file, a fresh temp folder for the
// export copy, a fresh refusal-coalescing window and a fresh limiter count.
function world(viewers) {
	const dir = path.join(TMP_ROOT, `w${++worldCount}`);
	const exportDir = path.join(dir, "export-tmp");
	fs.mkdirSync(exportDir, { recursive: true });
	const db = new Database(path.join(dir, "made-up.db"));
	db.exec(auditDdl());
	db.exec("CREATE TABLE made_up_rows (id INTEGER PRIMARY KEY, note TEXT)");
	const add = db.prepare("INSERT INTO made_up_rows (note) VALUES (?)");
	for (const n of ["alpha", "bravo", "charlie"]) add.run(`made-up ${n}`);

	const audit = new Function("db", "console", `"use strict";\n${AUDIT_SRC}\nreturn { logAudit, logAuditRefusal };`)(db, quiet);
	const requireRole = new Function("console", `"use strict";\n${REQUIRE_ROLE}\nreturn requireRole;`)(quiet);
	const seen = { limiter: 0, crossSite: 0 };
	const routes = { all: [], post: [] };
	const env = {
		app: {
			all: (p, ...h) => { if (p === "/api/db/download") routes.all.push(...h); },
			post: (p, ...h) => { if (p === "/api/db/download") routes.post.push(...h); },
			get: () => {},
			use: () => {},
		},
		requireRole,
		refuseCrossOriginStrict: (req, res, next) => { seen.crossSite++; next(); },
		dbAdminLimiter: (req, res, next) => { seen.limiter++; next(); },
		db,
		logAudit: audit.logAudit,
		logAuditRefusal: audit.logAuditRefusal,
		RATECON_PDF_VIEWERS: viewers === undefined ? listedAccounts.parseListedAccountIds(undefined) : listedAccounts.parseListedAccountIds(viewers),
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
	if (!routes.all.length || !routes.post.length) die("the lifted region did not register the method guard and the POST route");

	function run(method, user) {
		const chain = method === "POST" ? [...routes.all, ...routes.post] : [...routes.all];
		const headers = { "x-requested-with": "XMLHttpRequest", "sec-fetch-site": "same-origin" };
		const req = {
			method, url: "/api/db/download", originalUrl: "/api/db/download", path: "/api/db/download",
			route: { path: "/api/db/download" }, headers, ip: TEST_IP, sessionID: "sid-made-up",
			session: user === null ? {} : { user: { ...user } },
			get(h) { return headers[String(h).toLowerCase()]; },
		};
		return new Promise((resolve) => {
			const out = { status: 200, body: null, headers: {}, bytes: null, downloadName: null, reachedEnd: false };
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
				if (!h) { out.reachedEnd = true; out.status = 404; return finish(); }
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
		post: (user) => run("POST", user),
		get: (user) => run("GET", user),
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

async function expectAllowed(label, viewers, user) {
	const w = world(viewers);
	const r = await w.post(user);
	ok(`${label}: 200 with the database file (${r.status} ${code(r) || ""})`, r.status === 200 && r.downloadName === "app.db" && !!r.bytes && r.bytes.subarray(0, 16).toString("latin1") === SQLITE_MAGIC);
	ok("...the copy holds the made-up rows", !!r.bytes && copyRowCount(r.bytes) === 3);
	const a = w.audits("db_download");
	ok(`...one db_download audit row naming account ${user.id} (${a.length})`, a.length === 1 && String(a[0].user_id) === String(user.id) && a[0].entity === "database" && a[0].entity_id === "app.db");
	ok("...the audit row holds no file contents", a.length === 1 && a[0].details.length < 500 && !a[0].details.includes("SQLite format"));
	ok("...no refusal row", w.audits("db_download_blocked").length === 0);
	ok("...the temp copy is gone", w.leftovers().length === 0);
	w.close();
}

async function expectRestricted(label, viewers, user, message) {
	const w = world(viewers);
	const r = await w.post(user);
	ok(`${label}: 403 DB_DOWNLOAD_RESTRICTED (${r.status} ${code(r) || JSON.stringify(r.body && r.body.error)})`, r.status === 403 && code(r) === "DB_DOWNLOAD_RESTRICTED");
	ok(`...says ${JSON.stringify(message)}`, !!r.body && r.body.error === message);
	ok("...no database copy sent and none made", r.bytes === null && r.downloadName === null && w.leftovers().length === 0);
	ok(`...the limiter is not spent (${w.seen.limiter})`, w.seen.limiter === 0);
	const blocked = w.audits("db_download_blocked");
	const uid = user.id === undefined ? 0 : Number(user.id);
	ok(`...one db_download_blocked row for account ${uid} with the code and the IP (${blocked.length})`,
		blocked.length === 1 && Number(blocked[0].user_id) === uid && blocked[0].username === user.username && blocked[0].role === "Super Admin"
		&& blocked[0].entity === "database" && blocked[0].entity_id === "app.db"
		&& blocked[0].details.includes("[DB_DOWNLOAD_RESTRICTED]") && blocked[0].details.includes(TEST_IP));
	ok("...and no db_download row", w.audits("db_download").length === 0);
	w.close();
	return r;
}

async function expectRoleRefusal(label, viewers, user, wantStatus, wantError) {
	const w = world(viewers);
	const r = await w.post(user);
	ok(`${label}: ${wantStatus} ${JSON.stringify(wantError)}, as today (${r.status} ${JSON.stringify(r.body && r.body.error)})`, r.status === wantStatus && !!r.body && r.body.error === wantError && !code(r));
	ok("...no copy, no limiter, no audit row", r.bytes === null && w.leftovers().length === 0 && w.seen.limiter === 0 && w.allAudits().length === 0);
	w.close();
}

async function main() {
	// ── §1 list "1,7" ─────────────────────────────────────────────────────────
	console.log("\n§1 RATECON_PDF_VIEWER_IDS=1,7");
	await expectAllowed("listed account 1 (Super Admin)", "1,7", OWNER);
	await expectAllowed("listed account 7 (id held as plain-digit text)", "1,7", SECOND_AS_TEXT);
	await expectRestricted("unlisted Super Admin 5", "1,7", STAFF, RESTRICTED_MESSAGE);
	await expectRestricted("Super Admin 5 under account 1's username", "1,7", STAFF_AS_OWNER_NAME, RESTRICTED_MESSAGE);
	await expectRestricted("a Super Admin session without an account id", "1,7", NO_ID, SIGN_IN_AGAIN_MESSAGE);
	{
		// Refusals coalesce like every other refusal: one row a minute per account.
		const w = world("1,7");
		const first = await w.post(STAFF);
		const second = await w.post(STAFF);
		ok(`unlisted Super Admin 5 twice in a minute: both refused (${first.status}, ${second.status})`, first.status === 403 && second.status === 403 && code(second) === "DB_DOWNLOAD_RESTRICTED");
		ok(`...one db_download_blocked row, coalesced (${w.audits("db_download_blocked").length})`, w.audits("db_download_blocked").length === 1);
		const other = await w.post({ id: 6, username: "other_admin", role: "Super Admin" });
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

	// ── §3 unset ──────────────────────────────────────────────────────────────
	console.log(`\n§3 RATECON_PDF_VIEWER_IDS unset (D3: ${UNSET_REFUSES_EVERYONE ? "nobody downloads in the app" : "every Super Admin, as before"})`);
	if (UNSET_REFUSES_EVERYONE) {
		await expectRestricted("Super Admin 1, list unset", undefined, OWNER, RESTRICTED_MESSAGE);
		await expectRestricted("Super Admin 5, list unset", undefined, STAFF, RESTRICTED_MESSAGE);
	} else {
		await expectAllowed("Super Admin 1, list unset", undefined, OWNER);
		await expectAllowed("Super Admin 5, list unset", undefined, STAFF);
	}

	// ── §4 set but invalid: fail closed ───────────────────────────────────────
	console.log("\n§4 RATECON_PDF_VIEWER_IDS set but invalid");
	for (const raw of ["", "   ", "1,abc", "01", "1,,7", "owner_admin"]) {
		await expectRestricted(`Super Admin 1, list ${JSON.stringify(raw)}`, raw, OWNER, RESTRICTED_MESSAGE);
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
		ok("the invalid error says what it means for the database download", /database/i.test(invalidMeans));
	}

	try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
	console.error(`FAIL  ${e && e.stack || e}`);
	process.exit(1);
});
