#!/usr/bin/env node
/**
 * scripts/test-csrf-guard.js — the cross-site guard, tested AS SHIPPED.
 *
 * The middleware source is LIFTED OUT OF server.js and executed, rather than
 * reimplemented here — same discipline as scripts/test-date-resolvers.js. A
 * copy of the logic would keep passing after someone edited the real one.
 *
 * Three things are pinned:
 *   1. the DECISION for every caller shape that reaches these routes;
 *   2. the MOUNTS — which routes carry which guard, counted, so a fifth money
 *      route added without one fails the suite loudly;
 *   3. SELF-DISCRIMINATION — each protective clause is deleted in a mutant
 *      build and the corresponding assertion is required to flip. A guard test
 *      that still passes against a defanged guard is worse than none.
 *
 * Run: node scripts/test-csrf-guard.js
 */
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..", "server.js");
const src = fs.readFileSync(SERVER, "utf8");
let passed = 0;
const failures = [];
function ok(name, cond) {
	if (cond) passed++;
	else failures.push(name);
}
function eq(name, got, want) {
	if (got === want) passed++;
	else failures.push(name + " (got " + JSON.stringify(got) + ", want " + JSON.stringify(want) + ")");
}

// ── lift the shipped middleware ─────────────────────────────────────────────
const START = "function originIsSelf(req, origin) {";
const END = "const refuseCrossOrigin = crossSiteGuard(\"same-origin\");";
const i0 = src.indexOf(START);
const j0 = src.indexOf(END);
ok("guard block located in server.js", i0 > 0 && j0 > i0);
if (i0 < 0 || j0 < i0) {
	console.error("FATAL: could not find the guard block in server.js");
	process.exit(1);
}
const BLOCK = src.slice(i0, j0 + END.length);

// The allowlist is injected rather than read from env so the test does not
// depend on a .env, and so the allowlist LEG can be exercised deliberately.
const ALLOWLIST = ["https://localhost:3002", "https://192.168.8.106:3002"];
function build(block) {
	const f = new Function(
		"DRIVER_MOBILE_ORIGINS",
		block + "\nreturn { refuseCrossSite, refuseCrossOrigin, originIsSelf };"
	);
	return f(ALLOWLIST);
}
const G = build(BLOCK);

// Minimal Express-shaped stubs. `get` is case-insensitive like req.get().
const SELF_HOST = "app.logisx.com";
function run(guard, headers, host) {
	const h = {};
	const hostHeader = host === undefined ? SELF_HOST : host;
	if (hostHeader) h.host = hostHeader;
	for (const k of Object.keys(headers || {})) h[k.toLowerCase()] = headers[k];
	const req = { get: (n) => h[String(n).toLowerCase()], hostname: String(hostHeader || "").split(":")[0] };
	const out = { next: false, status: 0, body: null };
	const res = {
		status(c) { out.status = c; return res; },
		json(b) { out.body = b; return res; },
	};
	guard(req, res, () => { out.next = true; });
	return out;
}
const allows = (guard, headers, host) => run(guard, headers, host).next === true;

// ── 1. caller shapes ────────────────────────────────────────────────────────
// The attack: an auto-submitting form on any page the victim opens. A form can
// only send GET or POST and only three content types, but it needs neither
// CORS nor a preflight, and it CAN post fields.
const CROSS_FORM = { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
const CROSS_NULL_ORIGIN = { Origin: "null", "Sec-Fetch-Site": "cross-site" };
const OLD_SAFARI_CROSS = { Origin: "https://evil.example" };
const OLD_SAFARI_NULL = { Origin: "null" };
const OLD_SAFARI_SELF = { Origin: "https://" + SELF_HOST };
const SPA_SAME_ORIGIN = { Origin: "https://" + SELF_HOST, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" };
const SIBLING_SUBDOMAIN = { Origin: "https://drivers.logisx.com", "Sec-Fetch-Site": "same-site" };
const ADDRESS_BAR = { "Sec-Fetch-Site": "none" };
const HEADERLESS = {};
const DRIVER_MOBILE = { Origin: "https://localhost:3002", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" };

for (const [label, guard] of [["cost", G.refuseCrossSite], ["money", G.refuseCrossOrigin]]) {
	// Refused by BOTH guards — this is the finding.
	ok(label + ": cross-site form refused", allows(guard, CROSS_FORM) === false);
	ok(label + ": sandboxed-iframe form (Origin null) refused", allows(guard, CROSS_NULL_ORIGIN) === false);
	// The Sec-Fetch-less era. Without the Origin leg all three of these pass.
	ok(label + ": pre-Sec-Fetch cross-origin refused", allows(guard, OLD_SAFARI_CROSS) === false);
	ok(label + ": pre-Sec-Fetch Origin null refused", allows(guard, OLD_SAFARI_NULL) === false);
	ok(label + ": pre-Sec-Fetch SAME-origin allowed", allows(guard, OLD_SAFARI_SELF));
	// Legitimate callers. Breaking any of these is worse than the bug.
	ok(label + ": same-origin SPA allowed", allows(guard, SPA_SAME_ORIGIN));
	ok(label + ": address-bar navigation (none) allowed", allows(guard, ADDRESS_BAR));
	ok(label + ": header-less server-to-server allowed", allows(guard, HEADERLESS));
	ok(label + ": CORS-allowlisted driver-mobile allowed", allows(guard, DRIVER_MOBILE));
	// An unrecognized Sec-Fetch-Site value fails CLOSED. Browsers send lowercase;
	// anything else is either a new value or a liar, and neither earns a pass.
	ok(label + ": unknown Sec-Fetch-Site value refused", allows(guard, { "Sec-Fetch-Site": "SAME-ORIGIN" }) === false);
	ok(label + ": empty Sec-Fetch-Site falls through to Origin", allows(guard, { "Sec-Fetch-Site": "", Origin: "https://evil.example" }) === false);
}

// The one deliberate difference between the two guards.
ok("cost guard TOLERATES a sibling subdomain (same-site)", allows(G.refuseCrossSite, SIBLING_SUBDOMAIN));
ok("money guard REFUSES a sibling subdomain (same-site)", allows(G.refuseCrossOrigin, SIBLING_SUBDOMAIN) === false);

// Refusal shape — the client and the ops log both key on this.
const refused = run(G.refuseCrossOrigin, CROSS_FORM);
eq("refusal status", refused.status, 403);
eq("refusal code", refused.body && refused.body.code, "CROSS_SITE_REFUSED");

// Proxy tolerance: Origin carries a port the Host header does not, or vice
// versa. This must NOT 403 — see the host-only note beside originIsSelf.
ok("port mismatch still same-origin", allows(G.refuseCrossOrigin, { Origin: "https://" + SELF_HOST + ":8443" }, SELF_HOST));
ok("scheme downgrade still same-origin (host-only compare)", allows(G.refuseCrossOrigin, { Origin: "http://" + SELF_HOST }, SELF_HOST));
ok("a DIFFERENT host is never self", allows(G.refuseCrossOrigin, { Origin: "https://app.logisx.com.evil.example" }, SELF_HOST) === false);

// ── 2. mounts ───────────────────────────────────────────────────────────────
// Counted, not merely present: the failure mode this guards against is a fifth
// money route being added later WITHOUT the middleware, which no behavioural
// assertion above can see.
const MONEY_ROUTES = [
	"/api/periods/:period/finalize",
	"/api/periods/:period/reopen",
	"/api/investor/payouts/:id/status",
	"/api/investor/payouts/:id/adjust",
];
for (const r of MONEY_ROUTES) {
	const line = src.split("\n").find((l) => l.includes("\"" + r + "\"") && /^app\.(post|put|delete|patch)\(/.test(l));
	ok("route registered: " + r, Boolean(line));
	ok("refuseCrossOrigin mounted on " + r, Boolean(line) && line.includes("refuseCrossOrigin"));
	// requireRole first, matching the convention on the fuel-gallons verbs: an
	// unauthenticated caller should never reach anything further down the chain.
	ok("requireRole precedes the guard on " + r,
		Boolean(line) && line.indexOf("requireRole") < line.indexOf("refuseCrossOrigin"));
}
// The ratecon-reconcile pair. NOT a money route — it is the one route in #253's
// table that tightening the session cookie to SameSite=Lax could not cover,
// because lax still carries the cookie on a top-level cross-site GET NAVIGATION
// and this route inserted an alert row and sent mail on a GET. Split into a
// structurally read-only GET and a POST .../run, both guarded. Asserted here so
// neither half can quietly lose the guard, and so the GET cannot silently regain
// the ability to alert.
const RECONCILE_ROUTES = [
	["get", "/api/admin/ratecon-reconcile"],
	["post", "/api/admin/ratecon-reconcile/run"],
];
for (const [verb, r] of RECONCILE_ROUTES) {
	// The quotes in the match are what keep "/…/ratecon-reconcile" from also
	// matching the "/…/ratecon-reconcile/run" line.
	const line = src.split("\n").find((l) => l.includes('"' + r + '"') && l.startsWith("app." + verb + "("));
	ok("route registered: " + verb.toUpperCase() + " " + r, Boolean(line));
	ok("refuseCrossOrigin mounted on " + r, Boolean(line) && line.includes("refuseCrossOrigin"));
	ok("requireRole precedes the guard on " + r,
		Boolean(line) && line.indexOf("requireRole") < line.indexOf("refuseCrossOrigin"));
}
// The GET must pass alert=false and the POST alert=true. This is the assertion
// that stops the write half creeping back onto the safe verb — the exact shape
// the route had before (a ?dryRun query parameter choosing the side effect).
const getReconcile = src.split("\n").find((l) => l.includes('"/api/admin/ratecon-reconcile"') && l.startsWith("app.get("));
const postReconcile = src.split("\n").find((l) => l.includes('"/api/admin/ratecon-reconcile/run"') && l.startsWith("app.post("));
const nextLineAfter = (needle) => { const a = src.split("\n"); const i = a.findIndex((l) => l === needle); return i < 0 ? "" : a[i + 1]; };
ok("GET ratecon-reconcile is structurally read-only (alert hardcoded false)",
	/rateConReconcileHttp\(req, res, false\)/.test(String(getReconcile) + nextLineAfter(getReconcile)));
ok("POST ratecon-reconcile/run is the alerting verb (alert true)",
	/rateConReconcileHttp\(req, res, true\)/.test(String(postReconcile) + nextLineAfter(postReconcile)));
ok("no query parameter reaches the alert decision",
	!/reconcileRateCons\(\{\s*alert:\s*!?dryRun/.test(src));

const mountCount = (name) => src.split("\n").filter((l) => /^app\.(get|post|put|delete|patch)\(/.test(l) && l.includes(name + ",")).length;
eq("refuseCrossOrigin mount count", mountCount("refuseCrossOrigin"), 6);
// ⚠️ Assert the ROUTES, not just a count. A bare count goes stale the moment a
// new guarded route lands — this pin said 2 and broke when #250 correctly added
// the onboarding-evidence GET, which reads signer IP/user-agent and is exactly
// the kind of admin GET that should carry it. Naming them says WHICH is missing.
const mountedOn = (name) => src.split("\n")
	.filter((l) => /^app\.(get|post|put|delete|patch)\(/.test(l) && l.includes(name + ","))
	.map((l) => (l.match(/"([^"]+)"/) || [, "?"])[1]).sort();
eq("refuseCrossSite is on exactly the cost/exposure GETs", mountedOn("refuseCrossSite").join(" "),
	["/api/admin/fuel-gallons-recovery", "/api/admin/fuel-gallons-recovery/apply",
	 "/api/admin/onboarding-evidence/:scope/:ownerId"].sort().join(" "));

// ⚠️ The non-browser integrations must stay untouched. They present no
// Sec-Fetch-* and no Origin, so the guard would let them through anyway — but
// mounting it there at all would be a standing invitation to "tighten" it later
// into something that requires a header, which is the one change that breaks
// every server-to-server caller at once.
const WEBHOOKS = ["/api/eld/linxup/webhook", "/api/n8n/job", "/api/webhook/new-load", "/api/n8n/extract-pdf-via-gemini"];
for (const w of WEBHOOKS) {
	const line = src.split("\n").find((l) => l.includes("\"" + w + "\"") && /^app\.(post|put)\(/.test(l));
	ok("webhook still registered: " + w, Boolean(line));
	ok("no cross-site guard on " + w, Boolean(line) && !/refuseCross/.test(line));
}

// ── 3. self-discrimination against real mutant builds ───────────────────────
// Each clause is deleted from the LIFTED source and the assertion it exists for
// is required to flip. If a mutant still passes, the assertion above is
// decorative and this file is lying about coverage.
function mutate(find, replace) {
	ok("mutant target present: " + find.slice(0, 40), BLOCK.includes(find));
	return build(BLOCK.replace(find, replace));
}

// (a) drop the Origin fallback -> the pre-Sec-Fetch attack comes back.
const noOriginLeg = mutate("if (origin && !originIsSelf(req, origin)) return refuse(res);", "");
ok("MUTANT a: without the Origin leg, pre-Sec-Fetch CSRF succeeds", allows(noOriginLeg.refuseCrossOrigin, OLD_SAFARI_CROSS));
ok("MUTANT a: without the Origin leg, Origin null succeeds", allows(noOriginLeg.refuseCrossOrigin, OLD_SAFARI_NULL));

// (b) treat an unparseable Origin as ours -> Origin: null walks in.
const nullIsSelf = mutate("catch { return false; }", "catch { return true; }");
ok("MUTANT b: fail-open URL parse admits Origin null", allows(nullIsSelf.refuseCrossOrigin, OLD_SAFARI_NULL));

// (c) drop the allowlist leg -> the one real cross-origin client breaks. This
//     is the mutant that proves the allowlist line is load-bearing and not
//     tidy-up-able, i.e. it protects a LEGITIMATE caller, not an attacker.
const noAllowlist = mutate("if (origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();", "");
ok("MUTANT c: without the allowlist, driver-mobile-view is refused", allows(noAllowlist.refuseCrossOrigin, DRIVER_MOBILE) === false);

// (d) the PRE-FIX guard: Sec-Fetch-Site only, tolerant of same-site, no Origin
//     leg and no allowlist. This is literally what shipped before, and it is
//     here so the diff cannot be quietly reverted without the suite noticing.
const legacy = (req, res, next) => {
	const site = req.get("Sec-Fetch-Site");
	if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
		return res.status(403).json({ error: "Cross-site request refused", code: "CROSS_SITE_REFUSED" });
	}
	next();
};
ok("MUTANT d: the pre-fix guard admits the pre-Sec-Fetch attack", allows(legacy, OLD_SAFARI_CROSS));
ok("MUTANT d: the pre-fix guard admits a sibling subdomain", allows(legacy, SIBLING_SUBDOMAIN));
ok("MUTANT d: the pre-fix guard still stops the modern form", allows(legacy, CROSS_FORM) === false);

// ── 4. the session cookie — the control that closes the CLASS ───────────────
// Everything above filters a request. This section pins the attribute that stops
// the browser attaching the cookie in the first place, which is the actual fix:
// SameSite went None -> Lax on 2026-08-09. Lifted from server.js by the same
// discipline as the guard block, so a reimplementation cannot drift from it.
const S_START = "function resolveSessionSameSite(raw, secure) {";
const S_END = "const SESSION_COOKIE_SAMESITE = resolveSessionSameSite(";
const s0 = src.indexOf(S_START);
const s1 = src.indexOf(S_END);
ok("sameSite resolver located in server.js", s0 > 0 && s1 > s0);
const SBLOCK = s0 > 0 && s1 > s0 ? src.slice(s0, s1) : "";
function buildSameSite(block) {
	// console.warn is stubbed: the resolver warns deliberately and loudly, and
	// that noise would otherwise drown the test output.
	const f = new Function("console", block + "\nreturn resolveSessionSameSite;");
	return f({ warn() {}, error() {}, log() {} });
}
const resolve = buildSameSite(SBLOCK);

// Default-safe. This is the whole point: unset must mean lax, never none.
eq("unset -> lax", resolve(undefined, true), "lax");
eq("empty string -> lax", resolve("", true), "lax");
eq("whitespace -> lax", resolve("   ", true), "lax");
// Explicit values, case- and whitespace-insensitive.
eq("lax -> lax", resolve("lax", true), "lax");
eq("LAX (case) -> lax", resolve("LAX", true), "lax");
eq(" None  (case+space), secure -> none", resolve("  None  ", true), "none");
eq("strict -> strict", resolve("strict", true), "strict");
// Garbage must fall back safe, not throw and not pass through.
eq("garbage -> lax", resolve("banana", true), "lax");
eq("injection-ish -> lax", resolve("none; Secure", true), "lax");
eq("null -> lax", resolve(null, true), "lax");
// ⚠️ none REQUIRES secure. Browsers reject SameSite=None without Secure, so
// honoring it on an insecure cookie drops the cookie entirely — "logged out on
// every request", the exact total outage the override exists to back out of.
eq("none WITHOUT secure -> lax (browsers reject None sans Secure)", resolve("none", false), "lax");
eq("none WITH secure -> none", resolve("none", true), "none");
eq("lax without secure stays lax", resolve("lax", false), "lax");

// The shipped cookie must actually USE the resolver — a resolver nothing reads
// is decorative, and this is the assertion that catches a revert to a literal.
ok("session cookie reads the resolved value", /sameSite:\s*SESSION_COOKIE_SAMESITE,/.test(src));
// Comments are excluded deliberately: both this file and server.js record what
// the values USED to be, and a naive whole-file regex reads that history as a
// regression. Judge the code, not the prose about the code.
const codeLines = src.split("\n").filter((l) => !l.trim().startsWith("//"));
ok("no hardcoded sameSite literal remains on the cookie",
	!codeLines.some((l) => /sameSite:\s*["'](none|strict)["']/.test(l)));
ok("secure flag still production-gated", /const SESSION_COOKIE_SECURE = process\.env\.NODE_ENV === "production";/.test(src));
ok("cookie is still httpOnly", /httpOnly:\s*true,/.test(src));
// The CORS allowlist must default EMPTY. Its old default shipped two dev origins
// to production, and that list is crossSiteGuard's first leg — i.e. a standing
// bypass of the money guards, not merely a stale CORS header.
ok("DRIVER_MOBILE_ORIGINS defaults to empty",
	/const DRIVER_MOBILE_ORIGINS = \(process\.env\.DRIVER_MOBILE_ORIGINS \|\| ""\)/.test(src));
ok("no hardcoded dev origin default remains",
	!codeLines.some((l) => l.includes("https://localhost:3002,https://192.168.8.106:3002")));

// self-discrimination: real mutants of the resolver must flip these.
function mutateSameSite(find, replace) {
	ok("sameSite mutant target present: " + find.slice(0, 34), SBLOCK.includes(find));
	return buildSameSite(SBLOCK.replace(find, replace));
}
// (e) default open -> unset silently republishes the whole CSRF class.
const defaultNone = mutateSameSite('if (!want) return "lax";', 'if (!want) return "none";');
eq("MUTANT e: a default-open resolver returns none when unset", defaultNone(undefined, true), "none");
// (f) drop the Secure coupling -> None is emitted on an insecure cookie, which
//     browsers discard: everyone is logged out on every request.
const noSecureGate = mutateSameSite("if (want === \"none\" && !secure) {", "if (false) {");
eq("MUTANT f: without the Secure gate, none survives on an insecure cookie", noSecureGate("none", false), "none");
// (g) drop the allowlist validation -> arbitrary attacker-ish strings pass into
//     a Set-Cookie attribute.
const noValidation = mutateSameSite('if (!["lax", "strict", "none"].includes(want)) {', "if (false) {");
eq("MUTANT g: without validation, garbage reaches the cookie", noValidation("banana", true), "banana");

if (failures.length) {
	console.error("FAILED " + failures.length + " of " + (passed + failures.length) + ":");
	for (const f of failures) console.error("  - " + f);
	process.exit(1);
}
console.log("csrf guard: " + passed + " assertions passed");
