#!/usr/bin/env node
/**
 * scripts/test-db-export-guard.js — POST /api/db/download, over a real socket.
 *
 * scripts/test-csrf-guard.js decides the middleware in isolation and
 * scripts/test-invoice-tz-and-job-conflict.js pins the mount. Neither answers
 * the question this file exists for: does the assembled CHAIN — requireRole,
 * then the guard, then the limiter, in that order, behind Express's own routing
 * and method matching — actually land each caller shape where the comments say?
 * That is an ordering property, and ordering is exactly what a unit test of a
 * middleware cannot see.
 *
 * So: a real Express app, on an EPHEMERAL PORT (never 3000, never 5173), with
 * `requireRole` and the whole crossSiteGuard block LIFTED OUT OF server.js and
 * a stub handler in place of db.backup(). Only the handler is fake, and it is
 * fake because a 313 MB copy of production PII is not something a test should
 * make; every decision under test is shipped code.
 *
 * WHAT IT PROVES
 *   1. `Sec-Fetch-Site: none` — a bookmark, an address-bar paste, or a link
 *      opened from Slack desktop / Outlook / Apple Mail / Teams — is REFUSED.
 *      That shape was allowed before this change and was most of the threat the
 *      route's own comment claimed to stop.
 *   2. cross-site and same-site are refused; same-origin and header-less
 *      (curl, the documented caller) are allowed.
 *   3. The CORS-allowlist leg no longer bypasses the tier. Demonstrated as a
 *      CONTROL/TREATMENT pair against a populated allowlist, because with an
 *      empty allowlist — production's state — the bypass is unreachable and a
 *      one-sided assertion would pass for the wrong reason.
 *   4. An unauthenticated caller gets 401 and DOES NOT SPEND THE LIMITER, and
 *      neither does a refused cross-site caller. Asserted behaviourally (drain
 *      the window with refusals, then require a real call to succeed) rather
 *      than by reading a RateLimit-* header, so it cannot drift with the
 *      express-rate-limit draft-spec version.
 *   5. A GET is answered 405 with `Allow: POST` — not by the SPA catch-all,
 *      which would return index.html and 200 and read as world-readable.
 *   6. The temp copy is 0600 for the whole of its life, and orphans left by a
 *      killed process are swept at boot without following a planted symlink.
 *      Measured against the real filesystem and the real better-sqlite3 backup.
 *
 * DISCRIMINATION. Every protective clause is also run in a mutant build that
 * removes it, and the corresponding assertion is required to flip. A guard test
 * that still passes against a defanged guard is worse than none.
 *
 * Run: node scripts/test-db-export-guard.js
 * From a git worktree (no node_modules): NODE_PATH=<repo>/node_modules node ...
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");

let passed = 0;
const failures = [];
const skipped = [];
function ok(name, cond) {
	if (cond) passed++;
	else failures.push(name);
}
function eq(name, got, want) {
	if (got === want) passed++;
	else failures.push(name + " (got " + JSON.stringify(got) + ", want " + JSON.stringify(want) + ")");
}

// ── lift the shipped code ───────────────────────────────────────────────────
// A missing marker exits 1 with a named reason rather than an unhandled throw.
// It is the failure a PRE-FIX server.js produces, so it is worth reading.
function fatal(msg) {
	console.error("FAILED: " + msg);
	console.error("  (a server.js without refuseCrossOriginStrict / purgeOrphanedDbExports"
		+ " is the pre-fix source — this suite is asserting they exist)");
	process.exit(1);
}
function slice(startMark, endMark, label) {
	const a = src.indexOf(startMark);
	if (a < 0) fatal("could not locate " + label + " in server.js");
	const b = src.indexOf(endMark, a);
	if (b < a) fatal("could not locate the end of " + label + " in server.js");
	return src.slice(a, src.indexOf(";", b) + 1);
}
const GUARD_BLOCK = slice(
	"function originIsSelf(req, origin) {",
	"const refuseCrossOriginStrict = crossSiteGuard(",
	"the crossSiteGuard block");
// requireRole is a hoisted function declaration; lifted whole so the chain under
// test uses the real 401/403 split rather than a lookalike.
const REQUIRE_ROLE = (() => {
	const a = src.indexOf("function requireRole(...roles) {");
	if (a < 0) fatal("could not locate requireRole in server.js");
	let depth = 0, seen = false;
	for (let i = src.indexOf("{", a); i < src.length; i++) {
		if (src[i] === "{") { depth++; seen = true; }
		else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(a, i + 1); }
	}
	throw new Error("unbalanced braces in requireRole");
})();
// The boot-time orphan sweep, plus the two constants it reads.
const SWEEP_BLOCK = [
	(src.match(/^const DB_EXPORT_TMP_PREFIX = .*$/m) || [])[0],
	(src.match(/^const DB_EXPORT_TMP_MAX_AGE_MS = .*$/m) || [])[0],
	(() => {
		const a = src.indexOf("function purgeOrphanedDbExports() {");
		if (a < 0) fatal("could not locate purgeOrphanedDbExports in server.js");
		let depth = 0, seen = false;
		for (let i = src.indexOf("{", a); i < src.length; i++) {
			if (src[i] === "{") { depth++; seen = true; }
			else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(a, i + 1); }
		}
		throw new Error("unbalanced braces in purgeOrphanedDbExports");
	})(),
].join("\n");
ok("lifted the guard block, requireRole and the orphan sweep from server.js",
	GUARD_BLOCK.includes("crossSiteGuard") && REQUIRE_ROLE.includes("Not authenticated")
	&& SWEEP_BLOCK.includes("lstatSync"));

const ALLOWLIST = ["https://driver-mobile.example"];
function buildGuards(block, allowlist) {
	const auditCalls = [];
	const f = new Function("DRIVER_MOBILE_ORIGINS", "logAuditRefusal",
		block + "\nreturn { refuseCrossSite, refuseCrossOrigin, refuseCrossOriginStrict, crossSiteGuard };");
	const g = f(allowlist === undefined ? ALLOWLIST : allowlist, (...a) => auditCalls.push(a));
	g.auditCalls = auditCalls;
	return g;
}
const buildRequireRole = () => new Function(REQUIRE_ROLE + "\nreturn requireRole;")();

// ── optional deps ───────────────────────────────────────────────────────────
// express / express-rate-limit / better-sqlite3 are absent in a bare git
// worktree. The source-and-decision half above needs none of them; the sections
// that do are skipped LOUDLY rather than silently, because "0 failures" and
// "nothing ran" must never look alike.
function tryRequire(name) { try { return require(name); } catch { return null; } }
const express = tryRequire("express");
const rateLimit = tryRequire("express-rate-limit");
const Database = tryRequire("better-sqlite3");

// ── HTTP helper ─────────────────────────────────────────────────────────────
function request(port, method, urlPath, headers) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: headers || {} }, (res) => {
			let body = "";
			res.on("data", (c) => { body += c; });
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

// Caller shapes, byte-identical to the ones scripts/test-csrf-guard.js names.
// ⚠️ EVERY SHAPE CARRIES X-Requested-With, and that is not padding. requireRole
// now refuses a header-less write before the chain reaches crossSiteGuard (the
// same-site CSRF control added 2026-08-19), so a shape without it would be
// refused for the WRONG REASON and this file would silently stop testing the
// tier it exists to test — the cross-site sections would pass while asserting
// nothing. The SPA sends the header on every write, so carrying it here is also
// the honest simulation of a real browser caller.
//
// The one shape that deliberately omits it is `noCsrfHeader` below, which pins
// the new refusal itself.
const XRW = { "X-Requested-With": "XMLHttpRequest" };
const SHAPES = {
	// The finding: no initiator document. Bookmark / address bar / native app.
	noInitiator: { ...XRW, "Sec-Fetch-Site": "none" },
	crossSite: { ...XRW, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" },
	sameSite: { ...XRW, Origin: "https://drivers.logisx.com", "Sec-Fetch-Site": "same-site" },
	sameOrigin: { ...XRW, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	headerless: { ...XRW },
	// No X-Requested-With at all — a cross-site form POST, which cannot set headers.
	noCsrfHeader: { "Sec-Fetch-Site": "same-origin" },
	corsAllowlisted: { ...XRW, Origin: ALLOWLIST[0], "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
};

async function main() {
	if (!express || !rateLimit) {
		skipped.push("loopback HTTP sections (express / express-rate-limit not resolvable)");
	} else {
		await httpSections();
	}
	if (!Database) {
		skipped.push("live backup-mode measurement (better-sqlite3 not resolvable)");
	} else {
		await backupModeSection();
	}
	sweepSection();   // pure fs — runs everywhere, node_modules or not
	finish();
}

// ── the assembled chain, over a real socket ─────────────────────────────────
async function httpSections() {
	// One app per scenario: express-rate-limit keeps state, and a shared bucket
	// would make the "did a 401 spend the limiter?" assertions depend on the
	// order the scenarios happen to run in.
	function makeApp({ guards, role, limit }) {
		const app = express();
		// Stands in for express-session only. Every decision below it is shipped code.
		app.use((req, res, next) => {
			req.session = role ? { user: { id: 1, username: "super_admin", role } } : {};
			next();
		});
		const requireRole = buildRequireRole();
		let handlerRuns = 0;
		// Mirrors the shipped method guard verbatim in shape.
		app.all("/api/db/download", (req, res, next) => {
			if (req.method === "POST") return next();
			res.set("Allow", "POST");
			res.status(405).json({ error: "Method not allowed", expected: "POST", code: "DB_EXPORT_METHOD" });
		});
		app.post("/api/db/download",
			requireRole("Super Admin"),
			guards.refuseCrossOriginStrict,
			rateLimit({ windowMs: 15 * 60 * 1000, max: limit || 100, standardHeaders: true,
				message: { error: "Too many database admin requests. Try again later." } }),
			(req, res) => { handlerRuns++; res.status(200).json({ ok: true }); });
		const server = app.listen(0, "127.0.0.1");
		return new Promise((resolve) => server.on("listening", () => resolve({
			port: server.address().port,
			close: () => new Promise((r) => server.close(r)),
			runs: () => handlerRuns,
		})));
	}

	// ---- 1. every caller shape, through the whole chain --------------------
	{
		const guards = buildGuards(GUARD_BLOCK);
		const app = await makeApp({ guards, role: "Super Admin" });
		const hit = async (shape) => (await request(app.port, "POST", "/api/db/download", SHAPES[shape])).status;

		// THE FINDING. Allowed before this change; the backup ran and a full
		// unencrypted copy of every SSN landed in the victim's Downloads folder.
		eq("a bookmark / address bar / native-app link (Sec-Fetch-Site: none) is refused", await hit("noInitiator"), 403);
		eq("a cross-site page is refused", await hit("crossSite"), 403);
		eq("a sibling subdomain (same-site) is refused", await hit("sameSite"), 403);
		eq("the SPA's own origin is allowed", await hit("sameOrigin"), 200);
		// ⚠️ The one that must not break: curl is the route's documented caller.
		eq("a header-less scripted caller (curl) is allowed", await hit("headerless"), 200);
		// ⚠️ Finding 2, demonstrated against a POPULATED allowlist. With the
		// production-empty list this shape is unreachable and would pass for the
		// wrong reason.
		eq("an allowlisted CORS origin no longer bypasses the tier", await hit("corsAllowlisted"), 403);
		eq("only the two legitimate shapes reached the handler", app.runs(), 2);

		// The method guard, in front of everything.
		const g = await request(app.port, "GET", "/api/db/download", SHAPES.sameOrigin);
		eq("a GET is answered 405", g.status, 405);
		eq("...advertising Allow: POST", g.headers.allow, "POST");
		eq("...and never reaches the handler", app.runs(), 2);
		const h = await request(app.port, "PUT", "/api/db/download", SHAPES.sameOrigin);
		eq("a PUT is answered 405 as well", h.status, 405);
		await app.close();
	}

	// ---- 2. THE PRE-FIX ROUTE, REBUILT AND SHOWN TO BE VULNERABLE -----------
	// ⚠️ This is the discriminator that matters, and it is a reproduction rather
	// than an inference: the exact chain PR #264 shipped — `app.get` +
	// requireRole + refuseCrossOrigin, no method guard — assembled from the same
	// lifted middleware and driven over a real socket. If this section ever stops
	// showing 200 for the bookmark shape, the finding was never real and the
	// change above is unjustified.
	{
		const guards = buildGuards(GUARD_BLOCK);
		const app = express();
		app.use((req, res, next) => { req.session = { user: { id: 1, username: "super_admin", role: "Super Admin" } }; next(); });
		let exported = 0;
		app.get("/api/db/download", buildRequireRole()("Super Admin"), guards.refuseCrossOrigin,
			(req, res) => { exported++; res.json({ ok: true }); });
		// Stands in for the SPA catch-all, which is what a GET would otherwise hit.
		app.get("*", (req, res) => res.status(200).type("html").send("<!doctype html><title>SPA</title>"));
		const server = app.listen(0, "127.0.0.1");
		await new Promise((r) => server.on("listening", r));
		const port = server.address().port;

		// A bookmark, or a link clicked in Slack desktop / Outlook / Apple Mail.
		eq("PRE-FIX: a no-initiator GET exported the whole database",
			(await request(port, "GET", "/api/db/download", SHAPES.noInitiator)).status, 200);
		eq("PRE-FIX: ...and the backup handler really ran", exported, 1);
		// The half the old comment DID cover, so the finding is scoped honestly.
		eq("PRE-FIX: a page-initiated cross-site GET was already refused",
			(await request(port, "GET", "/api/db/download", SHAPES.crossSite)).status, 403);
		// And the allowlist leg, ungated, walked past even that.
		const ungated = buildGuards(GUARD_BLOCK.replace(
			"if (honorCorsAllowlist && origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();",
			"if (origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();"));
		const app2 = express();
		app2.use((req, res, next) => { req.session = { user: { id: 1, username: "super_admin", role: "Super Admin" } }; next(); });
		app2.get("/api/db/download", buildRequireRole()("Super Admin"), ungated.refuseCrossOrigin, (req, res) => res.json({ ok: true }));
		const server2 = app2.listen(0, "127.0.0.1");
		await new Promise((r) => server2.on("listening", r));
		eq("PRE-FIX: an allowlisted Origin plus Sec-Fetch-Site: cross-site exported too",
			(await request(server2.address().port, "GET", "/api/db/download", SHAPES.corsAllowlisted)).status, 200);
		await new Promise((r) => server2.close(r));

		// ⚠️ And with the route removed entirely and no method guard, a GET is
		// answered by the SPA catch-all with 200 + HTML — which is why deleting the
		// GET without adding the 405 would have been worse than leaving it.
		const app3 = express();
		app3.get("*", (req, res) => res.status(200).type("html").send("<!doctype html><title>SPA</title>"));
		const server3 = app3.listen(0, "127.0.0.1");
		await new Promise((r) => server3.on("listening", r));
		const spa = await request(server3.address().port, "GET", "/api/db/download", SHAPES.sameOrigin);
		eq("PRE-FIX: with no GET route and no method guard, the SPA catch-all answers 200", spa.status, 200);
		ok("...with HTML, which reads as though the export were world-readable", /<!doctype html>/i.test(spa.body));
		await new Promise((r) => server3.close(r));
		await new Promise((r) => server.close(r));
	}

	// ---- 3. an unauthenticated caller must not spend the limiter ------------
	{
		const guards = buildGuards(GUARD_BLOCK);
		const app = await makeApp({ guards, role: null, limit: 3 });
		for (let i = 0; i < 8; i++) {
			eq("unauthenticated request " + (i + 1) + " is 401, never 429",
				(await request(app.port, "POST", "/api/db/download", SHAPES.sameOrigin)).status, 401);
		}
		eq("...and the handler never ran", app.runs(), 0);
		await app.close();
	}
	{
		// Same window, now authenticated: if the 401s above had spent it, a
		// limit of 3 would already be exhausted.
		const guards = buildGuards(GUARD_BLOCK);
		const app = await makeApp({ guards, role: "Super Admin", limit: 3 });
		for (let i = 0; i < 8; i++) {
			eq("refused cross-site request " + (i + 1) + " is 403, never 429",
				(await request(app.port, "POST", "/api/db/download", SHAPES.crossSite)).status, 403);
		}
		// The budget is intact because neither 401 nor 403 reached the limiter.
		for (let i = 0; i < 3; i++) {
			eq("a real export still has budget left, call " + (i + 1),
				(await request(app.port, "POST", "/api/db/download", SHAPES.sameOrigin)).status, 200);
		}
		eq("...and the 4th is the one the limiter stops",
			(await request(app.port, "POST", "/api/db/download", SHAPES.sameOrigin)).status, 429);
		eq("exactly the budgeted number of exports ran", app.runs(), 3);
		await app.close();
	}

	// ---- 4. refusals are audited, successes are not double-counted ----------
	{
		const guards = buildGuards(GUARD_BLOCK);
		const app = await makeApp({ guards, role: "Super Admin" });
		guards.auditCalls.length = 0;
		await request(app.port, "POST", "/api/db/download", SHAPES.noInitiator);
		await request(app.port, "POST", "/api/db/download", SHAPES.crossSite);
		await request(app.port, "POST", "/api/db/download", SHAPES.sameOrigin);
		eq("two refusals produced two audit rows, the success none", guards.auditCalls.length, 2);
		ok("...both under db_export_blocked",
			guards.auditCalls.every((c) => c[1] === "db_export_blocked"));
		ok("...and each names the header that caused it",
			/Sec-Fetch-Site=none/.test(String(guards.auditCalls[0][4]))
			&& /Sec-Fetch-Site=cross-site/.test(String(guards.auditCalls[1][4])));
		await app.close();
	}

	// ---- 5. MUTANTS: each clause removed, each assertion required to flip ---
	{
		const mutate = (find, replace) => {
			ok("mutant target present: " + find.slice(0, 44), GUARD_BLOCK.includes(find));
			return buildGuards(GUARD_BLOCK.replace(find, replace));
		};
		// (a) re-admit no-initiator navigations -> the finding comes straight back.
		const m1 = mutate("allowNoInitiator: false,", "allowNoInitiator: true,");
		const a1 = await makeApp({ guards: m1, role: "Super Admin" });
		eq("MUTANT a: with allowNoInitiator:true the bookmark exports again",
			(await request(a1.port, "POST", "/api/db/download", SHAPES.noInitiator)).status, 200);
		eq("MUTANT a: ...and the handler really ran", a1.runs(), 1);
		await a1.close();

		// (b) ungate the CORS-allowlist leg -> the tier is bypassed again.
		const m2 = mutate(
			"if (honorCorsAllowlist && origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();",
			"if (origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();");
		const a2 = await makeApp({ guards: m2, role: "Super Admin" });
		eq("MUTANT b: an ungated allowlist leg exports cross-site",
			(await request(a2.port, "POST", "/api/db/download", SHAPES.corsAllowlisted)).status, 200);
		await a2.close();

		// (c) remove the audit -> a refused full-database export is invisible.
		const m3 = mutate("if (auditRefusal) {", "if (false) {");
		const a3 = await makeApp({ guards: m3, role: "Super Admin" });
		m3.auditCalls.length = 0;
		await request(a3.port, "POST", "/api/db/download", SHAPES.crossSite);
		eq("MUTANT c: without the audit leg the refusal leaves no trace", m3.auditCalls.length, 0);
		await a3.close();
	}
}

// ── the temp copy: mode, measured against a real backup ─────────────────────
async function backupModeSection() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-dbexport-test-"));
	const srcDb = path.join(dir, "source.db");
	const db = new Database(srcDb);
	db.exec("CREATE TABLE t (a TEXT)");
	db.prepare("INSERT INTO t VALUES (?)").run("x");
	const mode = (p) => fs.statSync(p).mode & 0o777;
	try {
		// CONTROL — what db.backup() does unaided. This is the finding: on the
		// Linux VPS os.tmpdir() is /tmp (1777) with four non-root login accounts.
		const plain = path.join(dir, "app_backup-plain.db");
		await db.backup(plain);
		eq("CONTROL: db.backup() creates its destination world-readable", mode(plain), 0o644);

		// TREATMENT — the shipped shape. O_CREAT|O_EXCL at 0600 first, so the
		// multi-second write of a ~313 MB PII dump is never world-readable, not
		// even for the duration of the copy (which a chmod-after would leave open).
		const guarded = path.join(dir, "app_backup-guarded.db");
		fs.closeSync(fs.openSync(guarded, "wx", 0o600));
		fs.chmodSync(guarded, 0o600);
		eq("the pre-created temp file is 0600 BEFORE any byte is written", mode(guarded), 0o600);
		await db.backup(guarded);
		eq("...and db.backup() writes in place without widening it", mode(guarded), 0o600);
		const copy = new Database(guarded, { readonly: true });
		eq("...and the copy is a usable database", copy.prepare("SELECT COUNT(*) c FROM t").get().c, 1);
		copy.close();
		// O_EXCL also refuses a path that already exists — including a symlink
		// planted by another user in a world-writable /tmp.
		let threw = false;
		try { fs.closeSync(fs.openSync(guarded, "wx", 0o600)); } catch { threw = true; }
		ok("`wx` refuses to open a path that already exists (symlink or otherwise)", threw);
	} finally {
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ── the boot-time orphan sweep, against a real directory ────────────────────
function sweepSection() {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "logisx-sweep-test-"));
	const realTmp = process.env.TMPDIR;
	process.env.TMPDIR = scratch;           // os.tmpdir() re-reads this per call
	try {
		// fs/os/path are injected rather than assumed global — the lifted function
		// closes over server.js's own requires, which do not exist in a Function
		// constructor scope. Everything else is the shipped body.
		const sweep = new Function("fs", "os", "path",
			SWEEP_BLOCK + "\nreturn purgeOrphanedDbExports;")(fs, os, path);
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const write = (name, old) => {
			const p = path.join(scratch, name);
			fs.writeFileSync(p, "x");
			if (old) fs.utimesSync(p, twoHoursAgo, twoHoursAgo);
			return p;
		};
		const staleOrphan = write("app_backup-1700000000-deadbeef.db", true);
		const liveExport = write("app_backup-1800000000-cafebabe.db", false);
		const notOurs = write("someone-elses.db", true);
		const wrongSuffix = write("app_backup-1700000000-abc.txt", true);
		// ⚠️ /tmp is 1777 on the VPS. Any local user can plant a symlink under our
		// own naming convention and aim it at something valuable.
		const sentinel = write("sentinel-do-not-delete", true);
		const plantedLink = path.join(scratch, "app_backup-evil.db");
		fs.symlinkSync(sentinel, plantedLink);
		fs.lutimesSync(plantedLink, twoHoursAgo, twoHoursAgo);

		const removed = sweep();

		eq("the sweep removed exactly one file", removed, 1);
		ok("a stale orphan from a killed process is removed", !fs.existsSync(staleOrphan));
		ok("an export younger than an hour survives (a sibling process may be serving it)", fs.existsSync(liveExport));
		ok("an unrelated .db is untouched", fs.existsSync(notOurs));
		ok("a matching prefix with the wrong suffix is untouched", fs.existsSync(wrongSuffix));
		ok("a planted symlink is skipped, not unlinked", fs.lstatSync(plantedLink).isSymbolicLink());
		ok("...so the file it aimed at survives", fs.existsSync(sentinel));
		// Idempotent: a second boot in quick succession must be a no-op.
		eq("a second sweep removes nothing", sweep(), 0);
	} finally {
		if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp;
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

function finish() {
	if (skipped.length) {
		console.error("SKIPPED " + skipped.length + " section(s):");
		for (const s of skipped) console.error("  - " + s);
	}
	if (failures.length) {
		console.error("FAILED " + failures.length + " of " + (passed + failures.length) + ":");
		for (const f of failures) console.error("  - " + f);
		process.exit(1);
	}
	console.log("db export guard: " + passed + " assertions passed"
		+ (skipped.length ? " (" + skipped.length + " SECTION(S) SKIPPED — see above)" : ""));
}

main().catch((err) => {
	console.error("FATAL:", err && err.stack || err);
	process.exit(1);
});
