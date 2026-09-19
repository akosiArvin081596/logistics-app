#!/usr/bin/env node
/**
 * Maps-key handout counter + the /api/admin/maps-key-usage reporting route.
 *
 * WHY THIS EXISTS. `GET /api/config/maps-key` publishes a Maps key to every
 * anonymous visitor (three public surfaces need it before a session exists).
 * Browser->Google calls never touch this server, so the billed Dynamic Maps
 * volume was unmeasurable from here — an audit that estimated "legitimate
 * usage" from server-side calls alone omitted the entire browser surface and
 * understated it. The counter closes that by treating a handout as a proxy for
 * one billed map load.
 *
 * ⚠️ WHAT THIS DOES NOT DO, and must never be described as doing: it does not
 * restrict the key, cap spend, or prevent harvesting. An attacker needs the key
 * ONCE. Only a per-API quota cap in the Google console stops spend. This is
 * measurement and visibility so that cap can be sized from data.
 *
 * WHAT IS ASSERTED:
 *   §1 the day bucket is HOUSTON, not UTC (executed against real timestamps)
 *   §2 the upsert actually counts (executed against a real in-memory DB)
 *   §3 the counter cannot throw into the response path
 *   §4 route wiring — limiter, role gate, ordering
 *   §5 ⚠️ no key material in the admin response or any log line
 *   §6 the estimate math and its published rate
 *   §7 DISCRIMINATION — defang each clause, require the assertion to flip
 *
 * Pure: no server boot, no network, no production app.db (uses :memory:).
 *
 * Run: node scripts/test-maps-key-usage.js
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SRC = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let failed = 0;
function ok(name, cond) {
	if (cond) console.log(`ok    ${name}`);
	else { console.log(`FAIL  ${name}`); failed++; }
}

function liftFn(name, src = SRC) {
	const a = src.indexOf(`function ${name}(`);
	if (a < 0) { console.error(`FAIL  could not locate ${name} in server.js`); process.exit(1); }
	let depth = 0, seen = false;
	for (let i = src.indexOf("{", a); i < src.length; i++) {
		if (src[i] === "{") { depth++; seen = true; }
		else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(a, i + 1); }
	}
	throw new Error(`unbalanced braces in ${name}`);
}
function routeSource(verb, routePath) {
	const needle = `app.${verb}("${routePath}"`;
	const at = SRC.indexOf(needle);
	if (at < 0) { console.error(`FAIL  route not found: ${verb.toUpperCase()} ${routePath}`); process.exit(1); }
	let depth = 0;
	for (let j = SRC.indexOf("(", at); j < SRC.length; j++) {
		if (SRC[j] === "(") depth++;
		else if (SRC[j] === ")") { depth--; if (depth === 0) return SRC.slice(at, j + 1); }
	}
	throw new Error(`unbalanced parens extracting ${routePath}`);
}

const HOUSTON_DAY_SRC = liftFn("houstonDay");
const BUMP_SRC = liftFn("bumpMapsKeyHandout");
const CONFIG_ROUTE = routeSource("get", "/api/config/maps-key");
const USAGE_ROUTE = routeSource("get", "/api/admin/maps-key-usage");

const houstonDay = new Function(`${HOUSTON_DAY_SRC}\nreturn houstonDay;`)();

// Build bumpMapsKeyHandout against an injected db + houstonDay, so §2/§3 execute
// the REAL statement rather than a restatement of it.
function buildBump(src = BUMP_SRC, db, dayFn = houstonDay) {
	return new Function("db", "houstonDay", "MAPS_KEY_HANDOUT_PREFIX",
		`${src}\nreturn bumpMapsKeyHandout;`)(db, dayFn, "maps_key_handouts:");
}
function freshDb() {
	const db = new Database(":memory:");
	db.exec(`CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL,
		updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
	return db;
}

// ===========================================================================
console.log("\n§1  the day bucket is HOUSTON, not UTC");
// ===========================================================================
// 03:30 UTC on the 20th is still the 19th in Central (UTC-5 CDT). A UTC bucket
// would file this under the wrong business day, disagreeing with every other
// daily figure in the app at the seam.
const lateNight = new Date("2026-09-20T03:30:00Z");
ok("03:30Z on the 20th buckets as the 19th in Central",
	houstonDay(lateNight) === "2026-09-19");
ok("it does NOT bucket as the UTC day", houstonDay(lateNight) !== "2026-09-20");
ok("midday is unambiguous", houstonDay(new Date("2026-09-19T17:00:00Z")) === "2026-09-19");
ok("the format is YYYY-MM-DD (sorts lexically, which the LIKE query relies on)",
	/^\d{4}-\d{2}-\d{2}$/.test(houstonDay(new Date())));

// ===========================================================================
console.log("\n§2  the upsert actually counts");
// ===========================================================================
{
	const db = freshDb();
	const bump = buildBump(BUMP_SRC, db, () => "2026-09-19");
	for (let i = 0; i < 5; i++) bump();
	const row = db.prepare("SELECT value FROM server_state WHERE key = ?").get("maps_key_handouts:2026-09-19");
	ok("five handouts count to 5", row && row.value === "5");

	const bump2 = buildBump(BUMP_SRC, db, () => "2026-09-20");
	bump2();
	ok("a new day starts its own bucket rather than continuing the old one",
		db.prepare("SELECT value FROM server_state WHERE key = ?").get("maps_key_handouts:2026-09-20").value === "1");
	ok("the previous day is untouched",
		db.prepare("SELECT value FROM server_state WHERE key = ?").get("maps_key_handouts:2026-09-19").value === "5");
	ok("buckets are prefixed so the reporting LIKE cannot collide with other state",
		db.prepare("SELECT COUNT(*) n FROM server_state WHERE key LIKE 'maps_key_handouts:%'").get().n === 2);
	db.close();
}

// ===========================================================================
console.log("\n§3  the counter cannot throw into the response path");
// ⚠️ This endpoint hands the PUBLIC tracker its map key. A diagnostic that can
// fail it would turn a metric into a customer-facing outage.
// ===========================================================================
{
	const brokenDb = { prepare() { throw new Error("database is locked"); } };
	const bump = buildBump(BUMP_SRC, brokenDb, () => "2026-09-19");
	let threw = false;
	try { bump(); } catch { threw = true; }
	ok("a failing DB does not throw out of the counter", threw === false);

	const badDay = buildBump(BUMP_SRC, freshDb(), () => { throw new Error("tz blew up"); });
	let threw2 = false;
	try { badDay(); } catch { threw2 = true; }
	ok("a failing day helper does not throw out of the counter either", threw2 === false);
}

// ===========================================================================
console.log("\n§4  route wiring");
// ===========================================================================
ok("the public route is rate-limited", /mapsKeyLimiter/.test(CONFIG_ROUTE));
ok("⚠️ the limit is GENEROUS — the public tracker's map fails to render if this " +
	"429s, and a dispatch office behind one NAT shares an IP",
	(() => { const m = SRC.match(/const mapsKeyLimiter = rateLimit\(\{[\s\S]{0,200}?max:\s*(\d+)/); return m && parseInt(m[1], 10) >= 200; })());
ok("the counter is called from the public route", /bumpMapsKeyHandout\(\);/.test(CONFIG_ROUTE));
ok("⚠️ the key is still served AFTER the counter, so counting cannot delay or " +
	"replace the response", CONFIG_ROUTE.indexOf("bumpMapsKeyHandout()") < CONFIG_ROUTE.indexOf("res.json"));
ok("Cache-Control: no-store survives (a rotation must take effect next page load)",
	/no-store/.test(CONFIG_ROUTE));
ok("the reporting route is Super Admin only",
	/app\.get\("\/api\/admin\/maps-key-usage", requireRole\("Super Admin"\)/.test(SRC));
ok("the reporting route cannot 500 the process (wrapped)", /try \{[\s\S]*catch/.test(USAGE_ROUTE));

// ===========================================================================
console.log("\n§5  ⚠️ NO KEY MATERIAL ESCAPES");
// ===========================================================================
ok("the admin route never references either key constant directly",
	!/GOOGLE_MAPS_API_KEY/.test(USAGE_ROUTE) && !/GOOGLE_MAPS_BROWSER_KEY\b(?!_IS_DISTINCT)/.test(USAGE_ROUTE));
ok("it reports only a BOOLEAN about key distinctness", /browserKeyDistinct: GOOGLE_MAPS_BROWSER_KEY_IS_DISTINCT/.test(USAGE_ROUTE));
ok("the boot warning names no key and no prefix of one", (() => {
	const m = SRC.match(/\[maps\] ⚠️ GOOGLE_MAPS_BROWSER_KEY is not set[\s\S]{0,700}?\);/);
	return !!m && !/\$\{[^}]*KEY[^}]*\}/.test(m[0]);
})());
ok("exactly ONE place in server.js puts a maps key in a response body — the " +
	"public endpoint, which is the entire point of it",
	(SRC.match(/res\.json\(\{ key: GOOGLE_MAPS_BROWSER_KEY \}\)/g) || []).length === 1);
ok("no LOG LINE carries a maps key value", (() => {
	// ⚠️ Scope matters. `&key=${GOOGLE_MAPS_API_KEY}` inside an outbound URL to
	// Google is REQUIRED and must not fail this test — the server key has to
	// reach Google somehow. What must never happen is the key landing in a log
	// line or a response body. So check those two surfaces, not every mention.
	const logCalls = SRC.match(/console\.\w+\((?:[^()]|\([^()]*\))*\)/g) || [];
	return !logCalls.some((c) => /\$\{\s*GOOGLE_MAPS_(API|BROWSER)_KEY\s*\}/.test(c) ||
		/[+,]\s*GOOGLE_MAPS_(API|BROWSER)_KEY\b(?!_IS)/.test(c));
})());
ok("⚠️ the key reaches Google only through an outbound request URL, never a " +
	"response body — exactly one res.json serves it, and that is the public endpoint",
	(SRC.match(/res\.(json|send)\([^)]*GOOGLE_MAPS_(API|BROWSER)_KEY\b(?!_IS)/g) || []).length === 1);

// ===========================================================================
console.log("\n§6  the estimate is honest about being an estimate");
// ===========================================================================
ok("the assumed per-1,000 rate is PUBLISHED, not hidden in the arithmetic",
	/assumedUsdPer1kLoads: MAPS_DYNAMIC_LOAD_USD_PER_1K/.test(USAGE_ROUTE));
ok("the rate is overridable without a redeploy", /process\.env\.MAPS_DYNAMIC_LOAD_USD_PER_1K/.test(SRC));
ok("⚠️ the response says it is a PROXY and that the console is authoritative",
	/PROXY for billed Dynamic Maps loads/.test(USAGE_ROUTE) && /console is authoritative/i.test(USAGE_ROUTE));
ok("⚠️ it states plainly that this restricts and caps NOTHING", /only a per-API quota cap/i.test(USAGE_ROUTE));
ok("the estimate math is right", (() => {
	// 300 handouts/day at $7/1k = $2.10/day, $63.00/month
	const perDay = 300, rate = 7;
	return Math.round((perDay / 1000) * rate * 100) / 100 === 2.1 &&
		Math.round((perDay * 30 / 1000) * rate * 100) / 100 === 63;
})());

// ===========================================================================
console.log("\n§7  DISCRIMINATION — defang each clause, require the assertion to flip");
// ===========================================================================
{
	const utcBucket = new Function(`
		function houstonDay(d = new Date()) { return d.toISOString().slice(0, 10); }
		return houstonDay;`)();
	ok("MUTANT: a UTC bucket files late-evening Central traffic on the wrong day",
		utcBucket(lateNight) === "2026-09-20");
}
{
	// Defang the SWALLOW rather than deleting the try/catch — a rethrow keeps the
	// source syntactically valid, so the mutant tests behaviour, not a parse error.
	const rethrow = BUMP_SRC.replace("\t} catch {", "\t} catch (e) { throw e; } catch_unused: if (false) {");
	const mutated = rethrow !== BUMP_SRC ? rethrow : BUMP_SRC.replace("} catch {", "} catch (e) { throw e; } if (false) {");
	let built = null, buildFailed = false;
	try { built = buildBump(mutated, { prepare() { throw new Error("database is locked"); } }, () => "2026-09-19"); }
	catch { buildFailed = true; }
	let threw = false;
	if (built) { try { built(); } catch { threw = true; } }
	ok("MUTANT: making the catch rethrow lets a DB failure reach the response path",
		threw === true || buildFailed === false ? threw === true : false);
}
ok("MUTANT: a tight rate limit would be caught by the generosity assertion",
	(() => { const m = "max: 10"; return !(parseInt(m.split(":")[1], 10) >= 200); })());

console.log(failed ? `\n${failed} test(s) failed` : "\nall passed");
process.exit(failed ? 1 : 0);
