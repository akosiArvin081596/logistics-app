#!/usr/bin/env node
/**
 * Tests the SAME-SITE CSRF control: requireAuth / requireRole refuse a
 * state-changing request that does not carry X-Requested-With.
 *
 * WHY IT EXISTS. crossSiteGuard's loosest tier, refuseCrossSite, tolerates
 * `Sec-Fetch-Site: same-site` BY DESIGN — so a page on a sibling logisx.com host
 * reached every guarded route with a live session. The cookie is host-only, so a
 * sibling cannot read connect.sid, but SameSite=Lax still ATTACHES it on
 * sibling→app, so blind writes survived. logisx.com is a Wix site whose account
 * credential exists nowhere in this repo, which is what makes that path credible
 * rather than theoretical.
 *
 * The properties, each a way this can silently stop working:
 *   §1 a session-gated WRITE without the header is refused
 *   §2 a READ is never refused — this must not break every GET in the app
 *   §3 the header satisfies it, for both guards
 *   §4 an unauthenticated caller still gets 401, not 403 — the header check must
 *      not leak "this route exists" ahead of the session check
 *   §5 the two COPIES of the check stay identical (they cannot share a helper)
 *   §6 the check is SELF-CONTAINED — no module-scope identifiers — or
 *      scripts/test-db-export-guard.js's `new Function` lift throws at call time
 *   §7 CSRF_HEADER_REQUIRED is a kill switch: default ON, only "false" disables
 *
 * Lifts both guards out of server.js the same way test-db-export-guard.js does,
 * so it exercises the code that ships rather than a copy.
 *
 * Run: node scripts/test-csrf-write-header.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const failures = [];
let pass = 0;
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };

function liftFn(head) {
	const a = SRC.indexOf(head);
	if (a < 0) throw new Error(`could not locate ${head}`);
	let d = 0, i = SRC.indexOf("{", a);
	for (let j = i; j < SRC.length; j++) {
		if (SRC[j] === "{") d++;
		else if (SRC[j] === "}" && --d === 0) return SRC.slice(a, j + 1);
	}
	throw new Error("unbalanced braces");
}
const REQUIRE_AUTH = liftFn("function requireAuth(req, res, next) {");
const REQUIRE_ROLE = liftFn("function requireRole(...roles) {");

// ⚠️ Bare `new Function` with NO injected identifiers — deliberately the same
// hostile environment test-db-export-guard.js uses. If the check ever reaches
// for a module-scope const, these throw and §6 fails.
const buildAuth = () => new Function(REQUIRE_AUTH + "\nreturn requireAuth;")();
const buildRole = () => new Function(REQUIRE_ROLE + "\nreturn requireRole;")();

function run(guard, { method = "POST", headers = {}, user = { role: "Super Admin" } } = {}) {
	const out = { status: null, body: null, nexted: false };
	const req = { method, headers, session: user ? { user } : {} };
	const res = {
		status(c) { out.status = c; return this; },
		json(b) { out.body = b; return this; },
	};
	guard(req, res, () => { out.nexted = true; });
	return out;
}

const NO_HDR = {};
const HDR = { "x-requested-with": "XMLHttpRequest" };

// ────────────────────────────────────────── §1 a write without it is refused
for (const [label, guard] of [["requireAuth", buildAuth()], ["requireRole", buildRole()("Super Admin")]]) {
	for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
		const r = run(guard, { method: m, headers: NO_HDR });
		ok(r.status === 403 && r.body && r.body.code === "CSRF_HEADER_REQUIRED",
			`§1 ${label}: a ${m} without X-Requested-With must be refused (got ${r.status})`);
		ok(!r.nexted, `§1 ${label}: a refused ${m} must not reach the handler`);
	}
}

// ────────────────────────────────────────── §2 reads are never refused
for (const [label, guard] of [["requireAuth", buildAuth()], ["requireRole", buildRole()("Super Admin")]]) {
	for (const m of ["GET", "HEAD", "OPTIONS"]) {
		const r = run(guard, { method: m, headers: NO_HDR });
		ok(r.nexted && r.status === null,
			`§2 ${label}: a ${m} must pass without the header — gating reads would break every page in the app`);
	}
}

// ────────────────────────────────────────── §3 the header satisfies it
for (const [label, guard] of [["requireAuth", buildAuth()], ["requireRole", buildRole()("Super Admin")]]) {
	const r = run(guard, { method: "POST", headers: HDR });
	ok(r.nexted, `§3 ${label}: a POST carrying the header must pass`);
}

// ────────────────────────────────────────── §4 401 still precedes 403
for (const [label, guard] of [["requireAuth", buildAuth()], ["requireRole", buildRole()("Super Admin")]]) {
	const r = run(guard, { method: "POST", headers: NO_HDR, user: null });
	ok(r.status === 401,
		`§4 ${label}: an unauthenticated write must still be 401, not a 403 that says the route exists (got ${r.status})`);
}
// …and a wrong ROLE must still be 403 Forbidden, not the CSRF code.
{
	const r = run(buildRole()("Super Admin"), { method: "POST", headers: NO_HDR, user: { role: "Driver" } });
	ok(r.status === 403 && r.body.error === "Forbidden",
		"§4 requireRole: a role refusal must not be relabelled as a CSRF refusal");
}

// ────────────────────────── §5 the two copies must not drift apart
{
	// They cannot share a helper (see §6), so a test is the only thing standing
	// between them and the hand-copied-rule drift this repo keeps paying for.
	// Whitespace-normalised: requireRole's copy is nested one level deeper inside
	// the returned arrow, so raw text always differs by a tab. Compare the LOGIC.
	// ⚠️ Compare the WHOLE refusal — condition AND the logging under it. This
	// used to stop at the first "CSRF_HEADER_REQUIRED", which sits inside the env
	// check, so the coalesced console.warn added afterwards was outside the
	// comparison and the two copies could have drifted apart unnoticed.
	const clause = (src) => {
		const i = src.indexOf('req.method !== "GET"');
		if (i < 0) return null;
		const end = src.indexOf('code: "CSRF_HEADER_REQUIRED" });', i);
		if (end < 0) return null;
		return src.slice(i, end).replace(/\s+/g, " ").trim();
	};
	const a = clause(REQUIRE_AUTH), b = clause(REQUIRE_ROLE);
	ok(a && b, "§5 both guards should carry the check");
	ok(a === b, "§5 DRIFT: the two copies of the CSRF check are no longer identical");
}

// ─────────── §5b A REFUSAL MUST BE OBSERVABLE, or "fine" and "blocking
//             everyone" are the same reading.
{
	// This was a real gap: for an hour in production a refusal wrote no log line
	// and no audit row, so grepping for refusals returned 0 in BOTH the healthy
	// case and the everyone-is-locked-out case. There were also no user writes in
	// that window, so nothing else disambiguated it either.
	const logs = [];
	const realWarn = console.warn;
	console.warn = (...a) => logs.push(a.join(" "));
	try {
		delete globalThis.__csrfRefusedLoggedAt;
		globalThis.__csrfRefusedCount = 0;
		run(buildAuth(), { method: "POST", headers: NO_HDR });
		ok(logs.length === 1, "§5b a refusal must leave a server-side trace");
		ok(/X-Requested-With/.test(logs[0] || ""), "§5b …that names the header, so the cause is readable without the source");
		// …but coalesced: a retrying client must not flood the log.
		for (let i = 0; i < 50; i++) run(buildAuth(), { method: "POST", headers: NO_HDR });
		ok(logs.length === 1, `§5b 51 refusals must coalesce to one line, not ${logs.length}`);
		ok(globalThis.__csrfRefusedCount === 51, "§5b …while still counting every one of them");
	} finally {
		console.warn = realWarn;
		delete globalThis.__csrfRefusedLoggedAt;
		delete globalThis.__csrfRefusedCount;
	}
}

// ────────────────────────── §6 self-contained (the lift must not throw)
{
	let threw = null;
	try { run(buildAuth(), { method: "POST", headers: HDR }); run(buildRole()("Super Admin"), { method: "POST", headers: HDR }); }
	catch (e) { threw = e; }
	ok(!threw,
		`§6 the check reaches for something outside the guard — test-db-export-guard.js's new Function lift will throw: ${threw && threw.message}`);
	// Only `req`, `res` and true globals are legal. process.env is a global, so
	// it is fine; a module-scope const is not.
	// globalThis and process.env are true globals and survive the lift; a bare
	// module-scope identifier does not. That is why the refusal counter lives on
	// globalThis rather than beside the other counters in server.js.
	ok(!/\bSAFE_METHODS\b|^\s*(const|let|var)\s/m.test(REQUIRE_AUTH + REQUIRE_ROLE),
		"§6 the check must not depend on a module-scope binding");
	ok(/globalThis\.__csrfRefused/.test(REQUIRE_AUTH) && /globalThis\.__csrfRefused/.test(REQUIRE_ROLE),
		"§6 the refusal counter must be on globalThis in BOTH guards, or the lift throws");
}

// ────────────────────────── §7 kill switch: default ON, only "false" disables
{
	const guard = buildAuth();
	const prev = process.env.CSRF_HEADER_REQUIRED;
	try {
		delete process.env.CSRF_HEADER_REQUIRED;
		ok(run(guard, { method: "POST", headers: NO_HDR }).status === 403,
			"§7 unset must mean ON — a security control that ships off is not shipped");
		process.env.CSRF_HEADER_REQUIRED = "true";
		ok(run(guard, { method: "POST", headers: NO_HDR }).status === 403, "§7 'true' keeps it on");
		process.env.CSRF_HEADER_REQUIRED = "yes";
		ok(run(guard, { method: "POST", headers: NO_HDR }).status === 403,
			"§7 only an explicit 'false' disables it — anything else must fail CLOSED");
		process.env.CSRF_HEADER_REQUIRED = "false";
		ok(run(guard, { method: "POST", headers: NO_HDR }).nexted,
			"§7 'false' must disable it, for the legacy public/ fallback");
		process.env.CSRF_HEADER_REQUIRED = "FALSE";
		ok(run(guard, { method: "POST", headers: NO_HDR }).nexted, "§7 the switch is case-insensitive");
	} finally {
		if (prev === undefined) delete process.env.CSRF_HEADER_REQUIRED;
		else process.env.CSRF_HEADER_REQUIRED = prev;
	}
}

console.log(`\n${"=".repeat(64)}`);
if (failures.length) {
	console.log(`FAILURES (${failures.length}):`);
	failures.forEach((f) => console.log(`  ✗ ${f}`));
	console.log(`\n${pass} passed, ${failures.length} failed`);
	process.exit(1);
}
console.log(`✓ ${pass} assertions passed`);
