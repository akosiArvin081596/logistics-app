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
const mountCount = (name) => src.split("\n").filter((l) => /^app\.(get|post|put|delete|patch)\(/.test(l) && l.includes(name + ",")).length;
eq("refuseCrossOrigin mount count", mountCount("refuseCrossOrigin"), 4);
eq("refuseCrossSite mount count (fuel-gallons GET + apply)", mountCount("refuseCrossSite"), 2);

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

if (failures.length) {
	console.error("FAILED " + failures.length + " of " + (passed + failures.length) + ":");
	for (const f of failures) console.error("  - " + f);
	process.exit(1);
}
console.log("csrf guard: " + passed + " assertions passed");
