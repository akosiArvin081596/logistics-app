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
// The block now ends at the THIRD tier. Sliced to the terminating semicolon
// rather than to a literal, because that construction spans several lines and
// pinning its exact text here would make a formatting change a FATAL.
const END = "const refuseCrossOriginStrict = crossSiteGuard(";
const i0 = src.indexOf(START);
// Searched FROM i0, not from 0: the comment above originIsSelf names both
// markers in prose so a future reader knows not to rename them, and a bare
// indexOf finds that mention first and slices backwards into nothing.
const j0 = src.indexOf(END, i0);
ok("guard block located in server.js", i0 > 0 && j0 > i0);
if (i0 < 0 || j0 < i0) {
	console.error("FATAL: could not find the guard block in server.js");
	process.exit(1);
}
const BLOCK = src.slice(i0, src.indexOf(";", j0) + 1);

// The allowlist is injected rather than read from env so the test does not
// depend on a .env, and so the allowlist LEG can be exercised deliberately.
const ALLOWLIST = ["https://localhost:3002", "https://192.168.8.106:3002"];
// logAuditRefusal is injected too, and CAPTURED: the export tier writes an
// audit_trail row on every refusal, and "it is audited" is an assertion, not a
// side effect to be swallowed. `crossSiteGuard` itself is returned so the test
// can build tiers the server does not ship — which is the only honest way to
// prove that an OPTION, rather than the surrounding code, is doing the work.
function build(block) {
	const auditCalls = [];
	const f = new Function(
		"DRIVER_MOBILE_ORIGINS", "logAuditRefusal",
		block + "\nreturn { refuseCrossSite, refuseCrossOrigin, refuseCrossOriginStrict, crossSiteGuard, originIsSelf };"
	);
	const built = f(ALLOWLIST, (...args) => auditCalls.push(args));
	built.auditCalls = auditCalls;
	return built;
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
	// ⚠️ FLIPPED 2026-08-09. The CORS-allowlist leg runs BEFORE the Sec-Fetch-Site
	// leg, so `Origin: <allowlisted>` + `Sec-Fetch-Site: cross-site` was waved
	// straight past the tier — a complete bypass of the money guard, and on the
	// database export the backup ran. Every shipped tier now passes
	// honorCorsAllowlist:false. The FACTORY still supports the escape; that it is
	// the option and not the surrounding code doing the work is proven below.
	ok(label + ": CORS-allowlisted driver-mobile is NO LONGER waved past the tier",
		allows(guard, DRIVER_MOBILE) === false);
	// An unrecognized Sec-Fetch-Site value fails CLOSED. Browsers send lowercase;
	// anything else is either a new value or a liar, and neither earns a pass.
	ok(label + ": unknown Sec-Fetch-Site value refused", allows(guard, { "Sec-Fetch-Site": "SAME-ORIGIN" }) === false);
	ok(label + ": empty Sec-Fetch-Site falls through to Origin", allows(guard, { "Sec-Fetch-Site": "", Origin: "https://evil.example" }) === false);
}

// The one deliberate difference between the two guards.
ok("cost guard TOLERATES a sibling subdomain (same-site)", allows(G.refuseCrossSite, SIBLING_SUBDOMAIN));
ok("money guard REFUSES a sibling subdomain (same-site)", allows(G.refuseCrossOrigin, SIBLING_SUBDOMAIN) === false);

// ── 1b. the EXPORT tier — same-origin, and no "no initiator" ────────────────
// `Sec-Fetch-Site: none` is not "no header". It is a browser stating the
// navigation had no initiator document: a bookmark, an address-bar paste, or a
// link opened from Slack desktop / Outlook / Apple Mail / Teams. SameSite=Lax
// attaches the cookie to all of them. On a GET that made `none` both the attack
// shape and the only legitimate browser shape, which is why POST /api/db/download
// is a POST — and why refusing `none` there costs nothing.
ok("export tier: address-bar / bookmark / native-app link (none) REFUSED",
	allows(G.refuseCrossOriginStrict, ADDRESS_BAR) === false);
ok("export tier: cross-site form refused", allows(G.refuseCrossOriginStrict, CROSS_FORM) === false);
ok("export tier: sibling subdomain (same-site) refused", allows(G.refuseCrossOriginStrict, SIBLING_SUBDOMAIN) === false);
ok("export tier: CORS-allowlisted driver-mobile refused", allows(G.refuseCrossOriginStrict, DRIVER_MOBILE) === false);
ok("export tier: same-origin SPA still allowed", allows(G.refuseCrossOriginStrict, SPA_SAME_ORIGIN));
// ⚠️ THE ONE THAT MUST NOT BREAK. curl / test-suite.js / a cron job send NO
// Sec-Fetch-* at all, which is a different signal from `none` and stays allowed.
// Refusing it would break the route's actual documented caller.
ok("export tier: header-less curl / scripted caller STILL allowed",
	allows(G.refuseCrossOriginStrict, HEADERLESS));
ok("export tier: pre-Sec-Fetch cross-origin (old Safari) refused",
	allows(G.refuseCrossOriginStrict, OLD_SAFARI_CROSS) === false);
ok("export tier: pre-Sec-Fetch SAME-origin allowed", allows(G.refuseCrossOriginStrict, OLD_SAFARI_SELF));

// ── 1c. the refusal is AUDITED, and only on the tier that asked for it ──────
// super_admin is a SHARED login and audit_trail is the only who/when/from-where
// record in the system, so a refused cross-site attempt on the full-database
// export is close to the highest-signal row it can hold. It went unrecorded
// entirely before this: logAudit sits inside the handler, which a 403 never
// reaches.
G.auditCalls.length = 0;
run(G.refuseCrossOriginStrict, CROSS_FORM);
eq("export refusal writes exactly one audit row", G.auditCalls.length, 1);
eq("...under the db_export_blocked action", G.auditCalls[0] && G.auditCalls[0][1], "db_export_blocked");
eq("...against the database entity", G.auditCalls[0] && G.auditCalls[0][2], "database");
eq("...coalesced on the CROSS_SITE_REFUSED code", G.auditCalls[0] && G.auditCalls[0][5], "CROSS_SITE_REFUSED");
ok("...and the row records the header that caused it",
	/Sec-Fetch-Site=cross-site/.test(String(G.auditCalls[0] && G.auditCalls[0][4])));
ok("...and the offending Origin", /Origin=https:\/\/evil\.example/.test(String(G.auditCalls[0] && G.auditCalls[0][4])));
// A bookmark and a hostile page are different events and must not read alike.
G.auditCalls.length = 0;
run(G.refuseCrossOriginStrict, ADDRESS_BAR);
ok("a refused no-initiator navigation is recorded as `none`, not as cross-site",
	/Sec-Fetch-Site=none/.test(String(G.auditCalls[0] && G.auditCalls[0][4])));
ok("...and an absent Origin is recorded as absent, not as empty",
	/Origin=\(absent\)/.test(String(G.auditCalls[0] && G.auditCalls[0][4])));
// ⚠️ Attacker-supplied headers land in an EVIDENCE table. Bounded and printable.
G.auditCalls.length = 0;
run(G.refuseCrossOriginStrict, { Origin: "https://evil.example/" + "A".repeat(4000) + "\r\n\u0007INJECTED", "Sec-Fetch-Site": "cross-site" });
const auditedDetails = String(G.auditCalls[0] && G.auditCalls[0][4]);
ok("a 4 KB Origin is clipped, not stored whole", auditedDetails.length < 500);
ok("...and control characters cannot reach the audit row", !/[\x00-\x1F\x7F]/.test(auditedDetails));
ok("...while the clip is marked, so a reader knows it was truncated", /\.\.\./.test(auditedDetails));
// The other two tiers must stay silent — auditing every mount would bury this.
G.auditCalls.length = 0;
run(G.refuseCrossOrigin, CROSS_FORM);
run(G.refuseCrossSite, CROSS_FORM);
eq("the money and cost tiers deliberately write no audit row", G.auditCalls.length, 0);

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

// ⚠️ A LINE-ONLY SCAN IS BLIND TO A MULTILINE REGISTRATION, and that blindness
// is not hypothetical here — it hid a guard on the busiest route in the file.
// `app.post(\n\t[paths],\n\trequireRole(...),\n\trefuseCrossSite,\n\t...)` puts the
// guard on its own line, so `mountedOn`/`mountCount` — which used to filter
// single lines starting `app.<verb>(` — reported 3 mounts for refuseCrossSite
// when there were 6. Both draft-invoice and invoice-preview were invisible to
// the suite whose entire job is naming which route lost its guard.
//
// The joiner that fixes it was ALREADY in this file, 300 lines down, written for
// the boot-order check with a comment saying exactly this. It is hoisted here so
// both readers share one definition rather than drifting apart.
const ROUTE_HEAD_RE = /^app\.(get|post|put|delete|patch|use|all)\(/;
// [{ i, head }] — one entry per registration, continuation lines joined up to
// the handler, so a guard or a path on its own line is still seen.
function routeHeads(lines) {
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (!ROUTE_HEAD_RE.test(lines[i])) continue;
		let head = lines[i];
		for (let k = 1; k <= 10 && !/=>|function/.test(head); k++) {
			if (i + k >= lines.length) break;
			head += "\n" + lines[i + k];
		}
		out.push({ i, head });
	}
	return out;
}
const mountCount = (name) => routeHeads(src.split("\n")).filter(({ head }) => head.includes(name + ",")).length;
// ⚠️ Assert the ROUTES, not just a count. A bare count goes stale the moment a
// new guarded route lands — this pin said 2 and broke when #250 correctly added
// the onboarding-evidence GET, which reads signer IP/user-agent and is exactly
// the kind of admin GET that should carry it. Naming them says WHICH is missing.
//
// Every "/..." literal in the head is taken, not just the first: an aliased
// registration mounts an ARRAY of paths and each one is separately reachable, so
// each has to be pinned. Restricted to strings starting "/" so role arguments
// like "Super Admin" cannot be mistaken for routes.
const mountedOn = (name) => routeHeads(src.split("\n"))
	.filter(({ head }) => head.includes(name + ","))
	.flatMap(({ head }) => (head.match(/"(\/[^"]*)"/g) || []).map((q) => q.slice(1, -1)))
	.sort();
// ⚠️ NO LONGER "the cost/exposure GETs" — it is the COST tier, and it now holds
// writes. Four routes joined after this pin was written, and the suite could see
// only one of them: ratecon-index broke the list loudly (good), while
// draft-invoice, its alias and invoice-preview were mounted multiline and were
// silently invisible until routeHeads() landed above (bad — that is the mount
// the whole rate-con work turned on).
eq("refuseCrossSite is on exactly the cost tier", mountedOn("refuseCrossSite").join(" "),
	["/api/admin/fuel-gallons-recovery", "/api/admin/fuel-gallons-recovery/apply",
	 "/api/admin/onboarding-evidence/:scope/:ownerId", "/api/admin/ratecon-index",
	 // One registration, two paths — the legacy Bison alias is separately
	 // reachable, so it is separately pinned.
	 "/api/loads/:loadId/draft-invoice", "/api/loads/:loadId/draft-bison-invoice",
	 "/api/loads/:loadId/invoice-preview"].sort().join(" "));
// Six REGISTRATIONS carrying seven paths. Asserted beside the list for the same
// reason the other tiers are: a guard that reappears under a third name shows up
// as a list/count disagreement instead of silently.
eq("refuseCrossSite mount count agrees with that list", mountCount("refuseCrossSite"), 6);
// ⚠️ ALL SEVEN GUARDED ROUTES, NAMED, IN ONE PLACE — the review's finding 5.
// The count above was the only thing covering the database export, and a count
// cannot say WHICH route lost its guard. `mountCount` is kept beside the list so
// a route that gains a guard under some THIRD name (the exact thing that just
// happened) shows up as a list/count disagreement rather than silently.
//
// The export moved off refuseCrossOrigin onto refuseCrossOriginStrict, so this
// pin reads 6 + 1 rather than 7. That is not a route losing protection: strict
// IS the money tier plus two more clauses. Both halves are asserted.
// PUT /api/invoices/:id/adjust joined the list when the invoice period guard
// landed. It is the settlement write its payouts namesake already was — a signed
// correction of up to ±$10,000 onto a driver's weekly pay document — and the two
// routes were deliberately built as mirrors, so the guard asymmetry between them
// was an accident of which one shipped first, not a decision. Its only legitimate
// browser caller is the SPA this server serves, so same-origin costs nothing.
//
// ⚠️ PUT /api/invoices/:id/approve is NOT here, and that is a KNOWN GAP rather
// than a judgement that it is safe: its `paid` action is the one invoice verb
// asserting money left the bank, so on the money-tier reasoning it belongs. It
// was left out to keep the guard change to the route the period work was scoped
// to. If it is added, add it here in the same commit.
eq("refuseCrossOrigin is on exactly the settlement writes and the reconcile pair",
	mountedOn("refuseCrossOrigin").join(" "),
	["/api/periods/:period/finalize", "/api/periods/:period/reopen",
	 "/api/investor/payouts/:id/status", "/api/investor/payouts/:id/adjust",
	 "/api/invoices/:id/adjust",
	 "/api/admin/ratecon-reconcile", "/api/admin/ratecon-reconcile/run"].sort().join(" "));
eq("refuseCrossOrigin mount count agrees with that list", mountCount("refuseCrossOrigin"), 7);
eq("refuseCrossOriginStrict is on exactly the full-database export",
	mountedOn("refuseCrossOriginStrict").join(" "), "/api/db/download");
eq("...and on nothing else", mountCount("refuseCrossOriginStrict"), 1);

// ── 2b. the database export: the VERB is the control ────────────────────────
// Finding 1 of the PR #264 review. As a GET, `Sec-Fetch-Site: none` was allowed
// — and `none` is a bookmark, an address-bar paste, or a link opened from Slack
// desktop / Outlook / Apple Mail / Teams, all of which SameSite=Lax attaches the
// cookie to. Refusing `none` on a GET was not available either, because it was
// also the route's ONLY legitimate browser shape (there is no UI caller). Lax
// withholds the cookie from every cross-site POST, and no link can produce a
// POST, so the method closes the class and frees `none` to be refused.
const dbExportLine = src.split("\n").find((l) => l.startsWith("app.post(") && l.includes('"/api/db/download"'));
ok("the database export is a POST", Boolean(dbExportLine));
ok("...and no GET registration survives",
	!src.split("\n").some((l) => l.startsWith("app.get(") && l.includes('"/api/db/download"')));
ok("...carrying the strict tier", Boolean(dbExportLine) && dbExportLine.includes("refuseCrossOriginStrict"));
ok("...with requireRole first, so a 403 never spends dbAdminLimiter",
	Boolean(dbExportLine)
		&& dbExportLine.indexOf("requireRole") < dbExportLine.indexOf("refuseCrossOriginStrict")
		&& dbExportLine.indexOf("refuseCrossOriginStrict") < dbExportLine.indexOf("dbAdminLimiter"));
// ⚠️ Without an explicit method guard a stray GET falls through to the SPA
// catch-all at the bottom of server.js and is answered index.html + 200, which
// reads as though the export were world-readable. Same shape as the guard on
// POST /api/admin/routemate/sync-now.
ok("a GET is answered 405, not by the SPA catch-all",
	/app\.all\("\/api\/db\/download", \(req, res, next\) => \{\s*if \(req\.method === "POST"\) return next\(\);/.test(src));
ok("...and the 405 advertises Allow: POST", /res\.set\("Allow", "POST"\);/.test(src));
// The strict tier is constructed with all three tightenings, and the audit
// action is the one PURGEABLE_REFUSAL_ACTIONS deliberately omits (kept forever).
ok("strict tier declines the CORS-allowlist escape", /honorCorsAllowlist: false,/.test(src));
ok("strict tier refuses no-initiator navigations", /allowNoInitiator: false,/.test(src));
ok("strict tier audits its refusals as db_export_blocked",
	/auditRefusal: \{ action: "db_export_blocked", entity: "database", entityId: "app\.db" \}/.test(src));
ok("db_export_blocked is NOT purgeable — the attempt IS the evidence",
	!/^\t"db_export_blocked",$/m.test(src));
// Finding 4: the temp copy is a full unencrypted dump of every SSN and account
// number, and db.backup() creates it 0644. On the Linux VPS os.tmpdir() is /tmp
// (1777) with four non-root login accounts on the box.
ok("the temp export file is created 0600 BEFORE the backup writes into it",
	/fs\.closeSync\(fs\.openSync\(tmpPath, "wx", 0o600\)\);/.test(src));
ok("...and chmodded again after it, in case the inode was recreated",
	/db\.backup\(tmpPath\)\.then\(\(\) => \{\s*try \{ fs\.chmodSync\(tmpPath, 0o600\); \} catch \{\}/.test(src));
// Finding 4b: the res.download callback covers every request-lifecycle outcome
// (PR #264 measured it) but cannot cover process death, and `pm2 restart` is
// step 4 of the documented deploy.
ok("orphaned temp exports are swept at boot", /^purgeOrphanedDbExports\(\);$/m.test(src));
ok("...with an age floor, so a sibling process's live export survives",
	/const DB_EXPORT_TMP_MAX_AGE_MS = 60 \* 60 \* 1000;/.test(src));
ok("...and lstat+isFile, so a planted symlink in a world-writable /tmp is skipped",
	/const st = fs\.lstatSync\(p\);\s*\n\s*if \(!st\.isFile\(\)\) continue;/.test(src));

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
const noOriginLeg = mutate("if (origin && !originIsSelf(req, origin)) return refuse(req, res);", "");
ok("MUTANT a: without the Origin leg, pre-Sec-Fetch CSRF succeeds", allows(noOriginLeg.refuseCrossOrigin, OLD_SAFARI_CROSS));
ok("MUTANT a: without the Origin leg, Origin null succeeds", allows(noOriginLeg.refuseCrossOrigin, OLD_SAFARI_NULL));

// (b) treat an unparseable Origin as ours -> Origin: null walks in.
const nullIsSelf = mutate("catch { return false; }", "catch { return true; }");
ok("MUTANT b: fail-open URL parse admits Origin null", allows(nullIsSelf.refuseCrossOrigin, OLD_SAFARI_NULL));

// (c) ⚠️ REWRITTEN. This used to delete the allowlist leg and assert the
//     driver-mobile client broke — i.e. it proved the leg protected a
//     LEGITIMATE caller. That claim is now false at every shipped mount: the leg
//     ran BEFORE the Sec-Fetch-Site leg, so an allowlisted Origin carrying
//     `Sec-Fetch-Site: cross-site` bypassed the tier outright, and none of the
//     seven guarded routes has a cross-origin caller to protect (they are
//     Super-Admin settlement, diagnostic and PII-export routes; the allowlist
//     exists for a DRIVER app). Every tier now passes honorCorsAllowlist:false.
//
//     Deleting the leg from the source therefore changes NOTHING — which is
//     exactly the shape of a decorative assertion. The honest discriminator is
//     the option itself: build the same factory with the escape ON and require
//     the decision to flip. That proves the OPTION is doing the work, and it
//     keeps the capability tested for the day a cross-origin client returns.
const allowlistHonoured = G.crossSiteGuard("same-origin", { honorCorsAllowlist: true });
ok("MUTANT c control: with honorCorsAllowlist ON, driver-mobile is waved past the tier",
	allows(allowlistHonoured, DRIVER_MOBILE));
ok("MUTANT c: the SHIPPED tier refuses the same request", allows(G.refuseCrossOrigin, DRIVER_MOBILE) === false);
ok("MUTANT c: and honouring the allowlist really is a BYPASS, not a tolerance",
	allows(allowlistHonoured, { Origin: ALLOWLIST[0], "Sec-Fetch-Site": "cross-site" })
	&& allows(allowlistHonoured, { Origin: ALLOWLIST[0], "Sec-Fetch-Site": "same-site" }));
// The leg must still exist in source, and still be gated. Deleting the gate
// republishes the bypass on all seven routes at once.
ok("MUTANT c: the allowlist leg is present and gated on the option",
	BLOCK.includes("if (honorCorsAllowlist && origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();"));
const allowlistUngated = mutate(
	"if (honorCorsAllowlist && origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();",
	"if (origin && DRIVER_MOBILE_ORIGINS.includes(origin)) return next();");
ok("MUTANT c: ungating the leg puts the bypass back on the money tier",
	allows(allowlistUngated.refuseCrossOrigin, DRIVER_MOBILE));
ok("MUTANT c: ...and on the database export", allows(allowlistUngated.refuseCrossOriginStrict, DRIVER_MOBILE));

// (c2) allowNoInitiator — the finding-1 clause. Default ON, so the two tiers
//      that must stay address-bar-reachable are unchanged; OFF only on the
//      export, which has no browser caller left to break.
const noInitiatorAllowed = G.crossSiteGuard("same-origin", { honorCorsAllowlist: false });
ok("MUTANT c2 control: with allowNoInitiator defaulted ON, a bookmark is allowed",
	allows(noInitiatorAllowed, ADDRESS_BAR));
ok("MUTANT c2: the export tier refuses the identical request",
	allows(G.refuseCrossOriginStrict, ADDRESS_BAR) === false);
// Turning it back on in source is a one-word edit; this is the assertion that
// notices. It also proves the refusal is the OPTION and not the same-origin
// tier, since `none` is allowed by the same tier one line above.
const noInitiatorMutant = mutate("allowNoInitiator: false,", "allowNoInitiator: true,");
ok("MUTANT c2: flipping the option in source re-admits the bookmark/native-app link",
	allows(noInitiatorMutant.refuseCrossOriginStrict, ADDRESS_BAR));
// ⚠️ And it must NOT be implemented by demanding a Sec-Fetch-Site header, which
// would refuse curl and every scripted caller — the one break that would matter.
ok("MUTANT c2: refusing `none` did not also refuse header-less callers",
	allows(G.refuseCrossOriginStrict, HEADERLESS));

// (c3) the audit leg. Deleting it returns the route to the pre-fix state, where
//      a refused export of the entire database left no trace at all.
const noAudit = mutate("if (auditRefusal) {", "if (false) {");
noAudit.auditCalls.length = 0;
run(noAudit.refuseCrossOriginStrict, CROSS_FORM);
eq("MUTANT c3: without the audit leg a refused export is invisible", noAudit.auditCalls.length, 0);

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

// ── 5. BOOT ORDER — the one failure in this file that is a TOTAL OUTAGE ─────
// Every assertion above asks whether a guard DECIDES correctly. This section
// asks whether the process STARTS AT ALL.
//
// `refuseCrossSite` / `refuseCrossOrigin` are `const`, so they sit in the
// temporal dead zone until their own line executes. Mounting either on a route
// registered ABOVE those lines throws
//   ReferenceError: Cannot access 'refuseCrossOrigin' before initialization
// while server.js is still being evaluated — so it is not a 403, and not one
// broken route: the app does not boot. PR #254 relocated the block up beside
// requireRole precisely to escape this, and the 165-line comment above
// originIsSelf documents the crash — but nothing PINNED the position, and a
// comment is not a test. This section is that pin.
//
// ⚠️ `node --check server.js` — the repo's documented pre-commit step — CANNOT
// SEE THIS. TDZ is a runtime error, not a parse error; the mutants below pass
// `node --check` and die on boot. That gap is the whole reason this exists.
//
// ⚠️ The exposure is not hypothetical: 10 route registrations currently sit
// above the definitions (the three /api/n8n/* routes, the drivers-directory
// CRUD, and two profile-picture uploads). Every one is an ordinary admin route
// on which a guard reads like a sensible hardening, and every one is an instant
// outage. requireRole is safe there only because a `function` declaration
// hoists and a `const` does not — the asymmetry that caused the original crash.
const LINES = src.split("\n");
// String literals are stripped before any identifier match so that PROSE cannot
// trip these assertions. server.js legitimately names these guards in comments
// and in a console.warn ABOVE their definitions; judging the code means judging
// the code, the same call made for the sameSite literal scan above.
const stripLiterals = (s) => s.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, "``");
const isCommentLine = (l) => {
	const t = l.trim();
	return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

// First route registration naming each identifier in its middleware chain.
// Continuation lines are joined (up to the handler) because a multi-line
// `app.post(\n  path,\n  mw,\n  handler)` is already present in server.js, and a
// line-only scan would be blind to a guard mounted on its own line.
function routeMountIndex(lines) {
	const first = new Map();
	// Shares routeHeads() with mountedOn/mountCount above — this joining logic
	// used to live only here, which is why those two were blind to it.
	for (const { i, head } of routeHeads(lines)) {
		for (const raw of stripLiterals(head).match(/\b[A-Za-z_$][\w$]*\s*,/g) || []) {
			const n = raw.replace(/\s*,$/, "");
			if (!first.has(n)) first.set(n, i);
		}
	}
	return first;
}
// Module-scope `const`/`let`/`var` bindings — matched at column 0, which is what
// makes them TDZ-shaped AND reachable from a route registration.
function topLevelBindingIndex(lines) {
	const d = new Map();
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
		if (m && !d.has(m[2])) d.set(m[2], i);
	}
	return d;
}
// Any reference in CODE, wherever it appears — not just in a route chain.
const firstCodeRefIndex = (lines, name) => {
	const re = new RegExp("\\b" + name + "\\b");
	return lines.findIndex((l) => !isCommentLine(l) && re.test(stripLiterals(l)));
};

// ⚠️ ASSERTED GENERALLY, NOT FOR THE TWO GUARDS. The invariant is not "the CSRF
// guards are special" — it is "a `const` middleware must be defined above every
// route that mounts it", and server.js has 30 of them, every rate limiter
// included. The guards are merely the ones with room to get it wrong: a limiter
// is declared 1-6 lines above its own route, while refuseCrossOrigin is 6,106
// lines above its first mount, so the guards are where the gap is wide enough
// for a plausible edit to fall into it.
function bootOrderViolations(srcText) {
	const ls = srcText.split("\n");
	const mounts = routeMountIndex(ls);
	const decls = topLevelBindingIndex(ls);
	const out = [];
	for (const [name, mIdx] of mounts) {
		const dIdx = decls.get(name);
		// Skipped deliberately: hoisted `function` declarations (requireAuth,
		// generateInvoiceHandler), handler params, and imports. None can be in a
		// TDZ at registration time, so none can produce this crash.
		if (dIdx === undefined) continue;
		if (mIdx < dIdx) out.push(name + " (def line " + (dIdx + 1) + ", mounted line " + (mIdx + 1) + ")");
	}
	return out;
}

const tdzMiddlewares = [...routeMountIndex(LINES).keys()].filter((n) => topLevelBindingIndex(LINES).has(n));
// ⚠️ Guard against a VACUOUS PASS. "0 violations" is also what a scan that found
// nothing reports, so a regex that silently stopped matching would read as a
// clean bill of health forever. Pin the population, not just the verdict.
ok("boot-order scan actually found the const middlewares (>=20)", tdzMiddlewares.length >= 20);
eq("no const middleware is mounted above its own definition", bootOrderViolations(src).join(" | "), "");

for (const g of ["refuseCrossSite", "refuseCrossOrigin"]) {
	const defIdx = LINES.findIndex((l) => l.startsWith("const " + g + " = crossSiteGuard("));
	const mountIdx = routeMountIndex(LINES).get(g);
	ok(g + ": definition located", defIdx > -1);
	ok(g + ": at least one route mounts it", mountIdx !== undefined);
	// (1) the literal ask: first mount below the definition.
	ok(g + ": first mount is BELOW its definition", defIdx > -1 && mountIdx > defIdx);
	// (2) the stronger form — nothing above the block touches it at all, by any
	// route, array, wrapper or re-export. This is NOT redundant with (1): MUTANT
	// i below is a real TDZ crash that (1) cannot see, because the reference is
	// not on an `app.VERB(` line. Being defined-before-first-USE is the actual
	// language rule; "before first mount" is only the common case of it.
	ok(g + ": NO code above its definition references it", firstCodeRefIndex(LINES, g) === defIdx);
}

// ── 5b. self-discrimination — the assertions must FAIL on broken source ──────
// Mutation is in memory, never on disk: server.js is read by seven other agents
// and by every other suite, so a test that rewrites it to prove a point can
// leave the repo broken if it dies mid-run. Byte-integrity is therefore
// structural rather than restored-afterwards.
const MUT_MOUNT = 'app.get("/api/mutant", requireRole("Super Admin"), refuseCrossOrigin, (req, res) => {});';
const guardDefLine = LINES.findIndex((l) => l.startsWith('const refuseCrossOrigin = crossSiteGuard('));
const spliceAbove = (text) => {
	const ls = LINES.slice();
	ls.splice(guardDefLine - 40, 0, text);
	return ls;
};

// ⚠️ Judged as a CONTROL/TREATMENT pair on the violation NAMES, never on a
// count. Two traps live here, both hit while writing this: a hardcoded `0`
// misreports whenever the real assertion above is already failing — i.e.
// exactly when someone is reading this output to find out what broke — and a
// "+1" is wrong too, because violations are keyed per IDENTIFIER, so a second
// bad mount of a guard already flagged adds no new entry. Absent-then-present
// is the claim, and it holds whatever state the base source is in.
const violationNames = (text) => new Set(bootOrderViolations(text).map((v) => v.split(" ")[0]));
const baseNames = violationNames(src);

// (h) a guard mounted on a route above the definitions — the PR #254 crash.
const mutantRoute = spliceAbove(MUT_MOUNT);
const routeViolations = bootOrderViolations(mutantRoute.join("\n"));
ok("MUTANT h control: the SHIPPED source flags no guard", !baseNames.has("refuseCrossOrigin"));
ok("MUTANT h: mounting a guard above its definition IS flagged",
	violationNames(mutantRoute.join("\n")).has("refuseCrossOrigin"));
ok("MUTANT h: and the violation names the guard, its def line and its mount line",
	routeViolations.some((v) => /^refuseCrossOrigin \(def line \d+, mounted line \d+\)$/.test(v)));

// (i) the same crash reached through a plain array — invisible to assertion (1),
//     caught only by the stronger form. This is the mutant that earns (2).
const mutantArray = spliceAbove("const earlyChain = [requireAuth, refuseCrossOrigin];");
const arrayNames = violationNames(mutantArray.join("\n"));
ok("MUTANT i: an array reference adds NO route-mount violation (assertion 1 is blind)",
	arrayNames.size === baseNames.size && [...arrayNames].every((n) => baseNames.has(n)));
ok("MUTANT i: the stronger form catches it anyway",
	firstCodeRefIndex(mutantArray, "refuseCrossOrigin") < mutantArray.findIndex((l) => l.startsWith("const refuseCrossOrigin = crossSiteGuard(")));

// (j) ⚠️ PROVE THE CRASH, not merely that a regex fires. The SHIPPED guard block
//     (already lifted above as BLOCK) is executed with a mount placed before it
//     and after it. Before → the exact ReferenceError the server.js comment
//     quotes. After → clean. So the premise of this whole section is executable,
//     and it demonstrates the outage without booting anything or touching a port.
function bootProbe(body) {
	try {
		new Function("app", "DRIVER_MOBILE_ORIGINS", "requireRole", body)(
			{ get() {}, post() {}, put() {}, delete() {}, patch() {}, use() {} },
			ALLOWLIST,
			() => (req, res, next) => next()
		);
		return null;
	} catch (e) { return e; }
}
const bootAbove = bootProbe(MUT_MOUNT + "\n" + BLOCK);
const bootBelow = bootProbe(BLOCK + "\n" + MUT_MOUNT);
ok("MUTANT j: mounting ABOVE the shipped block throws at evaluation time", bootAbove instanceof ReferenceError);
ok("MUTANT j: and the message is the documented boot error",
	/Cannot access 'refuseCrossOrigin' before initialization/.test(String(bootAbove && bootAbove.message)));
ok("MUTANT j: mounting BELOW the same block does not throw", bootBelow === null);

if (failures.length) {
	console.error("FAILED " + failures.length + " of " + (passed + failures.length) + ":");
	for (const f of failures) console.error("  - " + f);
	process.exit(1);
}
console.log("csrf guard: " + passed + " assertions passed");
